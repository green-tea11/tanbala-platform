"""Полный запуск по кнопке: 2ГИС → сайты → квалификация → проверка почт → черновики писем.

Запуск идёт в фоновом потоке и пишет прогресс в таблицу runs. Одновременно идёт один запуск.
"""

import asyncio
import logging
import re
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import anthropic
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
MAX_ERROR_CHARS = 500
# Текст ошибки виден в интерфейсе: ключи API и строки подключения из него вырезаются.
SECRET_PATTERNS = (re.compile(r"sk-ant-[\w-]+"), re.compile(r"postgres(?:ql)?://\S+"), re.compile(r"key=\S+", re.I))


class RunAlreadyActive(RuntimeError):
    """Уже идёт другой запуск."""


class BudgetExceeded(ValueError):
    """Суточный лимит расходов на Claude API исчерпан."""


# Сутки считаются по времени Алматы.
SPENT_TODAY_SQL = """
SELECT model, sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens)
FROM llm_calls
WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty'
GROUP BY model
"""


def spent_today_usd(conn: psycopg.Connection) -> float:
    """Примерный расход на Claude API за сегодня. Модель без цены считаем по самой дорогой известной."""
    most_expensive = max(llm.MODEL_PRICES_USD_PER_MTOK, key=lambda m: llm.MODEL_PRICES_USD_PER_MTOK[m]["output"])
    total = 0.0
    for model, *tokens in conn.execute(SPENT_TODAY_SQL).fetchall():
        counts = [int(value or 0) for value in tokens]
        cost = llm.call_cost_usd(model, *counts)
        total += cost if cost is not None else llm.call_cost_usd(most_expensive, *counts)
    return total


def create_run(conn: psycopg.Connection, city: str, query: str, max_companies: int, *,
               daily_budget_usd: float | None = None) -> int:
    """Проверить параметры и лимит расходов, создать запись запуска со статусом queued."""
    query = query.strip()
    if city not in CITIES:
        raise ValueError(f"Неизвестный город: {city}")
    if not query or len(query) > MAX_QUERY_LENGTH:
        raise ValueError(f"Запрос должен быть от 1 до {MAX_QUERY_LENGTH} символов")
    if not 1 <= max_companies <= MAX_COMPANIES_LIMIT:
        raise ValueError(f"Число компаний должно быть от 1 до {MAX_COMPANIES_LIMIT}")
    if daily_budget_usd is not None:
        spent = spent_today_usd(conn)
        if spent >= daily_budget_usd:
            raise BudgetExceeded(
                f"Дневной лимит расходов на API ${daily_budget_usd:.2f} исчерпан: сегодня потрачено ${spent:.2f}."
                " Поднимите DAILY_API_BUDGET_USD в .env или продолжите завтра."
            )
    try:
        row = conn.execute(
            "INSERT INTO runs (city, query, max_companies) VALUES (%s, %s, %s) RETURNING id",
            (city, query, max_companies),
        ).fetchone()
    except psycopg.errors.UniqueViolation as exc:
        raise RunAlreadyActive("Уже идёт другой запуск, дождитесь его окончания") from exc
    return row[0]


def daily_budget(settings: Settings) -> float:
    """Суточный лимит из DAILY_API_BUDGET_USD."""
    try:
        return float(settings.daily_api_budget_usd)
    except ValueError as exc:
        raise ValueError("DAILY_API_BUDGET_USD должен быть числом, например 1.00") from exc


def start_run(dsn: str, city: str, query: str, max_companies: int) -> int:
    """Создать запуск и выполнить его в фоновом потоке. Вернуть id запуска."""
    budget = daily_budget(load_settings())
    with db.connect(dsn) as conn:
        run_id = create_run(conn, city, query, max_companies, daily_budget_usd=budget)
    thread = threading.Thread(target=execute_run, args=(dsn, run_id), name=f"run-{run_id}", daemon=True)
    try:
        thread.start()
    except RuntimeError as exc:
        _fail_with_new_connection(dsn, run_id, exc)
        raise
    return run_id


def _fail_with_new_connection(dsn: str, run_id: int, exc: BaseException) -> None:
    """Пометить запуск упавшим через отдельное соединение: иначе он навсегда занял бы место активного."""
    try:
        with db.connect(dsn) as conn:
            _set(conn, run_id, status="failed", error=safe_error(exc), finished_at=datetime.now(timezone.utc))
    except psycopg.Error:
        logger.exception("Запуск %s: не удалось пометить упавшим", run_id)


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


def safe_error(exc: BaseException) -> str:
    """Короткий текст ошибки для базы и интерфейса, без секретов."""
    text = f"{type(exc).__name__}: {exc}"
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[скрыто]", text)
    return text[:MAX_ERROR_CHARS]


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
    message = safe_error(exc)
    conn.execute("UPDATE companies SET last_error = %s WHERE id = %s", (message, company_id))
    _bump(conn, run_id, "errors")


def _ids_with_status(conn: psycopg.Connection, company_ids: tuple[int, ...], status: str) -> list[int]:
    rows = conn.execute("SELECT id FROM companies WHERE id = ANY(%s) AND status = %s ORDER BY id",
                        (list(company_ids), status)).fetchall()
    return [company_id for (company_id,) in rows]


def _usage_recorder(conn: psycopg.Connection, run_id: int, company_id: int, log_path: Path):
    """Учёт токенов. Его сбой не должен выбросить уже оплаченный ответ модели."""

    def record(usage: llm.LLMUsage) -> None:
        try:
            llm.save_usage(conn, usage, run_id=run_id, company_id=company_id)
        except psycopg.Error:
            logger.exception("Запуск %s: вызов API не записан в llm_calls", run_id)
        try:
            llm.append_usage_log(log_path, usage, run_id=run_id, company_id=company_id)
        except OSError:
            logger.exception("Запуск %s: вызов API не записан в %s", run_id, log_path)

    return record


# Компании прошлых запусков, у которых шаг упал: дообрабатываем их в пределах лимита запуска.
UNFINISHED_SQL = """
SELECT c.id FROM companies c
WHERE c.id <> ALL(%(exclude)s)
  AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.company_id = c.id)
  AND (
      c.status IN ('new', 'crawled')
      OR (c.status = 'qualified'
          AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.company_id = c.id AND ct.verify_result IS NULL))
      OR c.status = 'verified'
  )
ORDER BY c.id
LIMIT %(limit)s
"""


def _unfinished(conn: psycopg.Connection, exclude: tuple[int, ...], limit: int) -> tuple[int, ...]:
    if limit <= 0:
        return ()
    rows = conn.execute(UNFINISHED_SQL, {"exclude": list(exclude), "limit": limit}).fetchall()
    return tuple(company_id for (company_id,) in rows)


def _collect(conn: psycopg.Connection, run_id: int, run: dict, deps: Deps) -> tuple[int, ...]:
    _set(conn, run_id, stage="Поиск в 2ГИС")
    url = collect.build_search_url(run["city"], run["query"])
    export = deps.exports_dir / f"run-{run_id}.json"
    max_records = min(run["max_companies"] * PARSER_RECORDS_FACTOR, PARSER_RECORDS_LIMIT)
    deps.run_parser(url, export, max_records)
    result = collect.load_companies(conn, export, run_id=run_id, limit=run["max_companies"])
    _set(conn, run_id, found=result.found, new_companies=len(result.new_ids))
    return result.new_ids + _unfinished(conn, result.new_ids, run["max_companies"] - len(result.new_ids))


# Ошибки, при которых следующие компании упадут так же: ключ, доступ, баланс. Запуск останавливается.
FATAL_API_ERRORS = (anthropic.AuthenticationError, anthropic.PermissionDeniedError)


def _each(conn, run_id, company_ids, action: Callable[[int], str | None]) -> None:
    """Выполнить шаг для каждой компании. Ошибка одной компании не останавливает остальные."""
    for company_id in company_ids:
        try:
            counter = action(company_id)
        except FATAL_API_ERRORS:
            raise
        except Exception as exc:  # noqa: BLE001  шаг не должен ронять весь запуск
            _company_failed(conn, run_id, company_id, exc)
            continue
        if counter:
            _bump(conn, run_id, counter)


def _has_contacts(conn: psycopg.Connection, company_id: int) -> bool:
    return conn.execute("SELECT EXISTS (SELECT 1 FROM contacts WHERE company_id = %s)", (company_id,)).fetchone()[0]


def _steps(conn: psycopg.Connection, run_id: int, company_ids: tuple[int, ...], deps: Deps) -> None:
    log_path = deps.log_path

    _set(conn, run_id, stage="Сайты")

    def do_crawl(cid: int) -> str:
        try:
            crawl.crawl_company(conn, cid, deps.crawl)
        except Exception as exc:  # noqa: BLE001  сайт не открылся: дальше по карточке 2ГИС и её почтам
            _company_failed(conn, run_id, cid, exc)
            conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s AND status = 'new'", (cid,))
        return "crawled"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "new"), do_crawl)

    _set(conn, run_id, stage="Квалификация")

    def do_qualify(cid: int) -> str:
        if not _has_contacts(conn, cid):
            # Писать некуда: не тратим вызов модели.
            conn.execute("UPDATE companies SET status = 'rejected',"
                         " last_error = 'Почта не найдена ни в 2ГИС, ни на сайте' WHERE id = %s", (cid,))
            return "rejected"
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
    try:
        conn = db.connect(dsn)
    except psycopg.Error as exc:
        logger.exception("Запуск %s: нет соединения с базой", run_id)
        _fail_with_new_connection(dsn, run_id, exc)
        return
    with conn:
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
            try:
                _set(conn, run_id, status="failed", error=safe_error(exc), finished_at=datetime.now(timezone.utc))
            except psycopg.Error:
                _fail_with_new_connection(dsn, run_id, exc)
