"""Веб-интерфейс: страницы, экранирование чужого текста, CSRF и Host, запуск поиска, одобрение писем, расходы."""

import os
import re
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from tanbala_leads import db, pipeline
from tanbala_leads.steps import approve as approve_step
from tanbala_leads.llm import call_cost_usd
from tanbala_leads.web import app as web
from tanbala_leads.web import create_app, views
from tanbala_leads.web import format as fmt

BASE_URL = "http://127.0.0.1"
TOKEN = "test-csrf-token"
WEB_DIR = Path(web.__file__).resolve().parent


class FakeStartRun:
    """Подменяет pipeline.start_run: запоминает аргументы, ничего не запускает."""

    def __init__(self, result: int = 7, error: Exception | None = None):
        self.result = result
        self.error = error
        self.calls: list[tuple[str, str, int]] = []

    def __call__(self, city: str, query: str, max_companies: int) -> int:
        self.calls.append((city, query, max_companies))
        if self.error is not None:
            raise self.error
        return self.result


def no_db() -> psycopg.Connection:
    raise AssertionError("этот запрос не должен открывать соединение с базой")


def make_client(connect=no_db, start_run=None, base_url: str = BASE_URL) -> TestClient:
    app = create_app(connect, start_run or FakeStartRun(), csrf_token=TOKEN)
    return TestClient(app, base_url=base_url)


# ---------- без базы ----------


def test_cost_uses_prices_per_million_tokens():
    assert call_cost_usd("claude-haiku-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(0.735)
    assert call_cost_usd("claude-sonnet-5-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000) == pytest.approx(14.7)
    assert call_cost_usd("claude-haiku-5-5", 200_000, 40_000) == pytest.approx(0.04)


def test_unknown_model_counts_tokens_but_not_dollars():
    rows = [
        {"model": "claude-haiku-5-5", "input_tokens": 200_000, "output_tokens": 40_000,
         "cache_read_tokens": 0, "cache_write_tokens": 0},
        {"model": "claude-experimental", "input_tokens": 1_000, "output_tokens": 200,
         "cache_read_tokens": None, "cache_write_tokens": 0},
    ]
    cost = fmt.cost_from_rows(rows)
    assert cost.tokens == 241_200
    assert cost.usd == pytest.approx(0.04)
    assert cost.unpriced_tokens == 1_200
    assert not cost.priced
    assert fmt.format_cost(cost) == "≈ $0,0400 + 1 200 токенов без цены"
    only_unknown = fmt.cost_from_rows(rows[1:])
    assert fmt.format_cost(only_unknown) == "1 200 токенов без цены"
    assert fmt.format_cost(fmt.Cost()) == "$0"


@pytest.mark.parametrize(("value", "text"), [
    (0, "$0"), (0.00004, "< $0,0001"), (0.0123, "$0,0123"), (12.5, "$12,50"), (1234.5, "$1 234,50"),
])
def test_format_usd(value, text):
    assert fmt.format_usd(value) == text


def test_estimate_line_comes_from_token_constants():
    """Первый настоящий запуск: $0,0055 за 1 компанию, из них около $0,0024 запись документа в кэш."""
    assert fmt.estimate_per_company_usd() == pytest.approx(0.0033, abs=0.0002)
    assert fmt.estimate_first_run_usd() == pytest.approx(0.00245, abs=0.0001)
    assert fmt.estimate_per_company_usd() + fmt.estimate_first_run_usd() == pytest.approx(0.0055, abs=0.0004)
    assert fmt.format_approx_usd(fmt.estimate_per_company_usd()) == "$0,003"
    assert fmt.format_estimate(1) == "За 1 компанию около $0,006"
    assert fmt.format_estimate(5) == "За 5 компаний около $0,02"
    assert fmt.format_estimate(20) == "За 20 компаний около $0,07"


@pytest.mark.parametrize(("value", "text"), [(0, "$0"), (0.0033, "$0,003"), (0.00245, "$0,002"), (0.0096, "$0,01"),
                                             (0.019, "$0,02"), (0.25, "$0,3"), (1.4, "$1")])
def test_format_approx_usd_keeps_one_significant_digit(value, text):
    assert fmt.format_approx_usd(value) == text


@pytest.mark.parametrize(("number", "word"), [(1, "токен"), (2, "токена"), (5, "токенов"), (11, "токенов"),
                                              (21, "токен"), (104, "токена"), (112, "токенов")])
def test_plural(number, word):
    assert fmt.plural(number, fmt.TOKEN_FORMS) == word


@pytest.mark.parametrize(("raw", "href"), [
    ("https://sklad.kz/kontakty", "https://sklad.kz/kontakty"),
    ("sklad.kz", "https://sklad.kz"),
    ("http://www.sklad.kz", "http://www.sklad.kz"),
    ("javascript:alert(1)", None),
    ("JavaScript:alert(1)", None),
    ("java\nscript:alert(1)", None),
    ("data:text/html,<script>alert(1)</script>", None),
    ("//evil.example/x", None),
    ("", None),
    (None, None),
])
def test_safe_href_allows_only_http(raw, href):
    assert fmt.safe_href(raw) == href


def test_stage_states_follow_runs_row():
    assert views.stage_states("queued", None) == ["pending"] * 5
    assert views.stage_states("running", None) == ["current"] + ["pending"] * 4
    assert views.stage_states("running", "crawl") == ["done", "current", "pending", "pending", "pending"]
    assert views.stage_states("failed", "qualify") == ["done", "done", "failed", "pending", "pending"]
    assert views.stage_states("done", "draft") == ["done"] * 5


def test_stage_states_understand_pipeline_labels():
    """pipeline.execute_run пишет в runs.stage русские названия, «Подготовка» и «Готово»."""
    assert views.stage_states("running", "Подготовка") == ["current"] + ["pending"] * 4
    assert views.stage_states("running", "Сайты") == ["done", "current", "pending", "pending", "pending"]
    assert views.stage_states("failed", "Проверка почт") == ["done", "done", "done", "failed", "pending"]
    assert views.stage_states("failed", None) == ["failed"] + ["pending"] * 4
    assert views.stage_states("done", "Готово") == ["done"] * 5
    row = {"id": 1, "city": "almaty", "status": "running", "stage": "Квалификация", "error": None, "drafted": 0}
    assert views.run_json(row, fmt.Cost())["stage_label"] == "Квалификация"


@pytest.mark.parametrize("raw", ["²", "٣", "-1", "1.5", " ", "1" * 19])
def test_parse_id_rejects_non_ascii_and_odd_input(raw):
    assert fmt.parse_id(raw) is None


def test_redact_hides_keys_and_dsn():
    text = fmt.redact("APIError sk-ant-api03-AbC_d-1 при postgresql://user:pw@db:5432/x, api_key=abc token: zzz")
    for secret in ("sk-ant-api03", "user:pw", "api_key=abc", "zzz"):
        assert secret not in text
    assert text.startswith("APIError [скрыто]") and fmt.redact(None) is None


def test_parse_checks_survives_foreign_shapes():
    raw = [{"name": "dashes", "passed": False, "details": ["тире"]}, "мусор", {"name": "new_rule", "passed": True}]
    checks = fmt.parse_checks(raw)
    assert [c["label"] for c in checks] == ["Тире", "new_rule"]
    assert checks[0]["details"] == ["тире"] and not checks[0]["passed"] and checks[1]["passed"]
    assert fmt.parse_checks(None) == [] and fmt.parse_checks({"name": "x"}) == []


def test_foreign_host_is_rejected():
    response = make_client(base_url="http://evil.example").get("/")
    assert response.status_code == 400
    for host in ("localhost:8000", "127.0.0.1:8000"):
        assert make_client().get("/static/app.css", headers={"Host": host}).status_code == 200


def test_cross_site_fetch_and_huge_body_are_refused():
    start_run = FakeStartRun()
    client = make_client(start_run=start_run)
    form = {"csrf_token": TOKEN, "city": "almaty", "query": "склад", "max_companies": "5"}
    assert client.post("/runs", data=form, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    huge = {"csrf_token": TOKEN, "body": "я" * 200_000}
    # Размер проверяется до разбора формы и до базы: connect здесь упал бы.
    for path in ("/drafts/1/approve", "/drafts/1/edit", "/runs"):
        assert client.post(path, data=huge).status_code == 413
    assert start_run.calls == []


def test_serve_refuses_any_host_but_loopback():
    with pytest.raises(ValueError, match="127.0.0.1"):
        web.serve(host="0.0.0.0")


@pytest.mark.parametrize("path", ["/runs", "/drafts/1/approve", "/drafts/1/reject", "/drafts/1/edit"])
def test_post_without_csrf_token_is_forbidden(path):
    client = make_client()
    assert client.post(path, data={"city": "almaty", "query": "склад", "max_companies": "5"}).status_code == 403
    assert client.post(path, data={"csrf_token": "чужой"}).status_code == 403
    assert client.post(path, json={"csrf_token": TOKEN}).status_code == 403


@pytest.mark.parametrize("origin", ["http://evil.example", "null", "http://127.0.0.1:9999"])
def test_post_from_foreign_origin_is_forbidden(origin):
    start_run = FakeStartRun()
    response = make_client(start_run=start_run).post(
        "/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад", "max_companies": "5"},
        headers={"Origin": origin})
    assert response.status_code == 403
    assert start_run.calls == []


def test_start_run_calls_injected_function_and_redirects():
    start_run = FakeStartRun(result=42)
    response = make_client(start_run=start_run).post(
        "/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "  оборотная тара ", "max_companies": "5"},
        headers={"Origin": BASE_URL}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == "/?run=42"
    assert start_run.calls == [("almaty", "оборотная тара", 5)]


def test_security_headers_and_no_api_docs():
    client = make_client()
    response = client.get("/static/app.css")
    assert response.status_code == 200
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["x-content-type-options"] == "nosniff"
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404
    error_page = client.get("/docs")
    assert error_page.headers["cache-control"] == "no-store"
    assert "camera=()" in error_page.headers["permissions-policy"]
    assert "cache-control" not in response.headers


def test_database_error_page_hides_details():
    def broken_connect():
        raise psycopg.OperationalError('connection to server at "127.0.0.1" failed: password=secret-value')

    client = make_client(connect=broken_connect)
    page = client.get("/")
    assert page.status_code == 503
    assert "secret-value" not in page.text and "Docker" in page.text
    api = client.get("/api/runs/1")
    assert api.status_code == 503 and "secret-value" not in api.text
    post = client.post("/drafts/1/approve", data={"csrf_token": TOKEN})
    assert post.status_code == 503 and "secret-value" not in post.text


def test_templates_and_scripts_never_bypass_escaping():
    templates = "".join(p.read_text(encoding="utf-8") for p in (WEB_DIR / "templates").glob("*.html"))
    script = (WEB_DIR / "static" / "app.js").read_text(encoding="utf-8")
    assert "|safe" not in templates.replace(" ", "") and "autoescape false" not in templates
    assert not re.search(r"\.(innerHTML|outerHTML|insertAdjacentHTML)\b|document\.write", script)


def test_pages_load_nothing_from_outside():
    """Владелец держит всё в папке проекта: ни CDN, ни шрифтов, ни чужих скриптов."""
    sources = [*(WEB_DIR / "templates").glob("*.html"), *(WEB_DIR / "static").glob("*")]
    for path in sources:
        text = path.read_text(encoding="utf-8")
        assert not re.search(r"""(src|href)=["']?(https?:)?//""", text), path.name
        assert "@import" not in text and not re.search(r"url\(['\"]?(https?:)?//", text), path.name


# ---------- с базой ----------


@pytest.fixture
def web_db(db_conn):
    """Временная схема с таблицами и connect, который открывает новые соединения в ту же схему."""
    db.migrate(db_conn)
    schema = db_conn.execute("SELECT current_schema()").fetchone()[0]
    dsn = os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"]
    opened: list[psycopg.Connection] = []

    def connect() -> psycopg.Connection:
        conn = psycopg.connect(dsn, autocommit=True, connect_timeout=5, options=f"-c search_path={schema}")
        opened.append(conn)
        return conn

    yield db_conn, connect, opened
    for conn in opened:
        conn.close()


def seed_run(conn, *, query="склад", status="done", stage="draft", **counts) -> int:
    values = {"found": 0, "new_companies": 0, "crawled": 0, "qualified": 0, "rejected": 0,
              "verified": 0, "drafted": 0, "errors": 0, **counts}
    return conn.execute(
        "INSERT INTO runs (city, query, max_companies, status, stage, found, new_companies, crawled, qualified,"
        " rejected, verified, drafted, errors) VALUES ('almaty', %s, 5, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
        " RETURNING id",
        (query, status, stage, *values.values()),
    ).fetchone()[0]


def seed_company(conn, name, *, status="drafted", run_id=None, rubric="Складские услуги", site_text=None,
                 website="sklad.example.kz", last_error=None) -> int:
    return conn.execute(
        "INSERT INTO companies (name, city, rubric, address, phones, website, source_url, branches_count, site_text,"
        " status, last_error, run_id) VALUES (%s, 'almaty', %s, 'Алматы, ул. Рыскулова, 57', %s, %s,"
        " 'https://2gis.kz/almaty/firm/70000001', 3, %s, %s, %s, %s) RETURNING id",
        (name, rubric, ["+7 727 355 10 20"], website, site_text, status, last_error, run_id),
    ).fetchone()[0]


def seed_contact(conn, company_id, email, *, verify_result="safe", is_role=True) -> int:
    return conn.execute(
        "INSERT INTO contacts (company_id, email, source_page, verify_result, is_role) VALUES (%s, %s, %s, %s, %s)"
        " RETURNING id",
        (company_id, email, "https://sklad.example.kz/kontakty", verify_result, is_role),
    ).fetchone()[0]


def seed_draft(conn, company_id, contact_id, *, subject="Инвентаризация за часы", body="Здравствуйте!",
               checks=None, review_status="pending", sent=False) -> int:
    approved = review_status == "approved"
    now = datetime.now(UTC)
    return conn.execute(
        "INSERT INTO drafts (company_id, contact_id, subject, body, model, check_result, review_status,"
        " approved_by, approved_at, sent_at) VALUES (%s, %s, %s, %s, 'claude-haiku-5-5', %s, %s, %s, %s, %s)"
        " RETURNING id",
        (company_id, contact_id, subject, body, Jsonb(checks or []), review_status,
         "владелец" if approved else None, now if approved else None, now if sent else None),
    ).fetchone()[0]


def seed_llm_call(conn, model, *, run_id=None, company_id=None, input_tokens=0, output_tokens=0,
                  cache_read_tokens=0, cache_write_tokens=0) -> None:
    conn.execute(
        "INSERT INTO llm_calls (task, model, run_id, company_id, input_tokens, output_tokens, cache_read_tokens,"
        " cache_write_tokens) VALUES ('qualify', %s, %s, %s, %s, %s, %s, %s)",
        (model, run_id, company_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens),
    )


def full_company(conn, name="ТОО «Степь Склад»", **kwargs) -> tuple[int, int, int]:
    company_id = seed_company(conn, name, **kwargs)
    conn.execute(
        "INSERT INTO qualifications (company_id, fit, score, reason, segment, model)"
        " VALUES (%s, 'yes', 86, 'Склад на 12 000 паллетомест, инвентаризация вручную', 'склады', 'claude-haiku-5-5')",
        (company_id,),
    )
    contact_id = seed_contact(conn, company_id, f"info@c{company_id}.example.kz")
    body = "Здравствуйте!\n\nМы ставим RFID-метки на паллеты.\n[Проверить: число паллетомест с сайта]\n\nАрман"
    checks = [{"name": "dashes", "passed": False, "details": ["тире: «—» в «…метки — на…»"]},
              {"name": "prices", "passed": True, "details": []}]
    draft_id = seed_draft(conn, company_id, contact_id, body=body, checks=checks)
    return company_id, contact_id, draft_id


@pytest.mark.db
def test_search_page_shows_form_run_history_and_costs(web_db):
    conn, connect, opened = web_db
    finished = seed_run(conn, query="склад", found=10, new_companies=9, qualified=5, drafted=3)
    seed_llm_call(conn, "claude-haiku-5-5", run_id=finished, input_tokens=200_000, output_tokens=40_000)
    seed_llm_call(conn, "claude-sonnet-5-5", run_id=finished, input_tokens=10_000, output_tokens=1_000)
    page = make_client(connect).get("/")
    assert page.status_code == 200
    html = page.text
    assert "Найти компании" in html and 'name="csrf_token"' in html and TOKEN in html
    assert "Алматы" in html and "Усть-Каменогорск" in html
    assert "строительная компания" in html and "За 5 компаний около $0,02" in html
    assert "Примерно $0,003 за компанию, плюс около $0,002 на первый запуск за 5 минут." in html
    assert f"Запуск №{finished}" in html and f"/companies?run={finished}" in html
    assert "≈ $0,0700" in html  # 0,04 Haiku + 0,03 Sonnet, и в шапке, и в истории
    assert "251 000 токенов" in html
    assert all(c.closed for c in opened) and opened


@pytest.mark.db
def test_active_run_disables_button_and_polls(web_db):
    conn, connect, _ = web_db
    run_id = seed_run(conn, query="логистика", status="running", stage="qualify", found=4, crawled=3)
    html = make_client(connect).get("/").text
    assert f'data-run-id="{run_id}"' in html and 'data-finished="false"' in html
    assert 'id="start-button" disabled' in html and f"Идёт запуск №{run_id}" in html
    assert 'data-stage="qualify" data-state="current"' in html


@pytest.mark.db
def test_companies_page_filters_and_labels(web_db):
    conn, connect, _ = web_db
    run_a = seed_run(conn, query="склад")
    run_b = seed_run(conn, query="одежда")
    full_company(conn, "ТОО «Степь Склад»", run_id=run_a)
    seed_company(conn, "ТОО «Береке Продукт»", status="rejected", run_id=run_a, rubric="Продукты питания")
    seed_company(conn, "ТОО «Kaz Textile»", status="approved", run_id=run_b, rubric="Магазин одежды")
    seed_company(conn, "ТОО «Нур_Авто»", status="new", run_id=run_b, rubric="Автозапчасти")
    client = make_client(connect)

    html = client.get("/companies").text
    for label in ("Письмо готово", "Не подходит", "Одобрено", "Найдена", "1–4 из 4"):
        assert label in html
    assert "info@" in html and "Существует" in html and "не прошло 1 из 2" in html

    drafted = client.get("/companies", params={"status": "drafted"}).text
    assert "Степь Склад" in drafted and "Береке" not in drafted and "Kaz Textile" not in drafted
    by_run = client.get("/companies", params={"run": run_b}).text
    assert "Kaz Textile" in by_run and "Степь Склад" not in by_run
    assert f"Запуск №{run_b}: Алматы, «одежда»" in by_run
    by_text = client.get("/companies", params={"q": "одежд"}).text
    assert "Kaz Textile" in by_text and "Нур" not in by_text
    wildcard = client.get("/companies", params={"q": "_"}).text
    assert "Нур_Авто" in wildcard and "Береке" not in wildcard
    for odd in ({"status": "<script>", "run": "abc", "page": "-1"}, {"page": "²", "run": "٣"}):
        assert client.get("/companies", params=odd).status_code == 200
    beyond = client.get("/companies", params={"page": "9"}).text
    assert "1–4 из 4" in beyond and "Степь Склад" in beyond
    combined = client.get("/companies", params={"status": "approved", "q": "Kaz"}).text
    assert "1–1 из 1" in combined and "Нур" not in combined


@pytest.mark.db
def test_companies_page_has_fifty_rows_per_page(web_db):
    conn, connect, _ = web_db
    for index in range(55):
        seed_company(conn, f"ТОО «Компания {index:02d}»", status="new", website=None)
    client = make_client(connect)
    first = client.get("/companies").text
    assert "1–50 из 55" in first and "Компания 54" in first and "Компания 04" not in first
    second = client.get("/companies", params={"page": "2"}).text
    assert "51–55 из 55" in second and "Компания 00" in second


@pytest.mark.db
def test_company_page_shows_card_reason_emails_and_letter(web_db):
    conn, connect, _ = web_db
    company_id, _, draft_id = full_company(conn, site_text="Склад класса А, ответственное хранение.")
    seed_llm_call(conn, "claude-haiku-5-5", company_id=company_id, input_tokens=200_000, output_tokens=40_000)
    html = make_client(connect).get(f"/companies/{company_id}").text
    assert "ТОО «Степь Склад»" in html and "Карточка 2ГИС" in html and "Алматы, ул. Рыскулова, 57" in html
    assert 'href="https://sklad.example.kz" rel="noopener noreferrer"' in html
    assert 'href="https://2gis.kz/almaty/firm/70000001" rel="noopener noreferrer"' in html
    assert "Склад на 12 000 паллетомест" in html and "86<small>/100</small>" in html
    assert "Существует" in html and "общий ящик" in html
    assert "Инвентаризация за часы" in html and 'class="line note"' in html
    assert "не прошло 1 из 2" in html and "тире: «—»" in html
    assert f'action="/drafts/{draft_id}/approve"' in html and "Отправка писем пока выключена" in html
    assert html.count('method="post"') == html.count('name="csrf_token"') == 2
    assert f'href="/letters/{draft_id}#letter"' in html and "Открыть в очереди писем" in html
    assert "<details class=\"site-text\">" in html and "Склад класса А" in html
    assert "≈ $0,0400" in html


@pytest.mark.db
def test_untrusted_text_is_escaped(web_db):
    conn, connect, _ = web_db
    company_id = seed_company(conn, "ТОО <i>Курсив</i>", site_text="<script>alert('site')</script>",
                              website="javascript:alert(1)", last_error="<img src=x onerror=alert(2)>")
    conn.execute(
        "INSERT INTO qualifications (company_id, fit, score, reason, model)"
        " VALUES (%s, 'maybe', 50, '<img src=x onerror=alert(3)>', 'claude-haiku-5-5')", (company_id,))
    contact_id = seed_contact(conn, company_id, "info@evil.example.kz")
    seed_draft(conn, company_id, contact_id, subject="<b>Тема</b>", body="<script>alert('body')</script>\n[Проверить: <u>x</u>]",
               checks=[{"name": "<s>x</s>", "passed": False, "details": ["<em>деталь</em>"]}])
    client = make_client(connect)
    html = client.get(f"/companies/{company_id}").text
    for raw in ("<script>alert", "<img src=x", "<i>Курсив", "<b>Тема", "<u>x</u>", "<s>x</s>", "<em>деталь",
                'href="javascript:'):
        assert raw not in html
    for escaped in ("&lt;script&gt;alert(", "&lt;img src=x onerror=alert(3)&gt;", "&lt;i&gt;Курсив&lt;/i&gt;",
                    "&lt;b&gt;Тема&lt;/b&gt;", "&lt;em&gt;деталь&lt;/em&gt;"):
        assert escaped in html
    listing = client.get("/companies").text
    assert "<i>Курсив" not in listing and "&lt;i&gt;Курсив" in listing


@pytest.mark.db
def test_unknown_company_and_run_are_404(web_db):
    _, connect, opened = web_db
    client = make_client(connect)
    huge = "9" * 30
    assert client.get("/companies/999999").status_code == 404
    assert client.get("/companies/abc").status_code == 404
    assert client.get(f"/companies/{huge}").status_code == 404
    response = client.get("/api/runs/999999")
    assert response.status_code == 404 and response.json() == {"detail": "Запуск не найден."}
    assert client.get(f"/api/runs/{huge}").status_code == 404
    assert client.get("/api/runs/active").status_code == 404
    assert client.post(f"/drafts/{huge}/approve", data={"csrf_token": TOKEN}).status_code == 404
    assert opened and all(conn.closed for conn in opened)


@pytest.mark.db
@pytest.mark.parametrize(("error", "status_code", "message"), [
    (pipeline.RunAlreadyActive("Уже идёт другой запуск, дождитесь его окончания"), 409, "Уже идёт другой запуск"),
    (ValueError("Неизвестный город: mars"), 400, "Неизвестный город: mars"),
])
def test_start_run_errors_rerender_form(web_db, error, status_code, message):
    _, connect, _ = web_db
    start_run = FakeStartRun(error=error)
    response = make_client(connect, start_run).post(
        "/runs", data={"csrf_token": TOKEN, "city": "astana", "query": "логистика", "max_companies": "3"})
    assert response.status_code == status_code
    assert message in response.text
    assert 'value="логистика"' in response.text and 'value="astana" selected' in response.text
    assert start_run.calls == [("astana", "логистика", 3)]


@pytest.mark.db
@pytest.mark.parametrize("count", ["abc", "", "-1", "99999999999999999999", "²"])
def test_start_run_rejects_bad_count_without_starting(web_db, count):
    _, connect, _ = web_db
    start_run = FakeStartRun()
    response = make_client(connect, start_run).post(
        "/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад", "max_companies": count})
    assert response.status_code == 400
    assert "Число компаний должно быть от 1 до" in response.text
    assert start_run.calls == []


@pytest.mark.db
def test_real_create_run_validation_reaches_the_page(web_db):
    """Сообщения pipeline.create_run показываются владельцу как есть."""
    conn, connect, _ = web_db

    def start_run(city, query, n):
        return pipeline.create_run(conn, city, query, n)

    client = make_client(connect, start_run)
    too_many = client.post("/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад",
                                          "max_companies": str(pipeline.MAX_COMPANIES_LIMIT + 1)})
    assert too_many.status_code == 400 and "Число компаний должно быть от 1 до 20" in too_many.text
    first = client.post("/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад",
                                       "max_companies": "2"}, follow_redirects=False)
    assert first.status_code == 303
    second = client.post("/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад",
                                        "max_companies": "2"})
    assert second.status_code == 409 and "Уже идёт другой запуск" in second.text


@pytest.mark.db
def test_approve_marks_draft_and_company(web_db):
    conn, connect, _ = web_db
    company_id, _, draft_id = full_company(conn)
    client = make_client(connect)
    response = client.post(f"/drafts/{draft_id}/approve", data={"csrf_token": TOKEN}, follow_redirects=False)
    assert response.status_code == 303
    assert response.headers["location"] == f"/companies/{company_id}?done=approved"
    draft = conn.execute("SELECT review_status, approved_by FROM drafts WHERE id = %s", (draft_id,)).fetchone()
    assert draft == ("approved", "владелец")
    assert conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == "approved"
    page = client.get(response.headers["location"]).text
    assert "Письмо одобрено. Отправка писем пока выключена." in page
    assert f'action="/drafts/{draft_id}/approve"' not in page


@pytest.mark.db
def test_reject_returns_company_to_verified(web_db):
    conn, connect, _ = web_db
    company_id, _, draft_id = full_company(conn)
    response = make_client(connect).post(f"/drafts/{draft_id}/reject", data={"csrf_token": TOKEN},
                                         follow_redirects=False)
    assert response.status_code == 303 and response.headers["location"].endswith("?done=rejected")
    assert conn.execute("SELECT review_status FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0] == "rejected"
    assert conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == "verified"


@pytest.mark.db
def test_edit_saves_text_and_reruns_checks(web_db, monkeypatch):
    conn, connect, _ = web_db
    company_id, _, draft_id = full_company(conn)
    seen = []

    def fake_checks(subject, body):
        seen.append((subject, body))
        return [{"name": "dashes", "passed": False, "details": ["тире: «—»"]},
                {"name": "style", "passed": True, "details": []}]

    monkeypatch.setattr(approve_step, "check_results_json", fake_checks)
    client = make_client(connect)
    response = client.post(f"/drafts/{draft_id}/edit", follow_redirects=False, data={
        "csrf_token": TOKEN, "subject": "  Новая   тема ", "body": "Здравствуйте!\r\n\r\nНовый текст — с тире.\r\n"})
    assert response.status_code == 303 and response.headers["location"] == f"/companies/{company_id}?done=saved"
    assert seen == [("Новая тема", "Здравствуйте!\n\nНовый текст — с тире.")]
    subject, body, checks, review = conn.execute(
        "SELECT subject, body, check_result, review_status FROM drafts WHERE id = %s", (draft_id,)).fetchone()
    assert (subject, body, review) == ("Новая тема", "Здравствуйте!\n\nНовый текст — с тире.", "pending")
    assert checks[0]["passed"] is False
    page = client.get(response.headers["location"]).text
    assert "Изменения сохранены, проверки пройдены заново." in page and "не прошло 1 из 2" in page


@pytest.mark.db
def test_edit_with_empty_subject_is_refused(web_db, monkeypatch):
    conn, connect, _ = web_db
    _, _, draft_id = full_company(conn)
    monkeypatch.setattr(approve_step, "check_results_json", lambda subject, body: pytest.fail("проверки не нужны"))
    response = make_client(connect).post(f"/drafts/{draft_id}/edit",
                                         data={"csrf_token": TOKEN, "subject": "   ", "body": "Текст <b>правки</b>"})
    assert response.status_code == 400
    assert "Тема и текст письма не должны быть пустыми." in response.text
    assert "Текст &lt;b&gt;правки&lt;/b&gt;" in response.text and 'id="edit"' in response.text
    assert conn.execute("SELECT subject FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0] == "Инвентаризация за часы"


@pytest.mark.db
def test_rejected_draft_cannot_be_approved_or_edited(web_db, monkeypatch):
    conn, connect, opened = web_db
    company_id, _, draft_id = full_company(conn)
    monkeypatch.setattr(approve_step, "check_results_json", lambda subject, body: [])
    client = make_client(connect)
    assert client.post(f"/drafts/{draft_id}/reject", data={"csrf_token": TOKEN}).status_code == 200
    approve = client.post(f"/drafts/{draft_id}/approve", data={"csrf_token": TOKEN})
    assert approve.status_code == 409 and "Письмо уже отклонено" in approve.text
    edit = client.post(f"/drafts/{draft_id}/edit", data={"csrf_token": TOKEN, "subject": "Тема", "body": "Текст"})
    assert edit.status_code == 409
    assert conn.execute("SELECT review_status FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0] == "rejected"
    assert conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == "verified"
    assert all(c.closed for c in opened)


@pytest.mark.db
def test_stored_errors_are_redacted_on_pages(web_db):
    conn, connect, _ = web_db
    run_id = seed_run(conn, status="failed", stage="Сайты")
    conn.execute("UPDATE runs SET error = %s WHERE id = %s", ("APIError: key sk-ant-api03-SECRET1 rejected", run_id))
    company_id = seed_company(conn, "ТОО «Ошибка»", last_error="OperationalError postgresql://u:SECRET2@h/db")
    client = make_client(connect)
    assert "SECRET1" not in client.get(f"/api/runs/{run_id}").text
    assert "SECRET1" not in client.get("/", params={"run": run_id}).text
    page = client.get(f"/companies/{company_id}").text
    assert "SECRET2" not in page and "[скрыто]" in page


@pytest.mark.db
def test_review_of_missing_or_sent_draft_is_404(web_db):
    conn, connect, _ = web_db
    company_id = seed_company(conn, "ТОО «Отправлено»", status="sent")
    contact_id = seed_contact(conn, company_id, "info@sent.example.kz")
    sent_id = seed_draft(conn, company_id, contact_id, review_status="approved", sent=True)
    client = make_client(connect)
    assert client.post("/drafts/999999/approve", data={"csrf_token": TOKEN}).status_code == 404
    assert client.post(f"/drafts/{sent_id}/reject", data={"csrf_token": TOKEN}).status_code == 409
    assert conn.execute("SELECT review_status FROM drafts WHERE id = %s", (sent_id,)).fetchone()[0] == "approved"


@pytest.mark.db
def test_api_run_json_with_cost_and_stages(web_db):
    conn, connect, _ = web_db
    run_id = seed_run(conn, query="тара", status="running", stage="crawl", found=6, new_companies=5, crawled=2)
    seed_llm_call(conn, "claude-haiku-5-5", run_id=run_id, input_tokens=200_000, output_tokens=40_000)
    seed_llm_call(conn, "claude-unknown", run_id=run_id, input_tokens=500)
    client = make_client(connect)
    data = client.get(f"/api/runs/{run_id}").json()
    assert data["id"] == run_id and data["query"] == "тара" and data["found"] == 6 and data["crawled"] == 2
    assert data["status"] == "running" and data["status_label"] == "Идёт" and data["finished"] is False
    assert [s["state"] for s in data["stages"]] == ["done", "current", "pending", "pending", "pending"]
    assert data["cost"] == {"tokens": 240_500, "usd": pytest.approx(0.04), "priced": False,
                            "text": "≈ $0,0400 + 500 токенов без цены"}
    assert data["created_at"].startswith(str(datetime.now(UTC).year))
    active = client.get("/api/runs/active")
    assert active.status_code == 200 and active.json()["id"] == run_id
    assert active.headers["cache-control"] == "no-store"


# ---------- очередь писем ----------


def test_split_letter_takes_leading_notes_out_of_client_text():
    body = ("[Проверить: число паллет с сайта]\n\n[Ответить лично: имя из 2ГИС]\nЗдравствуйте!\n\n"
            "Текст.\n[Проверить: заметка посреди письма]\n\nАрман\n\n")
    notes, lines = fmt.split_letter(body)
    assert notes == [{"kind": "Проверить", "text": "число паллет с сайта"},
                     {"kind": "Ответить лично", "text": "имя из 2ГИС"}]
    assert [line["text"] for line in lines] == ["Здравствуйте!", "", "Текст.", "[Проверить: заметка посреди письма]",
                                               "", "Арман"]
    assert [line["note"] for line in lines] == [False, False, False, True, False, False]
    assert fmt.split_letter("Здравствуйте!") == ([], [{"text": "Здравствуйте!", "note": False}])


def test_letters_url_keeps_filter_and_anchor():
    assert fmt.letters_url() == "/letters"
    assert fmt.letters_url(5, status="pending", run_id=3, done="approved") == (
        "/letters/5?status=pending&run=3&done=approved#letter")
    assert fmt.letters_url(status="all", run_id=2) == "/letters?status=all&run=2"
    assert fmt.letters_url(5, status="pending", edit=True) == "/letters/5?status=pending&edit=1#letter"


def queue_letter(conn, name, *, run_id=None, review_status="pending", body=None, checks=None) -> int:
    company_id = seed_company(conn, name, run_id=run_id)
    conn.execute(
        "INSERT INTO qualifications (company_id, fit, score, reason, segment, model)"
        " VALUES (%s, 'yes', 80, 'Склад и тара', 'логистика', 'claude-haiku-5-5')", (company_id,))
    contact_id = seed_contact(conn, company_id, f"info@q{company_id}.example.kz")
    return seed_draft(conn, company_id, contact_id, subject=f"Тема для {name}", body=body or "Здравствуйте!",
                      checks=checks, review_status=review_status)


def queue_post(client, draft_id, action, **fields):
    data = {"csrf_token": TOKEN, "back": "letters", **fields}
    return client.post(f"/drafts/{draft_id}/{action}", data=data, follow_redirects=False)


@pytest.mark.db
def test_letters_queue_shows_pending_oldest_first_and_opens_first(web_db):
    conn, connect, opened = web_db
    first = queue_letter(conn, "ТОО «Первая»")
    second = queue_letter(conn, "ТОО «Вторая»")
    queue_letter(conn, "ТОО «Одобренная»", review_status="approved")
    page = make_client(connect).get("/letters")
    assert page.status_code == 200
    html = page.text
    assert html.index("ТОО «Первая»") < html.index("ТОО «Вторая»")
    assert "Одобренная" not in html.split('id="letter"')[0]
    assert f'href="/letters/{first}?status=pending#letter" aria-current="true"' in html
    assert f'action="/drafts/{first}/approve"' in html and f'action="/drafts/{second}/approve"' not in html
    assert 'Ждут проверки <span class="num">2</span>' in html and 'Одобрены <span class="num">1</span>' in html
    assert 'data-letters-badge title="Ждут проверки">2</span>' in html
    assert "Карточка компании" in html and "Открыть в 2ГИС" in html and "Склад и тара" in html
    assert all(c.closed for c in opened)


@pytest.mark.db
def test_letter_shows_notes_apart_from_text_and_escapes_everything(web_db):
    conn, connect, _ = web_db
    body = "[Проверить: <b>число</b> паллет]\n[Ответить лично: <script>x</script>]\nЗдравствуйте, <i>друзья</i>!\n\nАрман"
    checks = [{"name": "contacts", "passed": False, "details": ["чужой номер <u>+7 700</u>"]},
              {"name": "dashes", "passed": True, "details": []}]
    draft_id = queue_letter(conn, "ТОО <s>Тест</s>", body=body, checks=checks)
    html = make_client(connect).get(f"/letters/{draft_id}").text
    notes_box = html.split("Заметки для вас", 1)[1].split("data-letter-body", 1)[0]
    assert "&lt;b&gt;число&lt;/b&gt; паллет" in notes_box and "&lt;script&gt;x&lt;/script&gt;" in notes_box
    letter_text = html.split("data-letter-body", 1)[1].split("</div>", 1)[0]
    assert "Проверить:" not in letter_text and "Здравствуйте, &lt;i&gt;друзья&lt;/i&gt;!" in letter_text
    assert "Только наш номер WhatsApp" in html and "чужой номер &lt;u&gt;+7 700&lt;/u&gt;" in html
    for raw in ("<b>число", "<script>x", "<i>друзья", "<s>Тест", "<u>+7"):
        assert raw not in html
    assert "data-copy-letter hidden" in html


@pytest.mark.db
def test_approve_and_reject_in_queue_go_to_next_pending_then_empty_state(web_db):
    conn, connect, _ = web_db
    a, b, c = (queue_letter(conn, f"ТОО «{name}»") for name in ("А", "Б", "В"))
    client = make_client(connect)
    response = queue_post(client, b, "approve", status="pending")
    assert response.status_code == 303
    assert response.headers["location"] == f"/letters/{c}?status=pending&done=approved#letter"
    response = queue_post(client, c, "reject", status="pending")
    assert response.headers["location"] == f"/letters/{a}?status=pending&done=rejected#letter"  # дальше нет: с начала
    response = queue_post(client, a, "approve", status="approved")  # из «Одобрены» дальше идёт очередь «Ждут»
    assert response.headers["location"] == "/letters?status=pending&done=approved"
    page = client.get(response.headers["location"]).text
    assert "Все письма проверены" in page and "Письмо одобрено. Отправка писем пока выключена." in page
    assert 'href="/"' in page and "Одобренные (2)" in page
    statuses = dict(conn.execute("SELECT id, review_status FROM drafts").fetchall())
    assert statuses == {a: "approved", b: "approved", c: "rejected"}


@pytest.mark.db
def test_queue_run_filter_limits_list_and_next_letter(web_db):
    conn, connect, _ = web_db
    run_a = seed_run(conn, query="склад")
    run_b = seed_run(conn, query="тара")
    a1 = queue_letter(conn, "ТОО «Склад 1»", run_id=run_a)
    queue_letter(conn, "ТОО «Тара 1»", run_id=run_b)
    a2 = queue_letter(conn, "ТОО «Склад 2»", run_id=run_a)
    client = make_client(connect)
    html = client.get("/letters", params={"run": run_a}).text
    assert "Склад 1" in html and "Склад 2" in html and "Тара 1" not in html
    assert f"Запуск №{run_a}: Алматы, «склад»." in html
    response = queue_post(client, a1, "approve", status="pending", run=str(run_a))
    assert response.headers["location"] == f"/letters/{a2}?status=pending&run={run_a}&done=approved#letter"
    response = queue_post(client, a2, "approve", status="pending", run=str(run_a))
    assert response.headers["location"] == f"/letters?status=pending&run={run_a}&done=approved"


@pytest.mark.db
def test_queue_filters_and_letter_opens_in_its_own_filter(web_db):
    conn, connect, _ = web_db
    queue_letter(conn, "ТОО «Ждёт»")
    approved = queue_letter(conn, "ТОО «Одобрена»", review_status="approved")
    rejected = queue_letter(conn, "ТОО «Отклонена»", review_status="rejected")
    client = make_client(connect)
    only_approved = client.get("/letters", params={"status": "approved"}).text
    assert "ТОО «Одобрена»" in only_approved and "ТОО «Ждёт»" not in only_approved
    assert f'action="/drafts/{approved}/approve"' not in only_approved  # уже одобрено
    assert f'action="/drafts/{approved}/reject"' in only_approved
    everything = client.get("/letters", params={"status": "all"}).text
    assert everything.index("ТОО «Ждёт»") < everything.index("ТОО «Одобрена»")
    assert "Ждёт" in client.get("/letters", params={"status": "<script>"}).text
    opened = client.get(f"/letters/{rejected}").text
    assert 'href="/letters?status=rejected" aria-current="true"' in opened
    assert "Письмо отклонено. Новый черновик напишет следующий запуск." in opened
    assert f'action="/drafts/{rejected}/approve"' not in opened
    assert client.get("/letters/999999").status_code == 404
    assert client.get(f"/letters/{'9' * 30}").status_code == 404
    empty = client.get("/letters", params={"status": "rejected", "run": "999"}).text
    assert "Здесь пока пусто" in empty


@pytest.mark.db
def test_edit_in_queue_stays_on_letter(web_db, monkeypatch):
    conn, connect, _ = web_db
    draft_id = queue_letter(conn, "ТОО «Правка»")
    monkeypatch.setattr(approve_step, "check_results_json",
                        lambda subject, body: [{"name": "contacts", "passed": True, "details": []}])
    client = make_client(connect)
    form = client.get(f"/letters/{draft_id}", params={"edit": "1", "status": "pending"}).text
    assert 'id="edit"' in form and 'name="back" value="letters"' in form
    assert f'action="/drafts/{draft_id}/approve"' not in form  # пока правка не сохранена
    response = queue_post(client, draft_id, "edit", status="pending", subject="Новая тема", body="Текст правки")
    assert response.headers["location"] == f"/letters/{draft_id}?status=pending&done=saved#letter"
    page = client.get(response.headers["location"]).text
    assert "Новая тема" in page and "Изменения сохранены" in page and "все 1 пройдены" in page
    error = queue_post(client, draft_id, "edit", status="pending", subject="", body="x")
    assert error.status_code == 400 and "Тема и текст письма не должны быть пустыми." in error.text
    assert 'id="edit"' in error.text and "<h1>Письма</h1>" in error.text


@pytest.mark.db
def test_company_rows_link_to_company_and_letter(web_db):
    conn, connect, _ = web_db
    company_id, _, draft_id = full_company(conn)
    plain = seed_company(conn, "ТОО «Без письма»", status="new")
    html = make_client(connect).get("/companies").text
    assert f'href="/letters/{draft_id}#letter"' in html and "Инвентаризация за часы" in html
    assert html.count(f'href="/companies/{company_id}"') == 4  # название, город, оценка, почта
    assert html.count(f'href="/companies/{plain}"') == 6  # без письма и статус, и «Нет» ведут в карточку
    row = html.split(f'href="/companies/{company_id}"', 1)[1].split("</tr>", 1)[0]
    assert row.count(f'href="/letters/{draft_id}#letter"') == 2  # статус «Письмо готово» и колонка «Письмо»
    assert 'tabindex="-1"' in row


@pytest.mark.db
def test_search_page_offers_review_of_finished_run(web_db):
    conn, connect, _ = web_db
    run_id = seed_run(conn, query="склад", drafted=2)
    queue_letter(conn, "ТОО «Ждёт»", run_id=run_id)
    queue_letter(conn, "ТОО «Уже одобрена»", run_id=run_id, review_status="approved")
    client = make_client(connect)
    html = client.get("/").text
    assert (f'href="/letters?run={run_id}" data-run-review><span>Проверить письма '
            '(<span data-run-count="letters_pending">1</span>)</span>') in html
    assert f'href="/letters?status=all&amp;run={run_id}"' in html
    data = client.get(f"/api/runs/{run_id}").json()
    assert (data["letters_pending"], data["pending_total"], data["show_review"]) == (1, 1, True)
    conn.execute("UPDATE drafts SET review_status = 'approved', approved_by = 'владелец', approved_at = now()")
    assert client.get(f"/api/runs/{run_id}").json()["show_review"] is False
    assert "data-run-review hidden" in client.get("/").text


@pytest.mark.db
def test_budget_exceeded_is_shown_on_the_form(web_db):
    _, connect, _ = web_db
    error = pipeline.BudgetExceeded("Дневной лимит расходов на API $1.00 исчерпан: сегодня потрачено $1.02.")
    response = make_client(connect, FakeStartRun(error=error)).post(
        "/runs", data={"csrf_token": TOKEN, "city": "almaty", "query": "склад", "max_companies": "5"})
    assert response.status_code == 400
    assert "Дневной лимит расходов на API $1.00 исчерпан" in response.text and 'class="notice neg"' in response.text
