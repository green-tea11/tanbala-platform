import json
from pathlib import Path

import httpx
import pytest

from tanbala_leads import db, pipeline
from tanbala_leads.settings import SettingsError, load_settings
from tanbala_leads.steps import verify

FIXTURES = Path(__file__).parent / "fixtures"


def reacher_transport(payload: dict, seen: list):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=payload)

    return httpx.MockTransport(handler)


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_check_email_sends_secret_and_parses_safe():
    seen = []
    client = httpx.Client(transport=reacher_transport(load("reacher-safe.json"), seen))

    result = verify.check_email("info@pel.kz", base_url="http://127.0.0.1:8080", secret="s3", client=client)

    assert result.result == "safe"
    assert result.is_catch_all is False
    assert result.is_role is True
    assert seen[0].url.path == "/v1/check_email"
    assert seen[0].headers["x-reacher-secret"] == "s3"
    assert json.loads(seen[0].content) == {"to_email": "info@pel.kz"}


def test_smtp_error_gives_unknown_with_reason():
    client = httpx.Client(transport=reacher_transport(load("reacher-smtp-error.json"), []))

    result = verify.check_email("info@pel.kz", base_url="http://r", secret="s", client=client)

    assert result.result == "unknown"
    assert result.is_catch_all is None
    assert "5.1.7" in result.note


def test_reacher_down_gives_unknown_not_crash():
    def handler(request):
        raise httpx.ConnectError("refused")

    client = httpx.Client(transport=httpx.MockTransport(handler))

    result = verify.check_email("info@pel.kz", base_url="http://r", secret="s", client=client)

    assert result.result == "unknown"
    assert "Reacher" in result.note


@pytest.mark.db
def test_verify_company_updates_contacts_and_counts_usable(db_conn):
    db.migrate(db_conn)
    company_id = db_conn.execute("INSERT INTO companies (name) VALUES ('ТОО') RETURNING id").fetchone()[0]
    for email in ("info@pel.kz", "old@pel.kz"):
        db_conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, %s)", (company_id, email))
    answers = {"info@pel.kz": "safe", "old@pel.kz": "invalid"}

    def fake_check(email):
        return verify.EmailCheck(email=email, result=answers[email], is_catch_all=False, is_role=False,
                                 note=None, raw={"is_reachable": answers[email]})

    usable = verify.verify_company(db_conn, company_id, fake_check)

    rows = dict(db_conn.execute("SELECT email, verify_result FROM contacts").fetchall())
    assert usable == 1
    assert rows == {"info@pel.kz": "safe", "old@pel.kz": "invalid"}


def test_bad_reacher_url_is_a_failure_not_a_crash():
    result = verify.check_email("info@pel.kz", base_url="http://", secret="s")

    assert result.failed


@pytest.mark.db
def test_reacher_failure_leaves_address_for_next_time(db_conn):
    db.migrate(db_conn)
    company_id = db_conn.execute("INSERT INTO companies (name) VALUES ('ТОО') RETURNING id").fetchone()[0]
    db_conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@pel.kz')", (company_id,))

    def reacher_down(email):
        return verify.EmailCheck(email=email, result="unknown", is_catch_all=None, is_role=False,
                                 note="Reacher недоступен", raw={}, failed=True)

    with pytest.raises(verify.ReacherUnavailable):
        verify.verify_company(db_conn, company_id, reacher_down)

    assert db_conn.execute("SELECT verify_result FROM contacts").fetchone()[0] is None


# ---------- не больше REACHER_MAX_PER_MINUTE проверок в минуту ----------


class FakeTime:
    """Часы и сон без настоящего ожидания: sleep двигает часы."""

    def __init__(self):
        self.now = 0.0
        self.slept: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.slept.append(round(seconds, 3))
        self.now += seconds


def test_limiter_waits_when_the_minute_is_full():
    # Первый запуск на сервере 30.10.2026: 10 проверок за 21 с, одиннадцатую Reacher отклонил (лимит в минуту).
    fake = FakeTime()
    limiter = verify.RateLimiter(10, window=61.0, clock=fake.clock, sleep=fake.sleep)

    for _ in range(10):
        limiter.wait()
        fake.now += 2.0
    assert fake.slept == []

    limiter.wait()  # одиннадцатая: ждёт, пока первой проверке исполнится 61 с
    assert fake.slept == [41.0] and fake.now == 61.0
    limiter.wait()  # двенадцатая: вторая проверка была в 2 с
    assert fake.slept == [41.0, 2.0]


def test_limiter_does_not_wait_when_checks_are_rare():
    fake = FakeTime()
    limiter = verify.RateLimiter(2, window=61.0, clock=fake.clock, sleep=fake.sleep)

    for _ in range(5):
        limiter.wait()
        fake.now += 31.0

    assert fake.slept == []


def test_limiter_refuses_zero():
    with pytest.raises(ValueError):
        verify.RateLimiter(0)


def make_settings(per_minute: str | None) -> object:
    env = {"VENMART_ANTHROPIC_KEY": "sk-ant-test", "REACHER_SECRET": "test"}
    if per_minute is not None:
        env["REACHER_MAX_PER_MINUTE"] = per_minute
    return load_settings(env)


def test_reacher_limit_comes_from_settings_with_default_ten():
    assert pipeline.reacher_per_minute(make_settings(None)) == 10
    assert pipeline.reacher_per_minute(make_settings("6")) == 6


@pytest.mark.parametrize("value", ["0", "-1", "десять", "1.5"])
def test_bad_reacher_limit_is_a_clear_settings_error(value):
    with pytest.raises(SettingsError, match="REACHER_MAX_PER_MINUTE"):
        pipeline.reacher_per_minute(make_settings(value))


def test_real_deps_check_email_waits_for_the_limiter(monkeypatch):
    order = []

    class SpyLimiter:
        def __init__(self, limit):
            order.append(("limit", limit))

        def wait(self):
            order.append("wait")

    def fake_check(email, *, base_url, secret):
        order.append(("check", email, secret))
        return "checked"

    monkeypatch.setattr(verify, "RateLimiter", SpyLimiter)
    monkeypatch.setattr(verify, "check_email", fake_check)

    deps = pipeline.default_deps(make_settings("7"))

    assert deps.check_email("info@pel.kz") == "checked"
    assert order == [("limit", 7), "wait", ("check", "info@pel.kz", "test")]
