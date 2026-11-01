import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg.conninfo import make_conninfo

from tanbala_leads import db, pipeline
from tanbala_leads.settings import load_settings
from tanbala_leads.sites import PageText, SiteCrawl
from tanbala_leads.steps import collect, verify

pytestmark = pytest.mark.db

FIXTURE = Path(__file__).parent / "fixtures" / "2gis-almaty-sklad.json"
SETTINGS = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+77479597238"})
QUALIFY = {"fit": "yes", "score": 75, "segment": "Склад, логистика, дистрибуция", "reason": "Склад и филиалы."}
DRAFT_BODY = (
    "Здравствуйте!\n\nМеня зовут Арман, я из Tanbala. Мы ставим учёт вещей на RFID-метках под ключ.\n\n"
    "На каждую коробку клеится метка. Ридер видит сотни меток за секунду, и всё попадает в 1С. "
    "Пересчёт идёт обходом со сканером.\n\nВсё делаем сами: оборудование, тесты, связь с 1С и обучение.\n\n"
    "Если пересчёт у вас занимает много времени, напишите нам в WhatsApp: +77479597238. Расскажите о задаче."
)


class FakeClient:
    """Отвечает как Claude: квалификация или письмо, в зависимости от схемы запроса."""

    def __init__(self):
        self.calls = []
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        self.calls.append(kwargs)
        schema = kwargs["output_config"]["format"]["schema"]
        answer = QUALIFY if "fit" in schema["properties"] else {"subject": "Учёт склада", "body": DRAFT_BODY,
                                                                "notes": []}
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=9000,
                                cache_creation_input_tokens=0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(answer, ensure_ascii=False))],
                               stop_reason="end_turn", usage=usage, model="claude-haiku-5-5")


def fake_site(url: str) -> SiteCrawl:
    domain = url.split("//")[-1].split("/")[0].removeprefix("www.")
    return SiteCrawl(start_url=url, pages=(PageText(url=url, text="Складское хранение и логистика."),),
                     emails=frozenset({f"sales@{domain}"}), error=None)


def site_with_broken_aksenger(url: str):
    if "aksenger" in url:
        raise TimeoutError("сайт не ответил")
    return fake_site(url)


def fake_check(email: str):
    return verify.EmailCheck(email=email, result="unknown", is_catch_all=None, is_role=False, note=None, raw={})


@pytest.fixture(autouse=True)
def migrated(db_conn):
    db.migrate(db_conn)


@pytest.fixture
def dsn(db_conn):
    schema = db_conn.execute("SELECT current_schema()").fetchone()[0]
    base = os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"]
    return make_conninfo(base, options=f"-c search_path={schema}")


def make_deps(tmp_path, client=None, run_parser=None, crawl=fake_site):
    def copy_fixture(url, out, max_records):
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURE, out)
        return out

    return pipeline.Deps(run_parser=run_parser or copy_fixture, crawl=crawl, check_email=fake_check,
                         client=client or FakeClient(), owner_doc="Документ о Tanbala", settings=SETTINGS,
                         exports_dir=tmp_path / "2gis", log_path=tmp_path / "llm.jsonl")


def test_full_run_finds_qualifies_and_drafts(db_conn, dsn, tmp_path):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)
    client = FakeClient()

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, client))

    run = db_conn.execute("SELECT status, found, new_companies, crawled, qualified, verified, drafted, errors"
                          " FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert run == ("done", 4, 3, 3, 3, 3, 3, 0)
    assert db_conn.execute("SELECT count(*) FROM drafts").fetchone()[0] == 3
    assert db_conn.execute("SELECT count(*) FROM llm_calls WHERE run_id = %s", (run_id,)).fetchone()[0] == 6
    assert len((tmp_path / "llm.jsonl").read_text(encoding="utf-8").splitlines()) == 6
    assert all(call["system"][0]["text"] == "Документ о Tanbala" for call in client.calls)


def test_one_broken_site_does_not_stop_the_run(db_conn, dsn, tmp_path):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 4)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, crawl=site_with_broken_aksenger))

    status, errors, drafted = db_conn.execute("SELECT status, errors, drafted FROM runs WHERE id = %s",
                                              (run_id,)).fetchone()
    # Сайт Аксенгера не открылся, но почта из 2ГИС есть: письмо всё равно написано по карточке.
    assert (status, errors, drafted) == ("done", 1, 4)
    assert db_conn.execute("SELECT site_text FROM companies WHERE name LIKE 'Аксенгер%%'").fetchone()[0] is None


def test_hung_site_browser_stops_run_and_leaves_companies_for_next_run(db_conn, dsn, tmp_path):
    """Браузер для сайтов занят зависшим шагом: запуск останавливается, а не считает компании «без сайта»."""
    from tanbala_leads.browsers import BrowserBusy

    def busy_browser(url):
        raise BrowserBusy("Браузер для сайтов занят дольше 5 мин")

    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, crawl=busy_browser))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "Браузер для сайтов занят" in error
    statuses = {s for (s,) in db_conn.execute("SELECT status FROM companies WHERE run_id = %s", (run_id,))}
    assert statuses == {"new"}
    assert pipeline._unfinished(db_conn, (), 10) != ()


def test_parser_failure_fails_the_run_with_message(db_conn, dsn, tmp_path):
    def broken_parser(url, out, max_records):
        raise collect.ParserError("Chrome не запустился")

    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=broken_parser))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "Chrome не запустился" in error


def test_second_run_while_first_is_active_is_refused(db_conn):
    pipeline.create_run(db_conn, "almaty", "склад", 3)

    with pytest.raises(pipeline.RunAlreadyActive):
        pipeline.create_run(db_conn, "almaty", "логистика", 3)


@pytest.mark.parametrize(("city", "query", "limit"), [("moscow", "склад", 3), ("almaty", " ", 3),
                                                       ("almaty", "склад", 0), ("almaty", "склад", 21)])
def test_bad_run_parameters_are_refused(db_conn, city, query, limit):
    with pytest.raises(ValueError):
        pipeline.create_run(db_conn, city, query, limit)


def test_stale_runs_are_marked_failed(db_conn):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)

    assert pipeline.recover_stale_runs(db_conn) == 1
    assert db_conn.execute("SELECT status FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "failed"


@pytest.mark.parametrize(
    "secret",
    ["sk-ant-api03-AbCdEf1234567890_xyz", "postgresql://tanbala:p4ss@127.0.0.1:5432/tanbala"],
)
def test_error_text_hides_secrets(secret):
    text = pipeline.safe_error(RuntimeError(f"не вышло: {secret} конец"))

    assert secret not in text
    assert "[скрыто]" in text and "не вышло" in text


def add_spent(conn, input_tokens):
    conn.execute("INSERT INTO llm_calls (task, model, input_tokens, output_tokens) VALUES ('qualify', 'claude-haiku-5-5', %s, 0)",
                 (input_tokens,))


def test_daily_budget_blocks_new_run(db_conn):
    add_spent(db_conn, 20_000_000)  # 20 млн входных токенов Haiku = $2

    with pytest.raises(pipeline.BudgetExceeded, match="лимит"):
        pipeline.create_run(db_conn, "almaty", "склад", 3, daily_budget_usd=1.0)


def test_spending_under_budget_allows_run(db_conn):
    add_spent(db_conn, 1_000_000)  # $0.10

    assert pipeline.create_run(db_conn, "almaty", "склад", 3, daily_budget_usd=1.0)


def test_company_without_any_email_is_not_sent_to_claude(db_conn, dsn, tmp_path):
    def parser_without_asklad_emails(url, out, max_records):
        items = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        for item in items:
            if item["name"].startswith("Asklad"):
                for group in item["contact_groups"]:
                    group["contacts"] = [c for c in group["contacts"] if c["type"] != "email"]
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
        return out

    def site_without_emails(url):
        return SiteCrawl(start_url=url, pages=(PageText(url=url, text="Склад."),), emails=frozenset(), error=None)

    client = FakeClient()
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 4)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, client, run_parser=parser_without_asklad_emails,
                                                crawl=site_without_emails))

    qualify_calls = sum("fit" in call["output_config"]["format"]["schema"]["properties"] for call in client.calls)
    status, error = db_conn.execute("SELECT status, last_error FROM companies WHERE name LIKE 'Asklad%%'").fetchone()
    assert qualify_calls == 3
    assert status == "rejected" and "почта" in error.lower()
    # «Без почты» в запуске отдельно от «не подходят» и не ошибка (ревью 01.11.2026).
    assert db_conn.execute("SELECT rejected, no_email, errors FROM runs WHERE id = %s",
                           (run_id,)).fetchone() == (0, 1, 0)


def test_usage_log_failure_does_not_lose_paid_answer(db_conn, dsn, tmp_path):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 1)
    deps = make_deps(tmp_path)
    deps = pipeline.Deps(**{**deps.__dict__, "log_path": tmp_path})  # каталог вместо файла: запись в лог упадёт

    pipeline.execute_run(dsn, run_id, deps)

    assert db_conn.execute("SELECT drafted, errors FROM runs WHERE id = %s", (run_id,)).fetchone() == (1, 0)


def test_auth_error_stops_the_run(db_conn, dsn, tmp_path):
    import anthropic
    import httpx

    class BrokenKeyClient(FakeClient):
        def create(self, **kwargs):
            self.calls.append(kwargs)
            request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
            raise anthropic.AuthenticationError("invalid x-api-key", response=httpx.Response(401, request=request),
                                                body=None)

    client = BrokenKeyClient()
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 4)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, client))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "AuthenticationError" in error
    assert len(client.calls) == 1


def test_unfinished_companies_are_finished_by_next_run(db_conn, dsn, tmp_path):
    import anthropic
    import httpx

    class OfflineClient(FakeClient):
        def create(self, **kwargs):
            raise anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages"))

    first = pipeline.create_run(db_conn, "almaty", "склад", 4)
    pipeline.execute_run(dsn, first, make_deps(tmp_path, OfflineClient()))
    assert {status for (status,) in db_conn.execute("SELECT status FROM companies")} == {"crawled"}

    second = pipeline.create_run(db_conn, "almaty", "склад", 4)
    pipeline.execute_run(dsn, second, make_deps(tmp_path))

    assert {status for (status,) in db_conn.execute("SELECT status FROM companies")} == {"drafted"}
    assert db_conn.execute("SELECT new_companies, drafted FROM runs WHERE id = %s", (second,)).fetchone() == (0, 4)



# Несколько отраслей через запятую

@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("склад", ["склад"]),
        ("склад, логистика,производство", ["склад", "логистика", "производство"]),
        ("  Склад ; склад\nмагазин одежды,, ", ["Склад", "магазин одежды"]),
    ],
)
def test_split_queries(text, expected):
    assert pipeline.split_queries(text) == expected


@pytest.mark.parametrize("text", ["", " , ;", ",".join(f"отрасль {i}" for i in range(11)), "x" * 61])
def test_bad_query_lists_are_refused(text):
    with pytest.raises(ValueError):
        pipeline.split_queries(text)


def test_run_stores_normalized_query_list(db_conn):
    run_id = pipeline.create_run(db_conn, "almaty", " склад;логистика ", 5)

    assert db_conn.execute("SELECT query FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "склад, логистика"


def test_total_company_limit_per_run(db_conn):
    with pytest.raises(ValueError, match="60"):
        pipeline.create_run(db_conn, "almaty", "а1, б2, в3, г4", 20)


def test_each_query_is_searched_and_companies_remember_it(db_conn, dsn, tmp_path):
    searched = []

    def parser_for(url, out, max_records):
        searched.append(url)
        out.parent.mkdir(parents=True, exist_ok=True)
        items = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
        half = items[:3] if len(searched) == 1 else items[3:]
        out.write_text(json.dumps(half, ensure_ascii=False), encoding="utf-8")
        return out

    run_id = pipeline.create_run(db_conn, "almaty", "склад, логистика", 2)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=parser_for))

    assert [url.rsplit("/", 1)[-1] for url in searched] == ["%D1%81%D0%BA%D0%BB%D0%B0%D0%B4",
                                                             "%D0%BB%D0%BE%D0%B3%D0%B8%D1%81%D1%82%D0%B8%D0%BA%D0%B0"]
    by_query = dict(db_conn.execute("SELECT search_query, count(*) FROM companies GROUP BY 1").fetchall())
    assert by_query == {"склад": 2, "логистика": 2}
    assert db_conn.execute("SELECT found, new_companies, drafted FROM runs WHERE id = %s", (run_id,)).fetchone() == (4, 4, 4)


# Ревью 01.11.2026: временный сбой сайта не отправляет компанию без почты в «Нет почты» навсегда

def parser_without_asklad_emails(url, out, max_records):
    items = json.loads(FIXTURE.read_text(encoding="utf-8-sig"))
    for item in items:
        if item["name"].startswith("Asklad"):
            for group in item["contact_groups"]:
                group["contacts"] = [c for c in group["contacts"] if c["type"] != "email"]
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    return out


def asklad(conn):
    return conn.execute("SELECT status, site_failures, last_error FROM companies WHERE name LIKE 'Asklad%%'").fetchone()


def run_once(conn, dsn, tmp_path, crawl):
    run_id = pipeline.create_run(conn, "almaty", "склад", 4)
    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=parser_without_asklad_emails, crawl=crawl))
    return conn.execute("SELECT status, errors, rejected, no_email FROM runs WHERE id = %s", (run_id,)).fetchone()


def asklad_times_out(url):
    if "kontainer" in url:
        return SiteCrawl(start_url=url, error="главная страница: время на сайт вышло", retryable=True)
    return fake_site(url)


def asklad_site_crashes(url):
    if "kontainer" in url:
        raise RuntimeError("Playwright: browser closed")
    return fake_site(url)


@pytest.mark.parametrize("crawl", [asklad_times_out, asklad_site_crashes], ids=["timeout", "crash"])
def test_temporary_site_failure_keeps_company_without_email_for_next_run(db_conn, dsn, tmp_path, crawl):
    assert run_once(db_conn, dsn, tmp_path, crawl) == ("done", 1, 0, 0)
    status, failures, error = asklad(db_conn)
    assert (status, failures) == ("new", 1) and "попытка 1 из 3" in error and "следующий запуск" in error

    assert run_once(db_conn, dsn, tmp_path, crawl) == ("done", 1, 0, 0)
    assert asklad(db_conn)[:2] == ("new", 2)

    # Третья попытка последняя: сайт так и не открылся, почты нет — «Нет почты», как раньше.
    third = run_once(db_conn, dsn, tmp_path, crawl)
    assert third[2:] == (0, 1)
    assert asklad(db_conn)[0] == "rejected"


def test_site_that_opens_on_next_run_gets_its_emails(db_conn, dsn, tmp_path):
    run_once(db_conn, dsn, tmp_path, asklad_times_out)

    assert run_once(db_conn, dsn, tmp_path, fake_site) == ("done", 0, 0, 0)

    status, _, error = asklad(db_conn)
    assert status == "drafted" and error is None
    assert db_conn.execute("SELECT email FROM contacts c JOIN companies co ON co.id = c.company_id"
                           " WHERE co.name LIKE 'Asklad%%'").fetchall() == [("sales@kontainer.kz",)]


def test_permanent_site_error_without_email_is_no_email_at_once(db_conn, dsn, tmp_path):
    def asklad_404(url):
        if "kontainer" in url:
            return SiteCrawl(start_url=url, error="главная страница: ответ HTTP 404", retryable=False)
        return fake_site(url)

    assert run_once(db_conn, dsn, tmp_path, asklad_404)[2:] == (0, 1)
    assert asklad(db_conn)[:2] == ("rejected", 0)


def test_site_failure_with_2gis_email_is_not_retried(db_conn, dsn, tmp_path):
    def aksenger_times_out(url):
        if "aksenger" in url:
            return SiteCrawl(start_url=url, error="главная страница: время на сайт вышло", retryable=True)
        return fake_site(url)

    run_id = pipeline.create_run(db_conn, "almaty", "склад", 4)
    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, crawl=aksenger_times_out))

    # Почта из 2ГИС есть: письмо по карточке, как раньше.
    assert db_conn.execute("SELECT status, site_failures FROM companies WHERE name LIKE 'Аксенгер%%'").fetchone() == (
        "drafted", 0)


# Ревью 01.11.2026: сбой 2ГИС по одной отрасли не останавливает остальные

LOGISTICS_URL_TAIL = "%D0%BB%D0%BE%D0%B3%D0%B8%D1%81%D1%82%D0%B8%D0%BA%D0%B0"  # «логистика» в ссылке 2ГИС


def test_failed_industry_is_recorded_and_others_continue(db_conn, dsn, tmp_path):
    def parser_failing_on_logistics(url, out, max_records):
        if url.endswith(LOGISTICS_URL_TAIL):
            raise collect.ParserError("parser-2gis не уложился в 1200 с")
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURE, out)
        return out

    run_id = pipeline.create_run(db_conn, "almaty", "логистика, склад", 2)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=parser_failing_on_logistics))

    status, error, new, drafted = db_conn.execute("SELECT status, error, new_companies, drafted FROM runs WHERE id = %s",
                                                  (run_id,)).fetchone()
    assert (status, new, drafted) == ("done", 2, 2)
    assert "«логистика»" in error and "не уложился" in error and "1 из 2" in error and "«склад»" not in error


def test_broken_export_of_one_industry_does_not_stop_the_run(db_conn, dsn, tmp_path):
    calls = []

    def parser_with_broken_first_export(url, out, max_records):
        calls.append(url)
        out.parent.mkdir(parents=True, exist_ok=True)
        if len(calls) == 1:
            out.write_text("[{", encoding="utf-8")
        else:
            shutil.copy(FIXTURE, out)
        return out

    run_id = pipeline.create_run(db_conn, "almaty", "склад, логистика", 2)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=parser_with_broken_first_export))

    status, error, new = db_conn.execute("SELECT status, error, new_companies FROM runs WHERE id = %s",
                                         (run_id,)).fetchone()
    assert (status, new) == ("done", 2) and "«склад»" in error and "JSONDecodeError" in error


def test_stuck_parser_stops_the_run_without_starting_the_next_industry(db_conn, dsn, tmp_path):
    calls = []

    def stuck_parser(url, out, max_records):
        calls.append(url)
        raise collect.ParserStuck("parser-2gis не уложился в 1200 с и не остановился")

    run_id = pipeline.create_run(db_conn, "almaty", "склад, логистика", 2)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=stuck_parser))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "не остановился" in error and len(calls) == 1


def test_run_fails_only_when_every_industry_failed(db_conn, dsn, tmp_path):
    def broken_parser(url, out, max_records):
        raise collect.ParserError("Chrome не запустился")

    run_id = pipeline.create_run(db_conn, "almaty", "склад, логистика", 2)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=broken_parser))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "«склад»" in error and "«логистика»" in error and "Chrome не запустился" in error
