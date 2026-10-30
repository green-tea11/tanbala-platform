"""API единой панели (/internal/console): токен первым, Host, браузер, тело, параметры, чтение. Без сети и Claude API.

Контракт: ../contract/CONSOLE_API.md, разделы 1 и 2. Действия — tests/test_console_actions.py, порты — tests/test_ports.py.
"""

import asyncio
import json
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from console_support import (
    AUTH,
    BOT_AUTH,
    BOT_TOKEN,
    CONSOLE_TOKEN,
    POST,
    PREFIX,
    TEST_TO,
    FakeStartRun,
    console_db,  # noqa: F401  фикстура
    full_company,
    get,
    make_app,
    make_client,
    ok,
    problem,
    seed_company,
    seed_contact,
    seed_draft,
    seed_llm_call,
    seed_qualification,
    seed_run,
)

from tanbala_leads import contact_policy, llm, pipeline
from tanbala_leads.settings import load_settings
from tanbala_leads.web import app as web
from tanbala_leads.web import internal

WEB_DIR = Path(web.__file__).resolve().parent
GET_PATHS = ["/summary", "/spend?from=2026-10-01&to=2026-10-30", "/companies", "/companies/1", "/companies/digest?ids=1",
             "/letters", "/letters/1", "/runs", "/runs/active", "/runs/1", "/search/options", "/history", "/blocked",
             "/research-jobs"]
POST_PATHS = ["/runs", "/drafts/1/approve", "/drafts/1/reject", "/drafts/1/edit", "/drafts/1/send-test",
              "/companies/1/block", "/companies/1/whatsapp-clear", "/history/import"]


# ---------- токен первым, без базы ----------


@pytest.mark.parametrize("headers", [{}, {"X-Console-Token": "wrong"}, {"X-Console-Token": ""},
                                     {"X-Console-Token": CONSOLE_TOKEN + "x"}, BOT_AUTH,
                                     {"X-Console-Token": BOT_TOKEN}, {"Authorization": f"Bearer {CONSOLE_TOKEN}"}])
@pytest.mark.parametrize(("method", "path"), [
    *[("GET", path) for path in GET_PATHS], *[("POST", path) for path in POST_PATHS],
    ("GET", "/nope"), ("GET", ""), ("GET", "/"), ("DELETE", "/summary"), ("PUT", "/runs"), ("GET", "/drafts/1/approve"),
    ("GET", "/companies/abc"), ("GET", "/spend?from=x"), ("POST", "/nope"),
])
def test_without_valid_token_everything_is_401(method, path, headers):
    """Токен проверяется первым: до пути, метода, параметров, тела, X-Console-User и базы."""
    client = make_client()

    response = client.request(method, PREFIX + path, headers={**headers, "X-Console-User": "Bad User!",
                                                              "Content-Type": "text/plain"}, content=b"[[[")

    assert problem(response, 401, "unauthorized")


@pytest.mark.parametrize("token", [None, "", "s" * 31, "s" * 513, "s" * 20 + " " + "s" * 20, "ж" * 40,
                                   "s" * 39 + "\x7f"])
def test_empty_or_malformed_token_setting_disables_api(token):
    client = make_client(token=token)

    response = client.get(PREFIX + "/search/options", headers={"X-Console-Token": (token or "").encode()})

    assert problem(response, 401, "unauthorized")


@pytest.mark.parametrize("token", ["s" * 32, "~" * 512, "Ab3!#$%&'()*+,-./:;<=>?@[]^_`{|}" * 2])
def test_any_visible_ascii_token_from_32_to_512_works(token):
    response = make_client(token=token).get(PREFIX + "/search/options", headers={"X-Console-Token": token})

    assert response.status_code == 200


def test_bot_token_never_opens_console_and_console_token_never_opens_bot_api():
    client = make_client()

    assert problem(client.get(PREFIX + "/search/options", headers=BOT_AUTH), 401, "unauthorized")
    assert problem(client.get(PREFIX + "/search/options", headers={"X-Console-Token": BOT_TOKEN}), 401,
                   "unauthorized")
    for headers in (AUTH, {"X-Internal-Token": CONSOLE_TOKEN}):
        for path in ("/internal/lookup?domain=sklad.kz", "/internal/nope", "/internal/companies/1/brief"):
            response = client.get(path, headers=headers)
            assert (response.status_code, response.json()) == (401, {"error": "unauthorized"})


def test_same_token_for_bot_and_console_is_refused_without_showing_it():
    with pytest.raises(ValueError, match="LEADS_CONSOLE_TOKEN совпадает с INTERNAL_API_TOKEN") as error:
        make_app(token=CONSOLE_TOKEN, internal_token=CONSOLE_TOKEN)

    assert CONSOLE_TOKEN not in str(error.value)


def test_serve_refuses_same_tokens_before_sockets_and_database(monkeypatch):
    monkeypatch.setattr(web, "load_settings", lambda: load_settings({
        "DATABASE_URL": "postgresql://test", "INTERNAL_API_TOKEN": BOT_TOKEN, "LEADS_CONSOLE_TOKEN": BOT_TOKEN}))
    monkeypatch.setattr(web, "bind_sockets", lambda *args: pytest.fail("порты занимать не должно"))
    monkeypatch.setattr(web.db, "connect", lambda dsn: pytest.fail("до базы дойти не должно"))

    with pytest.raises(ValueError, match="разные токены") as error:
        web.serve(ui_port=8001)

    assert BOT_TOKEN not in str(error.value)


def test_console_token_is_hidden_from_settings_repr():
    settings = load_settings({"LEADS_CONSOLE_TOKEN": "console-secret-" + "x" * 30})

    assert settings.leads_console_token.startswith("console-secret-")
    assert "console-secret" not in repr(settings)


@pytest.mark.parametrize(("method", "path", "status", "code"), [
    ("GET", "/nope", 404, "not_found"), ("GET", "", 404, "not_found"), ("GET", "/companies/abc", 404, "not_found"),
    ("GET", "/drafts/1/approve", 400, "bad_request"), ("DELETE", "/summary", 400, "bad_request"),
    ("PUT", "/runs", 400, "bad_request"), ("GET", "/summary/", 404, "not_found"),
])
def test_unknown_path_or_method_after_token_is_json(method, path, status, code):
    response = make_client().request(method, PREFIX + path, headers=AUTH)

    assert problem(response, status, code)
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("header", [{"Origin": "http://127.0.0.1:8000"}, {"Origin": "null"},
                                    {"Sec-Fetch-Site": "same-origin"}, {"Sec-Fetch-Site": "none"}])
def test_browser_requests_are_forbidden_after_token(header):
    client = make_client()

    assert problem(client.get(PREFIX + "/search/options", headers=header), 401, "unauthorized")
    assert problem(client.get(PREFIX + "/search/options", headers={**AUTH, **header}), 403, "forbidden")
    assert problem(client.post(PREFIX + "/drafts/1/approve", headers={**POST, **header}, json={}), 403, "forbidden")
    assert problem(client.get(PREFIX + "/nope", headers={**AUTH, **header}), 403, "forbidden")


def test_node_fetch_header_sec_fetch_mode_is_allowed():
    """fetch из Node шлёт Sec-Fetch-Mode: cors, но не Origin и не Sec-Fetch-Site."""
    response = make_client().get(PREFIX + "/search/options", headers={**AUTH, "Sec-Fetch-Mode": "cors"})

    assert response.status_code == 200


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8000", "leads.tanbala.kz", "127.0.0.1.evil.example",
                                  "", "[::1]:8000"])
def test_foreign_host_is_400_before_token(host):
    response = make_client(public_host="leads.tanbala.kz").get(PREFIX + "/summary", headers={**AUTH, "Host": host})

    assert problem(response, 400, "bad_request")


@pytest.mark.parametrize("header", ["X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded", "Via"])
def test_proxied_request_is_400(header):
    response = make_client().get(PREFIX + "/summary", headers={**AUTH, "Host": "127.0.0.1:8000", header: "1.2.3.4"})

    assert problem(response, 400, "bad_request")


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "127.0.0.1", "LOCALHOST:8000"])
def test_local_host_with_port_reaches_api(host):
    assert make_client().get(PREFIX + "/search/options", headers={**AUTH, "Host": host}).status_code == 200


@pytest.mark.parametrize("user", [None, "", "Ivan", "иван", "ivan petrov", "a" * 33, "ivan;drop", "ivan/../x"])
@pytest.mark.parametrize("path", POST_PATHS)
def test_post_needs_console_user_before_body_and_database(path, user):
    headers = {**AUTH} if user is None else {**AUTH, "X-Console-User": user.encode()}

    response = make_client().post(PREFIX + path, headers=headers, content=b"not json")

    assert "X-Console-User" in problem(response, 400, "bad_request")


@pytest.mark.parametrize("user", ["a", "ivan.petrov", "x_1-2", "a" * 32])
def test_valid_console_user_passes(user):
    start_run = FakeStartRun(result=5)
    response = make_client(start_run=start_run).post(PREFIX + "/runs", headers={**AUTH, "X-Console-User": user},
                                                     json={"query": "склад", "city": "almaty", "count": 5})

    assert (response.status_code, response.json()) == (202, {"runId": 5})


@pytest.mark.parametrize(("content_type", "body"), [
    (None, b"{}"), ("text/plain", b"{}"), ("application/x-www-form-urlencoded", b"a=1"), ("multipart/form-data", b""),
    ("application/json", b""), ("application/json", b"not json"), ("application/json", b"[]"),
    ("application/json", b"\"text\""), ("application/json", b"\xff\xfe"), ("application/json", b"[" * 5000),
])
@pytest.mark.parametrize("path", POST_PATHS)
def test_body_must_be_json_object(path, content_type, body):
    headers = {**POST, **({"Content-Type": content_type} if content_type else {})}

    response = make_client().post(PREFIX + path, headers=headers, content=body)

    assert problem(response, 400, "bad_request")


@pytest.mark.parametrize("path", [p for p in POST_PATHS if p not in ("/history/import", "/drafts/1/edit")])
def test_body_over_16_kb_is_413_before_database(path):
    client = make_client()
    big = json.dumps({"subject": "x", "body": "я" * 9000}).encode()

    declared = client.post(PREFIX + path, headers={**POST, "Content-Type": "application/json"}, content=big)
    streamed = client.post(PREFIX + path, headers={**POST, "Content-Type": "application/json"},
                           content=iter([big[:8000], big[8000:]]))

    assert problem(declared, 413, "too_large")
    assert problem(streamed, 413, "too_large")


def test_edit_body_limit_fits_longest_letter_but_not_more():
    """Правка: тема 200 и текст 10 000 символов кириллицы (больше 16 КБ в UTF-8) проходят, больше 32 КБ — 413."""
    client = make_client()
    headers = {**POST, "Content-Type": "application/json"}
    longest = json.dumps({"subject": "я" * 200, "body": "я" * 10_000}, ensure_ascii=False).encode()
    too_big = json.dumps({"subject": "x", "body": "я" * 16_400}, ensure_ascii=False).encode()
    assert 16 * 1024 < len(longest) <= 32 * 1024 < len(too_big)

    with pytest.raises(AssertionError, match="не должен открывать"):
        client.post(PREFIX + "/drafts/1/edit", headers=headers, content=longest)  # прошло предел, дальше база
    for body in (too_big, iter([too_big])):  # по Content-Length и потоком
        assert problem(client.post(PREFIX + "/drafts/1/edit", headers=headers, content=body), 413, "too_large")


def test_import_body_limit_is_one_and_a_half_megabytes():
    client = make_client()
    headers = {**POST, "Content-Type": "application/json"}
    fits = json.dumps({"kind": "nope", "text": "a" * (1500 * 1024)}).encode()
    too_big = json.dumps({"kind": "nope", "text": "a" * (1540 * 1024)}).encode()

    assert "Неизвестный список" in problem(client.post(PREFIX + "/history/import", headers=headers, content=fits),
                                           400, "bad_request")
    assert problem(client.post(PREFIX + "/history/import", headers=headers, content=too_big), 413, "too_large")
    assert problem(client.post(PREFIX + "/history/import", headers=headers, content=iter([too_big])), 413, "too_large")


@pytest.mark.parametrize(("path", "body"), [
    ("/drafts/1/approve", {"x": 1}), ("/drafts/1/reject", {"reason": "нет"}), ("/companies/1/block", {"all": True}),
    ("/drafts/1/edit", {"subject": "Тема"}), ("/drafts/1/edit", {"subject": 1, "body": "Текст"}),
    ("/drafts/1/edit", {"subject": "Тема", "body": "Текст", "extra": 1}), ("/runs", {"query": "склад"}),
    ("/runs", {"query": ["склад"], "city": "almaty", "count": 5}), ("/history/import", {"text": "a@b.kz"}),
    ("/history/import", {"kind": "refused", "text": 5}), ("/history/import", {"kind": "refused", "file": "x"}),
    ("/history/import", {"kind": "refused", "fileBase64": "!!!"}), ("/history/import", {"kind": "all", "text": "a.kz"}),
])
def test_wrong_body_fields_are_400_before_database(path, body):
    response = make_client().post(PREFIX + path, headers=POST, json=body)

    assert problem(response, 400, "bad_request")


@pytest.mark.parametrize("query", [
    "/spend", "/spend?from=2026-10-01", "/spend?from=2026-10-30&to=2026-10-01", "/spend?from=2026-01-01&to=2026-12-31",
    "/spend?from=2026-02-30&to=2026-03-01", "/spend?from=20261001&to=20261030", "/spend?from=2026-10-1&to=2026-10-30",
    "/companies?status=bogus", "/companies?page=0", "/companies?page=abc", "/companies?page=-1", "/companies?run=x",
    "/companies?via=bot", "/companies?wa=yes", "/companies?blocked=2", "/companies?letter=true", "/companies?sort=old",
    "/companies?run=99999999999999999999", "/companies/digest", "/companies/digest?ids=", "/companies/digest?ids=a",
    "/companies/digest?ids=1,,2", "/companies/digest?ids=0", "/companies/digest?ids=" + ",".join(["1"] * 101),
    "/letters?status=sent", "/letters?run=0", "/letters?page=²", "/runs?page=0", "/history?page=x", "/blocked?page=0",
    "/research-jobs?status=lost", "/research-jobs?page=1.5", "/spend?from=9999-12-31&to=9999-12-31",
    "/spend?from=1999-12-31&to=2000-01-01", "/spend?from=0001-01-01&to=0001-01-02",
])
def test_bad_parameters_are_400_before_database(query):
    assert problem(make_client().get(PREFIX + query, headers=AUTH), 400, "bad_request")


@pytest.mark.parametrize("path", ["/letters/" + "9" * 4400, "/runs/" + "1" * 20, "/companies/" + "7" * 5000,
                                  "/drafts/" + "1" * 4400 + "/approve"])
def test_huge_number_in_path_is_not_a_route_and_token_comes_first(path):
    """Номер в пути консоли до 19 цифр: длиннее — 404 после токена, а не 500 из int() до токена."""
    client = make_client(raise_server_exceptions=False)
    method = "POST" if path.endswith("approve") else "GET"

    assert problem(client.request(method, PREFIX + path), 401, "unauthorized")
    assert problem(client.request(method, PREFIX + path, headers=POST, json={}), 404, "not_found")


def test_unexpected_error_checks_token_first():
    """500 консоли видит только тот, у кого верный токен."""
    app = make_app(start_run=FakeStartRun(error=RuntimeError("boom")))
    request_scope = {"type": "http", "path": PREFIX + "/runs", "headers": [], "method": "POST"}
    handler = app.exception_handlers[Exception]
    from starlette.requests import Request

    denied = asyncio.run(handler(Request(request_scope), RuntimeError("boom")))
    allowed = asyncio.run(handler(Request({**request_scope, "headers": [(b"x-console-token", CONSOLE_TOKEN.encode())]}),
                                  RuntimeError("boom")))

    assert (denied.status_code, json.loads(denied.body)["error"]) == (401, "unauthorized")
    assert (allowed.status_code, json.loads(allowed.body)["error"]) == (500, "internal")


def test_smtp_port_that_is_not_a_number_is_a_settings_error():
    from tanbala_leads.settings import SettingsError
    from tanbala_leads.steps import send as send_step

    with pytest.raises(SettingsError, match="SMTP_PORT"):
        send_step._smtp_port(load_settings({"SMTP_PORT": "465a"}))
    assert send_step._smtp_port(load_settings({"SMTP_PORT": "465"})) == 465


def test_spend_period_of_62_days_is_allowed_63_is_not():
    start = date(2026, 9, 1)
    allowed = f"/spend?from={start}&to={start + timedelta(days=61)}"
    refused = f"/spend?from={start}&to={start + timedelta(days=62)}"

    with pytest.raises(AssertionError, match="не должен открывать"):
        make_client().get(PREFIX + allowed, headers=AUTH)  # прошёл проверку и пошёл в базу
    assert problem(make_client().get(PREFIX + refused, headers=AUTH), 400, "bad_request")


def test_search_options_need_no_database_and_have_json_headers():
    response = make_client().get(PREFIX + "/search/options", headers=AUTH)
    data = ok(response)

    assert response.headers["content-type"] == "application/json; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert data["cities"][0] == {"code": "almaty", "name": "Алматы"} and len(data["cities"]) == 8
    assert data["limits"] == {"maxQueries": pipeline.MAX_QUERIES, "maxQueryLength": pipeline.MAX_QUERY_LENGTH,
                              "maxQueryTextLength": pipeline.MAX_QUERY_TEXT_LENGTH,
                              "maxPerIndustry": pipeline.MAX_COMPANIES_LIMIT, "maxTotal": pipeline.MAX_TOTAL_COMPANIES}
    assert data["defaults"] == {"city": "almaty", "count": 5}
    assert "склад" in data["quickQueries"]
    assert 0 < data["usdPerCompany"] < 0.01 and 0 < data["usdFirstRun"] < 0.01


def test_database_down_is_503_json_without_details():
    def broken_connect():
        raise psycopg.OperationalError("connection refused: postgresql://user:secret-pass@db")

    client = make_client(broken_connect)
    for response in (client.get(PREFIX + "/summary", headers=AUTH),
                     client.post(PREFIX + "/drafts/1/approve", headers=POST, json={})):
        assert problem(response, 503, "db_unavailable")
        assert "secret-pass" not in response.text


def test_unexpected_error_is_500_json_without_exception_text():
    start_run = FakeStartRun(error=RuntimeError("can't start new thread: secret-detail"))
    client = make_client(start_run=start_run, raise_server_exceptions=False)

    response = client.post(PREFIX + "/runs", headers=POST, json={"query": "склад", "city": "almaty", "count": 5})

    assert problem(response, 500, "internal")
    assert "secret-detail" not in response.text
    # Старый интерфейс получает прежний ответ Starlette.
    page = client.post("/runs", data={"csrf_token": "csrf", "city": "almaty", "query": "склад", "max_companies": "5"})
    assert (page.status_code, page.text) == (500, "Internal Server Error")


def test_get_routes_never_call_brief_or_whatsapp_mark():
    """Справка brief и отметка «писал в WhatsApp» — только у бота; консоль их не зовёт ни при чтении, ни в действиях."""
    for name in ("console.py", "console_views.py", "console_queries.py"):
        source = (WEB_DIR / name).read_text(encoding="utf-8")
        assert "mark_whatsapp_contact" not in source and "company_brief" not in source, name


@pytest.mark.parametrize(("path", "logged"), [
    ("/internal/console/drafts/12/approve", "/internal/console/drafts/12/approve"),
    ("/internal/console/companies?q=Рахат&page=2", "/internal/console/companies"),
    ("/internal/console/companies/digest?ids=1,2", "/internal/console/companies/digest"),
    ("/internal/console/spend?from=2026-10-01&to=2026-10-30", "/internal/console/spend"),
    ("/internal/console/runs/active", "/internal/console/runs/active"),
    ("/internal/console/history/import", "/internal/console/history/import"),
    ("/internal/console/companies/77001234567x", internal.INTERNAL_LOG_HIDDEN),
    ("/internal/console/chats/5", internal.INTERNAL_LOG_HIDDEN),
    ("/internal/console/letters/Рахат", internal.INTERNAL_LOG_HIDDEN),
])
def test_access_log_keeps_console_routes_without_query(path, logged):
    assert internal.log_path(path) == logged


# ---------- чтение, с базой ----------


def client_for(console_db, **options):
    _, connect, _ = console_db
    return make_client(connect, **options)


@pytest.mark.db
def test_summary_budget_overview_without_whatsapp_and_limits(console_db):
    conn, connect, opened = console_db
    for score in (80, 60):
        company_id, _, _ = full_company(conn, f"ТОО «{score}»", score=score)
        conn.execute("UPDATE companies SET status = 'drafted' WHERE id = %s", (company_id,))
    seed_company(conn, "ТОО «Мимо»", status="rejected")
    whatsapp = seed_company(conn, "ТОО «Из WhatsApp»", status="qualified", requested_via="whatsapp", website=None)
    seed_qualification(conn, whatsapp, 99)
    seed_llm_call(conn, "claude-haiku-5-5", input_tokens=200_000, output_tokens=40_000)
    seed_llm_call(conn, "claude-experimental", input_tokens=1_000, output_tokens=200)
    seed_llm_call(conn, created_at=datetime.now(UTC) - timedelta(days=3), input_tokens=1_000_000)
    active = seed_run(conn, status="running", stage="crawl", error="key=sk-ant-SECRET")
    conn.execute("INSERT INTO research_jobs (id, name, city, phone, status, reason) VALUES"
                 " ('3f2c9e0a-0000-4000-8000-000000000001', 'Рахат', 'almaty', '77001234567', 'queued', NULL),"
                 " ('3f2c9e0a-0000-4000-8000-000000000002', 'Мимо', NULL, NULL, 'failed', 'city_unsupported')")
    # Сегодня: Haiku $0,04 и модель без цены по самой дорогой (Sonnet) $0,004 — ровно как проверка при запуске.
    client = client_for(console_db, send_test=lambda conn, draft_id: None, test_address=TEST_TO,
                        daily_budget_usd=0.044)

    data = ok(get(client, "/summary"))

    assert data["testMode"] == {"testAddress": TEST_TO}
    assert data["budget"]["spentTodayUsd"] == round(pipeline.spent_today_usd(conn), 6)
    assert data["budget"] == {"dailyUsd": 0.044, "spentTodayUsd": 0.044, "over": True}
    assert data["spend"]["unpricedTokens"] == 1_200 and data["spend"]["totalTokens"] == 1_241_200
    assert data["overview"] == {"companiesFound": 3, "companiesFit": 2, "avgScoreFit": 70, "lettersPending": 2,
                                "lettersApproved": 0, "whatsappCompanies": 1}
    assert data["activeRun"]["id"] == active and data["activeRun"]["status"] == "running"
    assert "SECRET" not in data["activeRun"]["error"] and "[скрыто]" in data["activeRun"]["error"]
    assert data["research"]["today"] == 1 and data["research"]["perDay"] is None
    assert [job["name"] for job in data["research"]["active"]] == ["Рахат"]
    assert "phone" not in data["research"]["active"][0] and "77001234567" not in json.dumps(data)
    assert data["testSends"] == {"today": 0, "perDay": 30}
    assert all(c.closed for c in opened)


@pytest.mark.db
def test_summary_without_test_address_or_budget(console_db):
    data = ok(get(client_for(console_db), "/summary"))

    assert data["testMode"] == {"testAddress": None}
    assert data["budget"] == {"dailyUsd": None, "spentTodayUsd": 0.0, "over": False}
    assert data["activeRun"] is None and data["overview"]["avgScoreFit"] is None


@pytest.mark.db
def test_spend_by_almaty_day_model_and_task_with_prices(console_db):
    conn, _, _ = console_db
    # 19:30 UTC 29.10 — уже 30.10 по Алматы; 18:59 UTC 29.10 — ещё 29.10.
    seed_llm_call(conn, created_at=datetime(2026, 10, 29, 19, 30, tzinfo=UTC), input_tokens=1000, output_tokens=200)
    seed_llm_call(conn, created_at=datetime(2026, 10, 30, 10, 0, tzinfo=UTC), input_tokens=500, cache_read_tokens=7)
    seed_llm_call(conn, task="first_email", created_at=datetime(2026, 10, 29, 18, 59, tzinfo=UTC), output_tokens=9)
    seed_llm_call(conn, created_at=datetime(2026, 10, 31, 19, 0, tzinfo=UTC), input_tokens=1)  # 01.11: вне периода

    data = ok(get(client_for(console_db), "/spend?from=2026-10-29&to=2026-10-31"))

    assert data["rows"] == [
        {"day": "2026-10-29", "model": "claude-haiku-5-5", "task": "first_email", "calls": 1, "input": 0,
         "output": 9, "cacheRead": 0, "cacheWrite": 0},
        {"day": "2026-10-30", "model": "claude-haiku-5-5", "task": "qualify", "calls": 2, "input": 1500,
         "output": 200, "cacheRead": 7, "cacheWrite": 0},
    ]
    haiku = llm.MODEL_PRICES_USD_PER_MTOK["claude-haiku-5-5"]
    assert data["prices"]["claude-haiku-5-5"] == {"input": haiku["input"], "output": haiku["output"],
                                                  "cacheRead": haiku["cache_read"], "cacheWrite": haiku["cache_write"]}
    assert data["pricesAsOf"] == llm.MODEL_PRICES_AS_OF == "2026-10-06"
    assert (data["from"], data["to"]) == ("2026-10-29", "2026-10-31")


@pytest.mark.db
def test_companies_filters_sort_facets_and_rows(console_db):
    conn, _, _ = console_db
    old_runs = [seed_run(conn, query=f"запуск {n}") for n in range(52)]
    run_id = old_runs[0]
    plain, _, draft_id = full_company(conn, "ТОО «Склад»", score=70, run_id=run_id, query="склад",
                                      last_error="postgresql://u:SECRET@h/db")
    top, _, _ = full_company(conn, "ТОО «Лучший»", score=95, query="склад")
    whatsapp = seed_company(conn, "ТОО «Рахат»", status="qualified", requested_via="whatsapp", website=None)
    contacted = seed_company(conn, "ТОО «Писал»", status="new", website=None, query="тара")
    conn.execute("UPDATE companies SET whatsapp_contacted_at = now() WHERE id = %s", (contacted,))
    contact_policy.block_company(conn, top, note="тест")
    client = client_for(console_db)

    def ids(query=""):
        return [row["id"] for row in ok(get(client, "/companies" + query))["items"]]

    assert ids() == [contacted, whatsapp, top, plain]
    assert ids("?sort=score") == [top, plain, contacted, whatsapp]
    assert ids("?sort=letter") == [top, plain, contacted, whatsapp]
    assert ids("?via=whatsapp") == [whatsapp] and whatsapp not in ids("?via=regular")
    assert ids("?wa=1") == [contacted] and ids("?blocked=1") == [top] and ids("?letter=1") == [top, plain]
    assert ids("?query=склад&q=Лучш") == [top] and ids(f"?run={run_id}") == [plain]
    assert ids("?status=drafted&via=regular&letter=1&blocked=0&wa=0") == [top, plain]

    data = ok(get(client, f"/companies?run={run_id}"))
    row = data["items"][0]
    assert row == {
        "id": plain, "name": "ТОО «Склад»", "rubric": "Складские услуги", "city": "almaty", "cityName": "Алматы",
        "searchQuery": "склад", "status": "drafted", "statusLabel": "Письмо готово", "statusTone": "accent",
        "hadError": True, "fit": "yes", "fitLabel": "подходит", "score": 70, "segment": "склады",
        "contact": {"email": f"info@c{plain}.example.kz", "verifyResult": "safe", "verifyLabel": "Существует",
                    "isCatchAll": None, "isRole": True},
        "draft": {"id": draft_id, "subject": "Инвентаризация за часы", "reviewStatus": "pending",
                  "reviewLabel": "Ждёт проверки", "checksTotal": 2, "checksFailed": 1},
        "requestedVia": None, "whatsappContactedAt": None, "blocked": False, "createdAt": row["createdAt"],
    }
    assert (data["total"], data["page"], data["pages"], data["pageSize"]) == (1, 1, 1, 50)
    facets = data["facets"]
    assert facets["run"]["id"] == run_id and run_id not in [r["id"] for r in facets["runs"]]
    assert len(facets["runs"]) == 50 and facets["runs"][0]["id"] == old_runs[-1]
    assert facets["cards"][0] == {"code": "all", "label": "Все", "count": 1}

    everything = ok(get(client, "/companies"))
    assert [c["count"] for c in everything["facets"]["cards"]] == [4, 2, 0, 0]
    assert {s["code"]: s["count"] for s in everything["facets"]["statuses"]}["qualified"] == 1
    assert len(everything["facets"]["statuses"]) == 9
    assert everything["facets"]["industries"] == [{"query": "склад", "count": 2}, {"query": "тара", "count": 1}]
    assert everything["facets"]["run"] is None
    filtered = ok(get(client, "/companies?status=drafted"))
    assert filtered["total"] == 2 and [c["count"] for c in filtered["facets"]["cards"]] == [4, 2, 0, 0]


@pytest.mark.db
def test_sorts_follow_score_and_letter_date_not_company_age(console_db):
    """Старая компания с лучшей оценкой и самым свежим письмом идёт первой в score и letter, последней в new."""
    conn, _, _ = console_db
    old = seed_company(conn, "ТОО «Старая»")
    seed_qualification(conn, old, 99)
    old_contact = seed_contact(conn, old, "info@old.example.kz")
    fresh, _, _ = full_company(conn, "ТОО «Новая»", score=50)
    no_letter = seed_company(conn, "ТОО «Без письма»", status="new", website=None)
    seed_draft(conn, old, old_contact)  # письмо старой компании написано последним
    client = client_for(console_db)

    def ids(sort):
        return [row["id"] for row in ok(get(client, f"/companies?sort={sort}"))["items"]]

    assert ids("new") == [no_letter, fresh, old]
    assert ids("score") == [old, fresh, no_letter]
    assert ids("letter") == [old, fresh, no_letter]


@pytest.mark.db
def test_blocked_recipient_address_marks_list_digest_card_and_letter(console_db):
    """Блок только адреса получателя (бесплатная почта, домен не блокируется) — компания тоже «не писать»."""
    conn, _, _ = console_db
    company_id = seed_company(conn, "ТОО «Гмейл»", website=None)
    seed_qualification(conn, company_id, 70)
    draft_id = seed_draft(conn, company_id, seed_contact(conn, company_id, "boss.sklad@gmail.com"))
    other = full_company(conn, "ТОО «Другая»")[0]
    contact_policy.import_contacts(conn, "boss.sklad@gmail.com", refused=True)
    assert conn.execute("SELECT count(*) FROM do_not_contact WHERE domain IS NOT NULL OR company_id IS NOT NULL"
                        " AND company_id <> %s", (company_id,)).fetchone()[0] == 0
    client = client_for(console_db)

    assert [row["id"] for row in ok(get(client, "/companies?blocked=1"))["items"]] == [company_id]
    rows = {row["id"]: row["blocked"] for row in ok(get(client, "/companies"))["items"]}
    assert rows == {company_id: True, other: False}
    digest = ok(get(client, f"/companies/digest?ids={company_id},{other}"))["items"]
    assert [item["blocked"] for item in digest] == [True, False]
    assert ok(get(client, f"/companies/{company_id}"))["blocked"] is True
    letter = ok(get(client, f"/letters/{draft_id}"))
    assert (letter["blocked"], letter["canApprove"], letter["approveBlocked"]) == (True, False, True)
    assert letter["approveBlockedReason"] == "Компания в списке «не писать»: письмо нельзя одобрить."


@pytest.mark.db
def test_companies_pages_by_fifty_and_page_after_last_is_empty(console_db):
    conn, _, _ = console_db
    for index in range(55):
        seed_company(conn, f"Компания {index:02d}", status="new", website=None)
    client = client_for(console_db)

    second = ok(get(client, "/companies?page=2"))
    after = ok(get(client, "/companies?page=3"))
    huge = ok(get(client, "/companies?page=999999999999999999"))

    assert len(second["items"]) == 5 and (second["total"], second["pages"]) == (55, 2)
    assert (after["items"], after["total"], after["pages"], after["page"]) == ([], 55, 2, 3)
    assert huge["items"] == [] and huge["total"] == 55


@pytest.mark.db
def test_company_card_has_everything_and_redacts_errors(console_db):
    conn, _, _ = console_db
    company_id, _, draft_id = full_company(conn, site_text="я" * 20_005, last_error="APIError token=SECRET1")
    seed_contact(conn, company_id, "sales@c.example.kz", verify_result=None, is_role=False)
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, error) VALUES"
                 " (%s, %s, 'x@y.kz', 'failed', 'SMTP: password=SECRET2')", (draft_id, TEST_TO))
    contact_policy.import_contacts(conn, f"info@c{company_id}.example.kz", refused=False)
    seed_llm_call(conn, company_id=company_id, input_tokens=200_000, output_tokens=40_000)
    client = client_for(console_db, send_test=lambda conn, draft_id: None, test_address=TEST_TO)

    card = ok(get(client, f"/companies/{company_id}"))

    company = card["company"]
    assert company["lastError"] == "APIError [скрыто]" and "SECRET" not in json.dumps(card)
    assert company["phones"] == ["+7 727 355 10 20"] and company["sourceUrl"].startswith("https://2gis.kz/")
    assert (company["status"], company["statusLabel"], company["cityName"]) == ("drafted", "Письмо готово", "Алматы")
    assert company["requestedVia"] is None and company["whatsappContactedAt"] is None
    assert card["qualification"]["fitLabel"] == "подходит" and card["qualification"]["score"] == 86
    assert card["pains"] == [{"pain": "Инвентаризация занимает дни", "evidence": "пересчёт раз в квартал",
                              "source": "site", "sourceLabel": "сайт", "verified": True}]
    assert [c["email"] for c in card["contacts"]] == [f"info@c{company_id}.example.kz", "sales@c.example.kz"]
    assert card["contacts"][1]["verifyLabel"] == "Не проверена" and card["contacts"][0]["sourcePage"]
    assert card["draft"]["id"] == draft_id and card["draft"]["companyId"] == company_id
    assert card["testSends"] == card["draft"]["testSends"] and card["testSends"][0]["error"] == "SMTP: [скрыто]"
    assert card["history"][0]["sourceLabel"] == "импорт" and card["history"][0]["whatLabel"] == "отправлено, первое письмо"
    assert card["blocked"] is False
    assert card["siteText"]["length"] == 20_005 and card["siteText"]["truncated"] is True
    assert len(card["siteText"]["text"]) == 20_000
    assert card["cost"]["tokens"] == 240_000 and card["cost"]["unpricedTokens"] == 0 and card["cost"]["usd"] > 0


@pytest.mark.db
@pytest.mark.parametrize("company_id", ["999999", "9223372036854775807", "99999999999999999999"])
def test_unknown_company_is_404(console_db, company_id):
    assert problem(get(client_for(console_db), f"/companies/{company_id}"), 404, "not_found")


@pytest.mark.db
def test_digest_matches_letters_like_lookup_without_test_sends(console_db):
    conn, _, _ = console_db
    emailed = seed_company(conn, "Платформа-А", domain="platforma.kz", status="verified")
    contact_id = seed_contact(conn, emailed, "info@platforma.kz")
    draft_id = seed_draft(conn, emailed, contact_id)
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status) VALUES (%s, %s, 'info@platforma.kz',"
                 " 'sent')", (draft_id, TEST_TO))
    quiet = seed_company(conn, "Тишина", status="qualified")
    seed_qualification(conn, quiet, 40, fit="maybe")
    client = client_for(console_db)

    before = ok(get(client, f"/companies/digest?ids={quiet},{emailed},999999,{quiet}"))["items"]
    assert [item["id"] for item in before] == [quiet, emailed]
    assert before[1]["emailed"] is False and before[1]["firstLetterAt"] is None

    for at in ("2026-10-01T10:00:00+05:00", "2026-10-20T09:00:00+00:00"):
        conn.execute("INSERT INTO contact_history (email, direction, kind, source, occurred_at)"
                     " VALUES (%s, 'out', 'reply', 'import', %s)", (f"director{at[8:10]}@platforma.kz", at))
    items = ok(get(client, f"/companies/digest?ids={emailed},{quiet}"))["items"]
    assert items[0] == {"id": emailed, "name": "Платформа-А", "city": "almaty", "cityName": "Алматы",
                        "rubric": "Складские услуги", "fit": None, "score": None, "segment": None,
                        "status": "verified", "requestedVia": None, "whatsappContactedAt": None, "blocked": False,
                        "emailed": True, "firstLetterAt": "2026-10-01T05:00:00+00:00",
                        "lastLetterAt": "2026-10-20T09:00:00+00:00"}
    assert (items[1]["fit"], items[1]["score"], items[1]["emailed"]) == ("maybe", 40, False)


@pytest.mark.db
def test_letters_keep_queue_order_filters_and_pages(console_db):
    conn, _, _ = console_db
    run_id = seed_run(conn)
    low = full_company(conn, "ТОО «Низкая»", score=50, run_id=run_id)[2]
    high = full_company(conn, "ТОО «Высокая»", score=90)[2]
    approved = full_company(conn, "ТОО «Одобрена»", score=99)[2]
    conn.execute("UPDATE drafts SET review_status = 'approved', approved_by = 'x', approved_at = now() WHERE id = %s",
                 (approved,))
    client = client_for(console_db)

    pending = ok(get(client, "/letters"))
    assert [item["id"] for item in pending["items"]] == [high, low]
    assert pending["filters"] == [{"code": "pending", "label": "Ждут проверки", "count": 2},
                                  {"code": "approved", "label": "Одобрены", "count": 1},
                                  {"code": "rejected", "label": "Отклонены", "count": 0},
                                  {"code": "all", "label": "Все", "count": 3}]
    assert (pending["total"], pending["pageSize"], pending["status"], pending["run"]) == (2, 100, "pending", None)
    item = pending["items"][0]
    assert (item["companyName"], item["reviewLabel"], item["checksFailed"], item["verifiedPains"]) == (
        "ТОО «Высокая»", "Ждёт проверки", 1, 1)
    assert [i["id"] for i in ok(get(client, "/letters?status=all"))["items"]] == [high, low, approved]
    by_run = ok(get(client, f"/letters?status=all&run={run_id}"))
    assert [i["id"] for i in by_run["items"]] == [low] and by_run["run"]["id"] == run_id
    assert by_run["filters"][3]["count"] == 1
    after = ok(get(client, "/letters?page=2"))
    assert (after["items"], after["total"], after["pages"]) == ([], 2, 1)


@pytest.mark.db
def test_letter_has_notes_checks_buttons_and_company(console_db):
    conn, _, _ = console_db
    company_id, _, draft_id = full_company(conn)
    conn.execute("UPDATE companies SET requested_via = 'whatsapp', whatsapp_contacted_at = '2026-10-28T12:00:00Z'"
                 " WHERE id = %s", (company_id,))
    with_test = client_for(console_db, send_test=lambda conn, draft_id: None, test_address=TEST_TO)

    letter = ok(get(with_test, f"/letters/{draft_id}"))

    assert letter["body"].startswith("[Проверить:") and letter["notes"] == [
        {"kind": "Проверить", "text": "число паллетомест с сайта"}]
    assert letter["textLines"][0] == {"text": "Здравствуйте!", "note": False}
    assert {"text": "[Ответить лично: посреди текста]", "note": True} in letter["textLines"]
    assert letter["checks"][0] == {"code": "dashes", "label": "Тире", "passed": False,
                                   "details": ["тире: «—» в «…метки — на…»"]}
    assert (letter["checksTotal"], letter["checksFailed"]) == (2, 1)
    assert letter["contact"] == {"email": f"info@c{company_id}.example.kz", "verifyResult": "safe",
                                 "verifyLabel": "Существует", "isCatchAll": None, "isRole": True}
    # Компания из WhatsApp: одобрить не даст триггер базы, кнопка выключена с причиной.
    assert (letter["canApprove"], letter["approveBlocked"], letter["canReject"], letter["canEdit"]) == (
        False, True, True, True)
    assert letter["approveBlockedReason"] == "Компания пришла из WhatsApp: письмо ей одобрить нельзя"
    assert (letter["canSendTest"], letter["sendTestBlockedReason"], letter["testAddress"]) == (True, None, TEST_TO)
    assert (letter["reviewStatus"], letter["reviewLabel"], letter["approvedBy"], letter["blocked"]) == (
        "pending", "Ждёт проверки", None, False)
    company = letter["company"]
    assert (company["requestedVia"], company["whatsappContactedAt"]) == ("whatsapp", "2026-10-28T12:00:00+00:00")
    assert company["pains"][0]["verified"] is True and company["fitLabel"] == "подходит"

    conn.execute("UPDATE companies SET requested_via = NULL WHERE id = %s", (company_id,))
    regular = ok(get(with_test, f"/letters/{draft_id}"))
    assert (regular["canApprove"], regular["approveBlocked"], regular["approveBlockedReason"]) == (True, False, None)
    without_test = ok(get(client_for(console_db), f"/letters/{draft_id}"))
    assert without_test["canSendTest"] is False and without_test["testAddress"] is None
    assert without_test["sendTestBlockedReason"] == "Тестовая отправка выключена: DRY_RUN_TO не настроен."
    conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (draft_id,))
    rejected = ok(get(with_test, f"/letters/{draft_id}"))
    assert rejected["sendTestBlockedReason"] == "Отклонённое письмо не отправляется даже в тест."
    assert (rejected["canApprove"], rejected["canEdit"], rejected["canSendTest"]) == (False, False, False)
    assert problem(get(with_test, "/letters/999999"), 404, "not_found")


@pytest.mark.db
def test_runs_list_active_and_one_like_api_runs(console_db):
    conn, connect, _ = console_db
    done = seed_run(conn, query="тара, склад", found=6, new_companies=5, drafted=1)
    seed_llm_call(conn, run_id=done, input_tokens=200_000, output_tokens=40_000)
    failed = seed_run(conn, status="failed", stage="Сайты", error="OperationalError postgresql://u:SECRET@h/db")
    client = client_for(console_db)

    assert get(client, "/runs/active").json() is None
    one = ok(get(client, f"/runs/{done}"))
    old = make_client(connect).get(f"/api/runs/{done}").json()
    assert one["industries"] == old["industries"] == ["тара", "склад"]
    assert (one["statusLabel"], one["stageLabel"], one["finished"]) == (old["status_label"], old["stage_label"], True)
    assert one["cost"]["usd"] == old["cost"]["usd"] and one["cost"]["tokens"] == 240_000
    assert [s["state"] for s in one["stages"]] == [s["state"] for s in old["stages"]]
    assert one["stages"][0]["counters"] == [{"field": "found", "label": "найдено", "value": 6},
                                            {"field": "new_companies", "label": "новых", "value": 5}]
    assert (one["newCompanies"], one["maxCompanies"], one["cityName"]) == (5, 5, "Алматы")
    assert ok(get(client, f"/runs/{failed}"))["error"] == "OperationalError [скрыто]"
    listed = ok(get(client, "/runs"))
    assert [r["id"] for r in listed["items"]] == [failed, done] and listed["pageSize"] == 20
    assert problem(get(client, "/runs/999999"), 404, "not_found")
    running = seed_run(conn, status="running", stage="collect")
    assert ok(get(client, "/runs/active"))["id"] == running


@pytest.mark.db
def test_history_and_blocked_pages_with_subject(console_db):
    conn, _, _ = console_db
    company_id, contact_id, draft_id = full_company(conn)
    conn.execute("INSERT INTO contact_history (company_id, email, direction, draft_id, subject, source)"
                 " VALUES (%s, %s, 'out', %s, 'Учёт склада', 'pipeline')", (company_id, f"info@c{company_id}.example.kz",
                                                                       draft_id))
    for index in range(55):
        contact_policy.block(conn, reason="manual", email=f"user{index:02d}@block.example.kz", note="вручную")
    contact_policy.block(conn, reason="refused", company_id=company_id)
    client = client_for(console_db)

    history = ok(get(client, "/history"))
    assert history["items"][0] == {"id": history["items"][0]["id"], "occurredAt": history["items"][0]["occurredAt"],
                                   "email": f"info@c{company_id}.example.kz", "direction": "out",
                                   "directionLabel": "отправлено", "kind": "first_email", "kindLabel": "первое письмо",
                                   "whatLabel": "отправлено, первое письмо", "source": "pipeline",
                                   "sourceLabel": "система", "subject": "Учёт склада", "note": None,
                                   "draftId": draft_id, "companyId": company_id, "companyName": "ТОО «Степь Склад»"}
    blocked = ok(get(client, "/blocked"))
    assert (blocked["total"], blocked["pages"], len(blocked["items"])) == (56, 2, 50)
    assert blocked["items"][0]["companyId"] == company_id and blocked["items"][0]["reasonLabel"] == "отказ"
    assert ok(get(client, "/blocked?page=2"))["items"][-1]["email"] == "user00@block.example.kz"
    far = ok(get(client, "/history?page=999999999999999999"))
    assert (far["items"], far["total"]) == ([], 1)


@pytest.mark.db
def test_research_jobs_without_error_or_phone(console_db):
    conn, _, _ = console_db
    company_id = seed_company(conn, "ТОО «Рахат»", status="qualified", requested_via="whatsapp")
    conn.execute(
        "INSERT INTO research_jobs (id, name, city, phone, domain, status, reason, company_id, error, created_at) VALUES"
        " ('3f2c9e0a-0000-4000-8000-000000000001', 'Рахат', 'almaty', '77001234567', 'rahat.kz', 'done', NULL, %s,"
        "  NULL, now() - interval '1 hour'),"
        " ('3f2c9e0a-0000-4000-8000-000000000002', 'Аксенгер', 'astana', NULL, NULL, 'failed', 'not_in_2gis', NULL,"
        "  'ParserError https://2gis.kz/astana/search/Аксенгер', now())", (company_id,))
    client = client_for(console_db)

    data = ok(get(client, "/research-jobs"))
    assert data["items"][0] == {"id": "3f2c9e0a-0000-4000-8000-000000000002", "name": "Аксенгер", "city": "astana",
                                "cityName": "Астана", "domain": None, "status": "failed", "statusLabel": "Не удалось",
                                "reason": "not_in_2gis", "reasonLabel": "В 2ГИС не нашлась", "companyId": None,
                                "createdAt": data["items"][0]["createdAt"], "startedAt": None, "finishedAt": None}
    assert "ParserError" not in json.dumps(data) and "77001234567" not in json.dumps(data)
    done = ok(get(client, "/research-jobs?status=done"))
    assert [j["companyId"] for j in done["items"]] == [company_id] and done["pageSize"] == 50


@pytest.mark.db
def test_get_endpoints_change_nothing(console_db):
    """Чтение без побочных действий: ни отметки «писал в WhatsApp», ни записи в базу."""
    conn, _, opened = console_db
    company_id, _, draft_id = full_company(conn)
    run_id = seed_run(conn)
    snapshot_sql = ("SELECT (SELECT json_agg(c ORDER BY id) FROM companies c), (SELECT json_agg(d ORDER BY id) FROM"
                    " drafts d), (SELECT count(*) FROM do_not_contact), (SELECT count(*) FROM contact_history),"
                    " (SELECT count(*) FROM test_sends), (SELECT json_agg(r ORDER BY id) FROM runs r)")
    before = conn.execute(snapshot_sql).fetchone()
    client = client_for(console_db, send_test=lambda conn, draft_id: None, test_address=TEST_TO)

    for path in ["/summary", "/spend?from=2026-10-01&to=2026-10-30", "/companies", f"/companies/{company_id}",
                 f"/companies/digest?ids={company_id}", "/letters", f"/letters/{draft_id}", "/runs", "/runs/active",
                 f"/runs/{run_id}", "/search/options", "/history", "/blocked", "/research-jobs"]:
        assert get(client, path).status_code == 200, path

    assert conn.execute(snapshot_sql).fetchone() == before
    assert conn.execute("SELECT whatsapp_contacted_at FROM companies WHERE id = %s", (company_id,)).fetchone()[0] is None
    assert all(c.closed for c in opened)


@pytest.mark.db
def test_bot_contract_is_unchanged_next_to_console(console_db):
    """С включённым API консоли бот ходит в /internal как раньше: те же ответы, ошибки и отметка brief."""
    conn, _, _ = console_db
    company_id = seed_company(conn, "Платформа-А", domain="platforma.kz", status="qualified")
    client = client_for(console_db)

    found = client.get("/internal/lookup", params={"domain": "platforma.kz"}, headers=BOT_AUTH)
    assert found.status_code == 200 and found.json()["candidates"][0]["id"] == company_id
    assert set(found.json()["candidates"][0]) == {"id", "name", "city", "rubric", "match_by", "match_score",
                                                  "emailed", "emailed_at"}
    assert client.get(f"/internal/companies/{company_id}/brief", headers=BOT_AUTH).status_code == 200
    assert conn.execute("SELECT whatsapp_contacted_at IS NOT NULL FROM companies WHERE id = %s",
                        (company_id,)).fetchone()[0]
    assert (client.get("/internal/nope", headers=BOT_AUTH).json(), client.get("/internal/nope").json()) == (
        {"error": "not_found"}, {"error": "unauthorized"})
    assert client.post("/internal/lookup", headers=BOT_AUTH).json() == {"error": "bad_request"}
    response = client.get("/internal/lookup?domain=x.kz", headers={**BOT_AUTH, "Host": "evil.example"})
    assert (response.status_code, response.text) == (400, "Invalid host header")


def test_contract_names_match_routes():
    """Каждый путь из раздела 2 контракта есть у роутера консоли."""
    def walk(routes):
        for route in routes:
            nested = getattr(route, "original_router", None)  # FastAPI 0.161: подключённый роутер
            yield from walk(nested.routes) if nested is not None else [route]

    routes = {(method, route.path) for route in walk(make_app().routes) if getattr(route, "methods", None)
              for method in route.methods}
    expected = {("GET", PREFIX + p) for p in ("/summary", "/spend", "/companies", "/companies/digest",
                                              "/companies/{company_id:dbid}", "/letters", "/letters/{draft_id:dbid}",
                                              "/runs", "/runs/active", "/runs/{run_id:dbid}", "/search/options",
                                              "/history", "/blocked", "/research-jobs")}
    expected |= {("POST", PREFIX + p) for p in ("/runs", "/drafts/{draft_id:dbid}/approve",
                                                "/drafts/{draft_id:dbid}/reject", "/drafts/{draft_id:dbid}/edit",
                                                "/drafts/{draft_id:dbid}/send-test", "/companies/{company_id:dbid}/block",
                                                "/companies/{company_id:dbid}/whatsapp-clear", "/history/import")}
    assert expected <= routes
    assert not [path for _, path in routes if path.startswith(PREFIX) and not re.fullmatch(r"[/a-z{}:_-]+", path)]
