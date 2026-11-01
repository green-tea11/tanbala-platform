"""Проверка новой компании по запросу WhatsApp-бота: 2ГИС и сайт на моках, Claude подменён. 0 токенов."""

import dataclasses
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from tanbala_leads import db, pipeline
from tanbala_leads.internal import research
from tanbala_leads.settings import load_settings
from tanbala_leads.sites import PageText, SiteCrawl
from tanbala_leads.web import create_app

FIXTURE = Path(__file__).parent / "fixtures" / "2gis-almaty-sklad.json"
TOKEN = "t" * 40
AUTH = {"X-Internal-Token": TOKEN}
QUALIFY = {"fit": "yes", "score": 75, "segment": "Склад, логистика, дистрибуция", "reason": "Склад и филиалы.",
           "pains": [{"pain": "Инвентаризация занимает дни и отрывает людей",
                      "evidence": "Складское хранение и логистика", "source": "site"}]}


class FakeClient:
    """Отвечает как Claude на квалификацию. Письма в проверке из WhatsApp не пишутся: другая схема — ошибка теста."""

    def __init__(self):
        self.calls = []
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        assert "fit" in kwargs["output_config"]["format"]["schema"]["properties"], "проверка не пишет писем"
        self.calls.append(kwargs)
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=9000,
                                cache_creation_input_tokens=0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(QUALIFY, ensure_ascii=False))],
                               stop_reason="end_turn", usage=usage, model="claude-haiku-5-5")


class FakeParser:
    """Вместо parser-2gis: кладёт образец выдачи (или пустую выдачу) и запоминает ссылки."""

    def __init__(self, fixture: Path | None = FIXTURE, error: Exception | None = None):
        self.fixture = fixture
        self.error = error
        self.urls: list[str] = []

    def __call__(self, url, out, max_records):
        self.urls.append(url)
        if self.error:
            raise self.error
        out.parent.mkdir(parents=True, exist_ok=True)
        if self.fixture is None:
            out.write_text("[]", encoding="utf-8")
        else:
            shutil.copy(self.fixture, out)
        return out


def fake_site(url: str) -> SiteCrawl:
    return SiteCrawl(start_url=url, pages=(PageText(url=url, text="Складское хранение и логистика."),),
                     emails=frozenset({"sales@aksengerterminal.kz"}), error=None)


def no_email_check(email):
    raise AssertionError("проверка из WhatsApp не проверяет почты")


def make_deps(tmp_path, parser=None, client=None) -> pipeline.Deps:
    return pipeline.Deps(run_parser=parser or FakeParser(), crawl=fake_site, check_email=no_email_check,
                         client=client or FakeClient(), owner_doc="Документ о Tanbala",
                         settings=load_settings({}), exports_dir=tmp_path / "2gis", log_path=tmp_path / "llm.jsonl")


@pytest.fixture
def env(db_conn, tmp_path):
    """Схема с таблицами, connect в неё и фабрика клиента API с очередью проверок."""
    db.migrate(db_conn)
    schema = db_conn.execute("SELECT current_schema()").fetchone()[0]
    dsn = make_conninfo(os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"],
                        options=f"-c search_path={schema}")

    def connect() -> psycopg.Connection:
        return psycopg.connect(dsn, autocommit=True, connect_timeout=5)

    def client(*, deps=None, per_day=20, budget_usd=1.0, inline=True):
        deps = deps or make_deps(tmp_path)
        queue = research.ResearchQueue(connect, lambda: deps, per_day=per_day, budget_usd=budget_usd, inline=inline)
        app = create_app(connect, lambda *args: 1, csrf_token="csrf", internal_token=TOKEN, research_queue=queue)
        return TestClient(app, base_url="http://127.0.0.1"), deps, queue

    return SimpleNamespace(conn=db_conn, dsn=dsn, connect=connect, client=client, tmp_path=tmp_path)


def post(client, body, status_code=202):
    response = client.post("/internal/research", json=body, headers=AUTH)
    assert response.status_code == status_code, response.text
    return response.json()


def status(client, job_id):
    response = client.get(f"/internal/research/{job_id}", headers=AUTH)
    assert response.status_code == 200
    return response.json()


def add_company(conn, name, *, status="qualified", phones=(), domain=None) -> int:
    return conn.execute("INSERT INTO companies (name, city, status, phones, website_domain)"
                        " VALUES (%s, 'Алматы', %s, %s, %s) RETURNING id",
                        (name, status, list(phones), domain)).fetchone()[0]


def add_qualification(conn, company_id) -> None:
    conn.execute("INSERT INTO qualifications (company_id, fit, score, reason, model, pains)"
                 " VALUES (%s, 'maybe', 40, 'Есть склад.', 'claude-haiku-5-5', %s)", (company_id, Jsonb([])))


# ---------- без базы ----------


def make_client_without_db():
    queue = research.ResearchQueue(lambda: pytest.fail("нет базы"), lambda: pytest.fail("нет зависимостей"),
                                   per_day=20, budget_usd=1.0, inline=True)
    app = create_app(lambda: pytest.fail("нет базы"), lambda *args: 1, csrf_token="csrf", internal_token=TOKEN,
                     research_queue=queue)
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.mark.parametrize("body", [
    "", "not json", "[]", '"name"', "{}", '{"name": ""}', '{"name": 5}', '{"name": "ТОО"}',
    '{"name": "Платформа-А", "phone": "123"}', '{"name": "Платформа-А", "domain": "com.kz"}',
    '{"name": "Платформа-А", "city": 5}', '{"name": "Платформа-А", "city": "' + "x" * 101 + '"}',
    '{"name": "' + "a" * 5000 + '"}', '{"name": "Рахат\\u0000"}', '{"name": "Рахат", "phone": "7700\\u00001234567"}',
    '{"name": "Рахат\\ud800"}',
])
def test_bad_research_request_is_400_before_database(body):
    response = make_client_without_db().post("/internal/research", content=body.encode(),
                                             headers={**AUTH, "Content-Type": "application/json"})

    assert (response.status_code, response.json()) == (400, {"error": "bad_request"})


def test_body_that_is_not_utf8_is_400():
    response = make_client_without_db().post("/internal/research", content=b'{"name": "\xff"}',
                                             headers={**AUTH, "Content-Type": "application/json"})

    assert (response.status_code, response.json()) == (400, {"error": "bad_request"})


def test_research_without_token_is_401():
    client = make_client_without_db()

    assert client.post("/internal/research", json={"name": "Платформа-А"}).status_code == 401
    assert client.get(f"/internal/research/{uuid.uuid4()}").status_code == 401


@pytest.mark.parametrize(("city", "code"), [(None, "almaty"), ("", "almaty"), ("Астана", "astana"),
                                            ("АЛМАТЫ", "almaty"), ("ust_kamenogorsk", "ust_kamenogorsk"),
                                            ("Тараз", None)])
def test_city_is_russian_name_or_2gis_code(city, code):
    assert research.resolve_city(city) == code


# ---------- с базой ----------


@pytest.mark.db
def test_company_already_qualified_comes_back_at_once_and_keeps_its_letters(env):
    company_id = add_company(env.conn, "Платформа-А", domain="platforma.kz")
    add_qualification(env.conn, company_id)
    contact_id = env.conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@platforma.kz')"
                                  " RETURNING id", (company_id,)).fetchone()[0]
    env.conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Тема', 'Текст')",
                     (company_id, contact_id))
    client, deps, _ = env.client()

    assert post(client, {"name": "Другое имя", "domain": "ivan@platforma.kz"}, 200) == {
        "status": "done", "company_id": company_id}
    assert deps.run_parser.urls == [] and deps.client.calls == []
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 0
    # Уже известную компанию бот не убирает из рассылки: иначе любой собеседник закрыл бы её, назвав домен.
    assert env.conn.execute("SELECT requested_via FROM companies").fetchone()[0] is None
    assert env.conn.execute("SELECT review_status FROM drafts").fetchone()[0] == "pending"


@pytest.mark.db
def test_new_company_is_found_in_2gis_crawled_and_qualified_without_letters(env):
    client, deps, _ = env.client()

    job_id = post(client, {"name": "ТОО «Аксенгер»", "city": None, "phone": None, "domain": None})["job_id"]
    result = status(client, job_id)

    assert result["status"] == "done" and result["reason"] is None
    company_id = result["company_id"]
    assert result["brief"]["id"] == company_id and result["brief"]["fit"] == "yes"
    assert result["brief"]["pains"] == [{"pain": "Инвентаризация занимает дни и отрывает людей",
                                         "evidence": "Складское хранение и логистика", "source": "site"}]
    assert deps.run_parser.urls == ["https://2gis.kz/almaty/search/%D0%A2%D0%9E%D0%9E%20%C2%AB%D0%90%D0%BA%D1%81"
                                    "%D0%B5%D0%BD%D0%B3%D0%B5%D1%80%C2%BB"]
    row = env.conn.execute("SELECT name, source, requested_via, status FROM companies WHERE id = %s",
                           (company_id,)).fetchone()
    assert row == ("Аксенгер, многофункциональный логистический центр", "2gis", "whatsapp", "qualified")
    assert env.conn.execute("SELECT count(*) FROM companies").fetchone()[0] == 1
    assert env.conn.execute("SELECT count(*), min(task), count(run_id) FROM llm_calls").fetchone() == (1, "qualify", 0)
    assert env.conn.execute("SELECT count(*) FROM drafts").fetchone()[0] == 0
    assert env.conn.execute("SELECT count(*) FROM contacts WHERE verify_result IS NOT NULL").fetchone()[0] == 0


@pytest.mark.db
@pytest.mark.parametrize(("body", "expected"), [
    ({"name": "Совсем не так", "phone": "8 (777) 222-20-16"}, "Partner Express Logistic, офис"),
    ({"name": "Совсем не так", "domain": "https://www.kontainer.kz/"}, "Asklad, контейнерный склад"),
    ({"name": "Станица"}, "Станица, бизнес-парк"),
])
def test_2gis_card_is_chosen_by_phone_domain_or_name(env, body, expected):
    client, _, _ = env.client()

    company_id = status(client, post(client, body)["job_id"])["company_id"]

    assert env.conn.execute("SELECT name FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == expected


@pytest.mark.db
@pytest.mark.parametrize("fixture", [None, FIXTURE])
def test_company_not_in_2gis_fails_with_reason(env, fixture):
    client, deps, _ = env.client(deps=make_deps(env.tmp_path, parser=FakeParser(fixture)))

    result = status(client, post(client, {"name": "Несуществующая Зет"})["job_id"])

    assert result == {"status": "failed", "company_id": None, "brief": None, "reason": "not_in_2gis"}
    assert deps.client.calls == []


@pytest.mark.db
def test_unsupported_city_fails_and_does_not_use_the_daily_limit(env):
    client, deps, _ = env.client(per_day=1)

    result = status(client, post(client, {"name": "Аксенгер", "city": "Тараз"})["job_id"])
    assert result == {"status": "failed", "company_id": None, "brief": None, "reason": "city_unsupported"}
    assert deps.run_parser.urls == []

    post(client, {"name": "Аксенгер", "city": "Алматы"})


@pytest.mark.db
def test_other_city_is_searched_there(env):
    client, deps, _ = env.client()

    post(client, {"name": "Аксенгер", "city": "Астана"})

    assert deps.run_parser.urls[0].startswith("https://2gis.kz/astana/search/")


@pytest.mark.db
def test_known_company_without_assessment_skips_2gis(env):
    company_id = add_company(env.conn, "Zeta, склад", status="rejected", phones=["+77773131364"])
    client, deps, _ = env.client()

    result = status(client, post(client, {"name": "Zeta", "phone": "+7 777 313 13 64"})["job_id"])

    assert (result["status"], result["company_id"]) == ("done", company_id)
    assert deps.run_parser.urls == [] and len(deps.client.calls) == 1


@pytest.mark.db
@pytest.mark.parametrize(("body", "searched_2gis"), [
    ({"name": "Аксенгер", "phone": "+7 775 907 07 50"}, False),  # нашлась у нас по телефону: 2ГИС не нужен
    ({"name": "Аксенгер"}, True),  # у нас под другим названием: 2ГИС дал её же карточку (тот же 2ГИС id)
])
def test_research_does_not_take_existing_company_out_of_mailing(env, body, searched_2gis):
    """Пометку «запрошено из WhatsApp» ставит только компания, которую research сам добавил в базу."""
    company_id = env.conn.execute(
        "INSERT INTO companies (name, city, status, phones, source, source_id)"
        " VALUES ('МФЦ «АТ»', 'Алматы', 'crawled', %s, '2gis', '70000001105705309') RETURNING id",
        (["+77759070750"],)).fetchone()[0]
    env.conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@aksengerterminal.kz')",
                     (company_id,))
    client, deps, _ = env.client()

    result = status(client, post(client, body)["job_id"])

    assert (result["status"], result["company_id"]) == ("done", company_id)
    assert bool(deps.run_parser.urls) is searched_2gis
    assert env.conn.execute("SELECT count(*) FROM companies").fetchone()[0] == 1
    marks = env.conn.execute("SELECT requested_via, whatsapp_contacted_at, status FROM companies").fetchone()
    assert marks == (None, None, "qualified")
    # Следующий поиск возьмёт её проверить почту и написать письмо, как обычную компанию.
    assert pipeline._unfinished(env.conn, (), 10) == (company_id,)


@pytest.mark.db
def test_daily_limit_is_429(env):
    client, _, _ = env.client(per_day=1)
    post(client, {"name": "Аксенгер"})

    response = client.post("/internal/research", json={"name": "Станица"}, headers=AUTH)

    assert (response.status_code, response.json()) == (429, {"error": "rate_limited"})


@pytest.mark.db
def test_budget_is_429_before_job_and_failed_if_it_ran_out_in_queue(env):
    client, deps, _ = env.client(budget_usd=0.0)
    response = client.post("/internal/research", json={"name": "Аксенгер"}, headers=AUTH)
    assert (response.status_code, response.json()) == (429, {"error": "budget_exhausted"})

    request = research.parse_request({"name": "Аксенгер"})
    job_id = research.start(env.conn, request, per_day=20, budget_usd=1.0).job_id
    job = env.conn.execute("SELECT id, name, city, phone, domain, company_id FROM research_jobs").fetchone()
    research.run_job(env.conn, dict(zip(("id", "name", "city", "phone", "domain", "company_id"), job)), deps, 0.0)

    assert research.job_status(env.conn, job_id)["reason"] == "budget_exhausted"
    assert deps.run_parser.urls == []


@pytest.mark.db
def test_parser_failure_is_failed_error(env, caplog):
    from tanbala_leads.steps.collect import ParserError

    error = ParserError("Chrome упал на https://2gis.kz/almaty/search/Аксенгер")
    client, _, _ = env.client(deps=make_deps(env.tmp_path, parser=FakeParser(error=error)))

    result = status(client, post(client, {"name": "Аксенгер"})["job_id"])

    assert (result["status"], result["reason"]) == ("failed", "error")
    assert "Chrome упал" in env.conn.execute("SELECT error FROM research_jobs").fetchone()[0]
    # В лог сервера только номер задачи и вид ошибки: название компании от клиента бота туда не идёт.
    assert "ParserError" in caplog.text and "Аксенгер" not in caplog.text


@pytest.mark.db
@pytest.mark.parametrize("step", ["2gis", "site"])
def test_hung_browser_fails_job_and_keeps_company_new(env, step):
    """Браузер занят зависшим шагом поиска дольше предела: задача failed / error, оценки «без сайта» нет."""
    from tanbala_leads.browsers import BrowserBusy

    def busy(*args):
        raise BrowserBusy("Браузер занят дольше 22 мин")

    deps = make_deps(env.tmp_path, parser=busy if step == "2gis" else None)
    if step == "site":
        deps = dataclasses.replace(deps, crawl=busy)
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {"name": "Аксенгер"})["job_id"])

    assert (result["status"], result["reason"]) == ("failed", "error")
    assert deps.client.calls == []
    assert [s for (s,) in env.conn.execute("SELECT status FROM companies")] == ([] if step == "2gis" else ["new"])


@pytest.mark.db
@pytest.mark.parametrize("job_id", [str(uuid.uuid4()), "not-a-uuid", "1"])
def test_unknown_job_is_not_found(env, job_id):
    client, _, _ = env.client()

    assert status(client, job_id) == {"status": "not_found", "company_id": None, "brief": None, "reason": None}


@pytest.mark.db
def test_restart_fails_running_job_and_keeps_queue(env):
    running = research.start(env.conn, research.parse_request({"name": "Аксенгер"}), per_day=20,
                             budget_usd=1.0).job_id
    queued = research.start(env.conn, research.parse_request({"name": "Станица"}), per_day=20,
                            budget_usd=1.0).job_id
    env.conn.execute("UPDATE research_jobs SET status = 'running' WHERE id = %s", (running,))

    assert research.recover_stale_jobs(env.conn) == 1
    assert research.job_status(env.conn, running)["reason"] == "error"
    assert research.job_status(env.conn, queued)["status"] == "queued"


@pytest.mark.db
def test_background_queue_runs_jobs_one_by_one(env):
    client, deps, queue = env.client(inline=False)

    job_ids = [post(client, {"name": name})["job_id"] for name in ("Аксенгер", "Станица")]
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline and any(status(client, job_id)["status"] != "done" for job_id in job_ids):
        time.sleep(0.1)

    assert [status(client, job_id)["status"] for job_id in job_ids] == ["done", "done"]
    started = env.conn.execute("SELECT started_at, finished_at FROM research_jobs ORDER BY created_at").fetchall()
    assert started[0][1] <= started[1][0]


@pytest.mark.db
def test_later_search_run_does_not_write_to_whatsapp_company(env):
    client, _, _ = env.client()
    company_id = status(client, post(client, {"name": "Аксенгер"})["job_id"])["company_id"]

    run_id = pipeline.create_run(env.conn, "almaty", "склад", 4)
    deps = make_deps(env.tmp_path)
    pipeline.execute_run(env.dsn, run_id, pipeline.Deps(
        run_parser=deps.run_parser, crawl=fake_site, client=FakeLetters(),
        check_email=lambda email: research_check(email), owner_doc="Документ", settings=load_settings(
            {"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+77479597238"}),
        exports_dir=env.tmp_path / "2gis", log_path=env.tmp_path / "llm.jsonl"))

    assert env.conn.execute("SELECT status FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "done"
    assert env.conn.execute("SELECT count(*) FROM drafts WHERE company_id = %s", (company_id,)).fetchone()[0] == 0
    assert env.conn.execute("SELECT count(*) FROM drafts").fetchone()[0] == 3


def research_check(email):
    from tanbala_leads.steps import verify

    return verify.EmailCheck(email=email, result="unknown", is_catch_all=None, is_role=False, note=None, raw={})


class FakeLetters(FakeClient):
    """Для обычного поиска: квалификация и письмо."""

    BODY = ("Здравствуйте!\n\nМеня зовут Арман, я представляю Tanbala. Мы внедряем складской учёт на основе "
            "RFID-меток под ключ, от подбора оборудования до интеграции с 1С и обучения сотрудников.\n\n"
            "Если пересчёт склада занимает несколько дней, RFID помогает ускорить его.\n\n"
            "Как это работает? На каждую коробку наносится метка. Ручной считыватель распознаёт много меток "
            "одновременно. Сотрудник проходит вдоль полок, и система сверяет данные с учётом в 1С.\n\n"
            "Мы берём на себя весь процесс. Подбираем оборудование, тестируем его, настраиваем обмен данными с 1С "
            "и обучаем команду.\n\n"
            "Напишите нам в WhatsApp по номеру +7 747 959 72 38. Расскажите, что вы храните и как сейчас "
            "считаете остатки.")

    def create(self, **kwargs):
        if "fit" in kwargs["output_config"]["format"]["schema"]["properties"]:
            return super().create(**kwargs)
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=0,
                                cache_creation_input_tokens=0)
        answer = {"subject": "Учёт склада", "body": self.BODY, "notes": []}
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(answer, ensure_ascii=False))],
                               stop_reason="end_turn", usage=usage, model="claude-haiku-5-5")


# ---------- повторы, сбои очереди, разбор тела ----------


@pytest.mark.db
def test_same_request_while_first_is_waiting_returns_same_job(env):
    client, deps, queue = env.client(per_day=1, inline=False)
    queue.kick = lambda: None  # обработчик не запущен: задача остаётся в очереди

    first = post(client, {"name": "Аксенгер"})["job_id"]
    again = post(client, {"name": "аксенгер", "city": "Алматы"})["job_id"]

    assert again == first
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 1


@pytest.mark.db
def test_company_qualified_meanwhile_is_not_paid_for_twice(env):
    company_id = add_company(env.conn, "Zeta, склад", status="new", phones=["+77773131364"])
    client, deps, queue = env.client(inline=False)
    queue.kick = lambda: None
    job_id = post(client, {"name": "Zeta", "phone": "87773131364"})["job_id"]
    add_qualification(env.conn, company_id)  # пока задача ждала, компанию оценил поиск

    queue.drain()

    assert (status(client, job_id)["status"], deps.client.calls) == ("done", [])


@pytest.mark.db
def test_job_left_running_after_failure_does_not_block_queue(env):
    client, _, queue = env.client(inline=False)
    queue.kick = lambda: None
    stuck = post(client, {"name": "Аксенгер"})["job_id"]
    env.conn.execute("UPDATE research_jobs SET status = 'running' WHERE id = %s", (stuck,))
    waiting = post(client, {"name": "Станица"})["job_id"]

    assert queue.drain() == 1

    assert (status(client, stuck)["status"], status(client, stuck)["reason"]) == ("failed", "error")
    assert status(client, waiting)["status"] == "done"


@pytest.mark.db
def test_queue_without_api_key_fails_jobs_and_keeps_going(env):
    def no_key():
        raise RuntimeError("Не задана переменная VENMART_ANTHROPIC_KEY")

    queue = research.ResearchQueue(env.connect, no_key, per_day=20, budget_usd=1.0, inline=True)
    request = research.parse_request({"name": "Аксенгер"})
    job_id = queue.submit(env.conn, request).job_id

    assert research.job_status(env.conn, job_id)["reason"] == "error"


def test_deeply_nested_body_is_400():
    response = make_client_without_db().post("/internal/research", content=b"[" * 3000,
                                             headers={**AUTH, "Content-Type": "application/json"})

    assert (response.status_code, response.json()) == (400, {"error": "bad_request"})


@pytest.mark.parametrize("path", ["/internal/lookup/", "/internal/research/"])
def test_trailing_slash_is_not_redirected_before_token(path):
    client = make_client_without_db()

    assert client.get(path, follow_redirects=False).status_code == 401
    assert client.get(path, headers=AUTH, follow_redirects=False).status_code == 404


@pytest.mark.db
def test_research_status_brief_does_not_mark_whatsapp_contact(env):
    client, _, _ = env.client()

    company_id = status(client, post(client, {"name": "Аксенгер"})["job_id"])["company_id"]

    assert env.conn.execute("SELECT whatsapp_contacted_at FROM companies WHERE id = %s",
                            (company_id,)).fetchone()[0] is None
