import json
from pathlib import Path

import httpx
import pytest

from tanbala_leads import db
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
