"""Общее для тестов API консоли: клиент, токены, временная схема и данные. Без сети, без Claude API, без SMTP."""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from tanbala_leads import db
from tanbala_leads.steps import send as send_step
from tanbala_leads.web import create_app

BASE_URL = "http://127.0.0.1"
CONSOLE_TOKEN = "c" * 40
BOT_TOKEN = "b" * 40
USER = "ivan.petrov"
AUTH = {"X-Console-Token": CONSOLE_TOKEN}
POST = {**AUTH, "X-Console-User": USER}
BOT_AUTH = {"X-Internal-Token": BOT_TOKEN}
TEST_TO = "bogdansm2000@gmail.com"
PREFIX = "/internal/console"


def no_db() -> psycopg.Connection:
    raise AssertionError("этот запрос не должен открывать соединение с базой")


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


class FakeSender:
    """Подменяет send.send_test: пишет строку test_sends, как настоящая функция. Настоящего SMTP здесь нет."""

    def __init__(self, error: Exception | None = None):
        self.error = error
        self.calls: list[int] = []

    def __call__(self, conn, draft_id: int) -> send_step.TestSendResult:
        self.calls.append(draft_id)
        real_to = conn.execute("SELECT c.email FROM drafts d JOIN contacts c ON c.id = d.contact_id WHERE d.id = %s",
                               (draft_id,)).fetchone()[0]
        if isinstance(self.error, send_step.SendFailed):
            conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, error) VALUES (%s, %s, %s,"
                         " 'failed', 'SMTP: password=hunter2-secret')", (draft_id, TEST_TO, real_to))
        if self.error is not None:
            raise self.error
        conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, message_id)"
                     " VALUES (%s, %s, %s, 'sent', '<x@venmart.kz>')", (draft_id, TEST_TO, real_to))
        return send_step.TestSendResult(sent_to=TEST_TO, real_to=real_to, message_id="<x@venmart.kz>")


def make_app(connect=no_db, *, token: str | None = CONSOLE_TOKEN, internal_token: str | None = BOT_TOKEN,
             start_run=None, **options):
    return create_app(connect, start_run or FakeStartRun(), csrf_token="csrf", internal_token=internal_token,
                      console_token=token, **options)


def make_client(connect=no_db, *, base_url: str = BASE_URL, raise_server_exceptions: bool = True,
                **options) -> TestClient:
    return TestClient(make_app(connect, **options), base_url=base_url,
                      raise_server_exceptions=raise_server_exceptions)


def post(client: TestClient, path: str, body=None, headers=None, **kwargs):
    """POST в API консоли с токеном, пользователем и JSON-телом ({} по умолчанию)."""
    return client.post(PREFIX + path, json={} if body is None else body, headers={**POST, **(headers or {})},
                       **kwargs)


def get(client: TestClient, path: str, **kwargs):
    return client.get(PREFIX + path, headers=AUTH, **kwargs)


def ok(response) -> dict:
    assert response.status_code == 200, (response.status_code, response.text)
    return response.json()


def problem(response, status: int, code: str) -> str:
    """Ошибка вида {"error", "message"}: проверить статус и код, вернуть текст."""
    assert response.status_code == status, (response.status_code, response.text)
    data = response.json()
    assert data["error"] == code and isinstance(data["message"], str) and data["message"], data
    assert response.headers["content-type"] == "application/json; charset=utf-8"
    return data["message"]


# ---------- база ----------


@pytest.fixture
def console_db(db_conn):
    """Временная схема с таблицами и connect в эту схему; список открытых соединений для проверки закрытия."""
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


def seed_run(conn, *, query="склад", status="done", stage="draft", error=None, **counts) -> int:
    values = {"found": 0, "new_companies": 0, "crawled": 0, "qualified": 0, "rejected": 0,
              "verified": 0, "drafted": 0, "errors": 0, **counts}
    return conn.execute(
        "INSERT INTO runs (city, query, max_companies, status, stage, error, found, new_companies, crawled, qualified,"
        " rejected, verified, drafted, errors) VALUES ('almaty', %s, 5, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)"
        " RETURNING id",
        (query, status, stage, error, *values.values()),
    ).fetchone()[0]


def seed_company(conn, name, *, status="drafted", run_id=None, rubric="Складские услуги", site_text=None,
                 website="sklad.example.kz", domain=None, last_error=None, query=None, requested_via=None) -> int:
    return conn.execute(
        "INSERT INTO companies (name, city, rubric, address, phones, website, website_domain, source_url,"
        " branches_count, site_text, status, last_error, run_id, search_query, requested_via)"
        " VALUES (%s, 'almaty', %s, 'Алматы, ул. Рыскулова, 57', %s, %s, %s, 'https://2gis.kz/almaty/firm/70000001',"
        " 3, %s, %s, %s, %s, %s, %s) RETURNING id",
        (name, rubric, ["+7 727 355 10 20"], website, domain, site_text, status, last_error, run_id, query,
         requested_via),
    ).fetchone()[0]


def seed_contact(conn, company_id, email, *, verify_result="safe", is_role=True) -> int:
    return conn.execute(
        "INSERT INTO contacts (company_id, email, source_page, verify_result, is_role) VALUES (%s, %s, %s, %s, %s)"
        " RETURNING id",
        (company_id, email, "https://sklad.example.kz/kontakty", verify_result, is_role),
    ).fetchone()[0]


def seed_qualification(conn, company_id, score=86, *, fit="yes", pains=()) -> None:
    conn.execute(
        "INSERT INTO qualifications (company_id, fit, score, reason, segment, model, pains)"
        " VALUES (%s, %s, %s, 'Склад на 12 000 паллетомест, инвентаризация вручную', 'склады', 'claude-haiku-5-5', %s)",
        (company_id, fit, score, Jsonb(list(pains))),
    )


def seed_draft(conn, company_id, contact_id, *, subject="Инвентаризация за часы", body="Здравствуйте!",
               checks=None, review_status="pending") -> int:
    approved = review_status == "approved"
    return conn.execute(
        "INSERT INTO drafts (company_id, contact_id, subject, body, model, check_result, review_status,"
        " approved_by, approved_at) VALUES (%s, %s, %s, %s, 'claude-haiku-5-5', %s, %s, %s, %s) RETURNING id",
        (company_id, contact_id, subject, body, Jsonb(checks or []), review_status,
         "владелец" if approved else None, datetime.now(UTC) if approved else None),
    ).fetchone()[0]


def seed_llm_call(conn, model="claude-haiku-5-5", *, task="qualify", run_id=None, company_id=None,
                  input_tokens=0, output_tokens=0, cache_read_tokens=0, cache_write_tokens=0,
                  created_at=None) -> None:
    conn.execute(
        "INSERT INTO llm_calls (task, model, run_id, company_id, input_tokens, output_tokens, cache_read_tokens,"
        " cache_write_tokens, created_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, coalesce(%s, now()))",
        (task, model, run_id, company_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         created_at),
    )


LETTER_BODY = ("[Проверить: число паллетомест с сайта]\nЗдравствуйте!\n\nМы ставим RFID-метки на паллеты.\n"
               "[Ответить лично: посреди текста]\n\nАрман")
LETTER_CHECKS = [{"name": "dashes", "passed": False, "details": ["тире: «—» в «…метки — на…»"]},
                 {"name": "prices", "passed": True, "details": []}]


def full_company(conn, name="ТОО «Степь Склад»", *, score=86, **kwargs) -> tuple[int, int, int]:
    """Компания с оценкой, почтой и письмом на проверке."""
    company_id = seed_company(conn, name, **kwargs)
    seed_qualification(conn, company_id, score, pains=[
        {"pain": "Инвентаризация занимает дни", "evidence": "пересчёт раз в квартал", "source": "site",
         "verified": True}])
    contact_id = seed_contact(conn, company_id, f"info@c{company_id}.example.kz")
    draft_id = seed_draft(conn, company_id, contact_id, body=LETTER_BODY, checks=LETTER_CHECKS)
    return company_id, contact_id, draft_id
