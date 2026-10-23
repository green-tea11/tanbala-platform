import os
import uuid

import pytest
from anthropic._base_client import AsyncAPIClient, SyncAPIClient
from dotenv import load_dotenv

load_dotenv()


def pytest_collection_modifyitems(config, items):
    """Платные тесты идут только с RUN_PAID=1, что бы ни было передано в -m."""
    if os.environ.get("RUN_PAID") == "1":
        return
    skip = pytest.mark.skip(reason="платный вызов API: только с разрешения владельца, запуск с RUN_PAID=1")
    for item in items:
        if item.get_closest_marker("paid"):
            item.add_marker(skip)


@pytest.fixture(autouse=True)
def block_real_api_calls(request, monkeypatch):
    """В тестах без маркера paid любой HTTP-запрос SDK Anthropic валит тест."""
    if request.node.get_closest_marker("paid"):
        return

    def refuse(*args, **kwargs):
        pytest.fail("Реальный вызов Claude API в бесплатном тесте. Используйте мок или фикстуру из tests/fixtures.")

    monkeypatch.setattr(SyncAPIClient, "request", refuse)
    monkeypatch.setattr(AsyncAPIClient, "request", refuse)


@pytest.fixture
def db_conn():
    """Соединение с Postgres во временной схеме. После теста схема удаляется.

    Берёт TEST_DATABASE_URL, иначе DATABASE_URL. Без них тест пропускается.
    Если адрес задан, а база недоступна, тест падает: схема не должна остаться непроверенной молча.
    Без Docker бесплатные тесты запускаются так: pytest -m "not db".
    """
    psycopg = pytest.importorskip("psycopg")
    dsn = os.environ.get("TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("DATABASE_URL не задан")
    try:
        conn = psycopg.connect(dsn, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as exc:
        pytest.fail(f"Postgres недоступен, запустите docker compose up -d: {exc}")

    schema = f"test_{uuid.uuid4().hex[:12]}"
    conn.execute(f'CREATE SCHEMA "{schema}"')
    conn.execute(f'SET search_path TO "{schema}"')
    try:
        yield conn
    finally:
        conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
        conn.close()
