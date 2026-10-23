"""Полный запуск по кнопке: 2ГИС → сайты → квалификация → проверка почт → черновики писем.

Запуск идёт в фоновом потоке и пишет прогресс в таблицу runs. Одновременно идёт один запуск.
"""

import asyncio
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from tanbala_leads import PROJECT_ROOT, db, knowledge, llm
from tanbala_leads.settings import Settings, load_settings
from tanbala_leads.steps import collect, crawl, draft, qualify, verify
from tanbala_leads.steps.collect import CITIES

logger = logging.getLogger(__name__)

MAX_COMPANIES_LIMIT = 20
MAX_QUERY_LENGTH = 100
# В выдаче 2ГИС бывают районы, здания и уже известные компании: берём записей с запасом.
PARSER_RECORDS_FACTOR = 3
PARSER_RECORDS_LIMIT = 60
COUNTERS = ("crawled", "qualified", "rejected", "verified", "drafted", "errors")


class RunAlreadyActive(RuntimeError):
    """Уже идёт другой запуск."""


def create_run(conn: psycopg.Connection, city: str, query: str, max_companies: int) -> int:
    """Проверить параметры и создать запись запуска со статусом queued."""
    query = query.strip()
    if city not in CITIES:
        raise ValueError(f"Неизвестный город: {city}")
    if not query or len(query) > MAX_QUERY_LENGTH:
        raise ValueError(f"Запрос должен быть от 1 до {MAX_QUERY_LENGTH} символов")
    if not 1 <= max_companies <= MAX_COMPANIES_LIMIT:
        raise ValueError(f"Число компаний должно быть от 1 до {MAX_COMPANIES_LIMIT}")
    try:
        row = conn.execute(
            "INSERT INTO runs (city, query, max_companies) VALUES (%s, %s, %s) RETURNING id",
            (city, query, max_companies),
        ).fetchone()
    except psycopg.errors.UniqueViolation as exc:
        raise RunAlreadyActive("Уже идёт другой запуск, дождитесь его окончания") from exc
    return row[0]


def start_run(dsn: str, city: str, query: str, max_companies: int) -> int:
    """Создать запуск и выполнить его в фоновом потоке. Вернуть id запуска."""
    with db.connect(dsn) as conn:
        run_id = create_run(conn, city, query, max_companies)
    thread = threading.Thread(target=execute_run, args=(dsn, run_id), name=f"run-{run_id}", daemon=True)
    thread.start()
    return run_id


def recover_stale_runs(conn: psycopg.Connection) -> int:
    """Пометить прерванными запуски, которые остались активными после перезапуска приложения."""
    cursor = conn.execute(
        "UPDATE runs SET status = 'failed', error = 'Запуск прерван: приложение было перезапущено',"
        " finished_at = now() WHERE status IN ('queued', 'running')"
    )
    return cursor.rowcount


@dataclass(frozen=True)
class Deps:
    """Внешние зависимости запуска. В тестах подменяются, чтобы не ходить в сеть и в API."""

    run_parser: Callable[[str, Path, int], Path]
    crawl: Callable[[str], object]
    check_email: Callable[[str], object]
    client: object
    owner_doc: str
    settings: Settings
    exports_dir: Path = PROJECT_ROOT / "data" / "2gis"
    log_path: Path = PROJECT_ROOT / "logs" / "llm_calls.jsonl"


def default_deps(settings: Settings) -> Deps:
    """Настоящие зависимости: parser-2gis, crawl4ai, Reacher, Claude API."""
    from tanbala_leads.sites import crawl_site

    client = llm.make_client(settings)
    secret = settings.require("reacher_secret")
    return Deps(
        run_parser=lambda url, out, n: collect.run_parser(url, out, n, settings.parser_2gis_bin),
        crawl=lambda url: asyncio.run(crawl_site(url)),
        check_email=lambda email: verify.check_email(email, base_url=settings.reacher_url, secret=secret),
        client=client,
        owner_doc=knowledge.load_owner_doc(),
        settings=settings,
        log_path=PROJECT_ROOT / (settings.llm_log_path or "logs/llm_calls.jsonl"),
    )


def _set(conn: psycopg.Connection, run_id: int, **fields) -> None:
    assignments = sql.SQL(", ").join(
        sql.SQL("{} = {}").format(sql.Identifier(name), sql.Placeholder(name)) for name in fields
    )
    conn.execute(sql.SQL("UPDATE runs SET {} WHERE id = %(run_id)s").format(assignments), {**fields, "run_id": run_id})


def _bump(conn: psycopg.Connection, run_id: int, counter: str) -> None:
    if counter not in COUNTERS:
        raise ValueError(counter)
    conn.execute(sql.SQL("UPDATE runs SET {0} = {0} + 1 WHERE id = %s").format(sql.Identifier(counter)), (run_id,))


def _company_failed(conn: psycopg.Connection, run_id: int, company_id: int, exc: Exception) -> None:
    logger.exception("Запуск %s, компания %s: ошибка", run_id, company_id)
    message = f"{type(exc).__name__}: {exc}"[:500]
    conn.execute("UPDATE companies SET last_error = %s WHERE id = %s", (message, company_id))
    _bump(conn, run_id, "errors")


def _ids_with_status(conn: psycopg.Connection, company_ids: tuple[int, ...], status: str) -> list[int]:
    rows = conn.execute("SELECT id FROM companies WHERE id = ANY(%s) AND status = %s ORDER BY id",
                        (list(company_ids), status)).fetchall()
    return [company_id for (company_id,) in rows]


def _usage_recorder(conn: psycopg.Connection, run_id: int, company_id: int, log_path: Path):
    def record(usage: llm.LLMUsage) -> None:
        llm.save_usage(conn, usage, run_id=run_id, company_id=company_id)
        llm.append_usage_log(log_path, usage, run_id=run_id, company_id=company_id)

    return record


def _collect(conn: psycopg.Connection, run_id: int, run: dict, deps: Deps) -> tuple[int, ...]:
    _set(conn, run_id, stage="Поиск в 2ГИС")
    url = collect.build_search_url(run["city"], run["query"])
    export = deps.exports_dir / f"run-{run_id}.json"
    max_records = min(run["max_companies"] * PARSER_RECORDS_FACTOR, PARSER_RECORDS_LIMIT)
    deps.run_parser(url, export, max_records)
    result = collect.load_companies(conn, export, run_id=run_id, limit=run["max_companies"])
    _set(conn, run_id, found=result.found, new_companies=len(result.new_ids))
    return result.new_ids


def _each(conn, run_id, company_ids, action: Callable[[int], str | None]) -> None:
    """Выполнить шаг для каждой компании. Ошибка одной компании не останавливает остальные."""
    for company_id in company_ids:
        try:
            counter = action(company_id)
        except Exception as exc:  # noqa: BLE001  шаг не должен ронять весь запуск
            _company_failed(conn, run_id, company_id, exc)
            continue
        if counter:
            _bump(conn, run_id, counter)


def _steps(conn: psycopg.Connection, run_id: int, company_ids: tuple[int, ...], deps: Deps) -> None:
    log_path = deps.log_path

    _set(conn, run_id, stage="Сайты")

    def do_crawl(cid: int) -> str:
        crawl.crawl_company(conn, cid, deps.crawl)
        return "crawled"

    _each(conn, run_id, company_ids, do_crawl)

    _set(conn, run_id, stage="Квалификация")

    def do_qualify(cid: int) -> str:
        answer = qualify.qualify_company(conn, cid, client=deps.client, owner_doc=deps.owner_doc,
                                         on_usage=_usage_recorder(conn, run_id, cid, log_path))
        return "rejected" if answer["fit"] == "no" else "qualified"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "crawled"), do_qualify)

    _set(conn, run_id, stage="Проверка почт")

    def do_verify(cid: int) -> str | None:
        if verify.verify_company(conn, cid, deps.check_email) == 0:
            conn.execute("UPDATE companies SET last_error = 'Нет рабочей почты' WHERE id = %s", (cid,))
            return None
        conn.execute("UPDATE companies SET status = 'verified', last_error = NULL WHERE id = %s", (cid,))
        return "verified"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "qualified"), do_verify)

    _set(conn, run_id, stage="Письма")

    def do_draft(cid: int) -> str:
        draft.draft_first_email(conn, cid, client=deps.client, owner_doc=deps.owner_doc, settings=deps.settings,
                                on_usage=_usage_recorder(conn, run_id, cid, log_path))
        return "drafted"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "verified"), do_draft)


def execute_run(dsn: str, run_id: int, deps: Deps | None = None) -> None:
    """Выполнить все шаги запуска: 2ГИС → сайты → квалификация → проверка почт → письма."""
    with db.connect(dsn) as conn:
        try:
            _set(conn, run_id, status="running", started_at=datetime.now(timezone.utc), stage="Подготовка")
            deps = deps or default_deps(load_settings())
            with conn.cursor(row_factory=dict_row) as cursor:
                run = cursor.execute("SELECT city, query, max_companies FROM runs WHERE id = %s", (run_id,)).fetchone()
            company_ids = _collect(conn, run_id, run, deps)
            _steps(conn, run_id, company_ids, deps)
            _set(conn, run_id, status="done", stage="Готово", finished_at=datetime.now(timezone.utc))
        except Exception as exc:  # noqa: BLE001  любая ошибка запуска видна в интерфейсе
            logger.exception("Запуск %s упал", run_id)
            _set(conn, run_id, status="failed", error=f"{type(exc).__name__}: {exc}"[:500],
                 finished_at=datetime.now(timezone.utc))
