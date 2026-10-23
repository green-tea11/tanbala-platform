import os
import uuid

import pytest
from dotenv import load_dotenv

load_dotenv()


@pytest.fixture
def db_conn():
    """Соединение с Postgres из docker-compose во временной схеме. После теста схема удаляется."""
    psycopg = pytest.importorskip("psycopg")
    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("DATABASE_URL не задан")
    try:
        conn = psycopg.connect(dsn, autocommit=True, connect_timeout=3)
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres недоступен: {exc}")

    schema = f"test_{uuid.uuid4().hex[:12]}"
    conn.execute(f'CREATE SCHEMA "{schema}"')
    conn.execute(f'SET search_path TO "{schema}"')
    try:
        yield conn
    finally:
        conn.execute(f'DROP SCHEMA "{schema}" CASCADE')
        conn.close()
