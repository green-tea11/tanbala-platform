"""Полный запуск по кнопке: 2ГИС → сайты → квалификация → проверка почт → черновики писем.

Запуск идёт в фоновом потоке и пишет прогресс в таблицу runs. Одновременно идёт один запуск.
"""

import asyncio
import functools
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

from tanbala_leads import PROJECT_ROOT, browsers, db, knowledge, llm
from tanbala_leads.settings import Settings, SettingsError, load_settings
from tanbala_leads.steps import collect, crawl, draft, qualify, verify
from tanbala_leads.steps.collect import CITIES

logger = logging.getLogger(__name__)

# Число компаний задаётся на каждую отрасль; отраслей в одном запуске несколько, через запятую.
MAX_COMPANIES_LIMIT = 20
MAX_QUERIES = 10
MAX_QUERY_LENGTH = 60
MAX_TOTAL_COMPANIES = 60
# Длина всего поля «Что ищем»: все отрасли с запятыми.
MAX_QUERY_TEXT_LENGTH = MAX_QUERIES * (MAX_QUERY_LENGTH + 2)
# В выдаче 2ГИС бывают районы, здания и уже известные компании: берём записей с запасом.
PARSER_RECORDS_FACTOR = 3
PARSER_RECORDS_LIMIT = 60
COUNTERS = ("crawled", "qualified", "rejected", "no_email", "verified", "drafted", "errors")
NO_EMAIL_ERROR = "Почта не найдена ни в 2ГИС, ни на сайте"
# Сколько запусков пробуют сайт, который временно не открылся, пока у компании нет почты (потом «Нет почты»).
MAX_SITE_ATTEMPTS = 3
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


def split_queries(text: str) -> list[str]:
    """Отрасли из поля поиска: через запятую, точку с запятой или с новой строки, без повторов."""
    queries: list[str] = []
    for part in re.split(r"[,;\n]+", text):
        query = " ".join(part.split())
        if query and query.lower() not in {known.lower() for known in queries}:
            queries.append(query)
    if not queries:
        raise ValueError("Напишите, что искать, например: склад, логистика")
    if len(queries) > MAX_QUERIES:
        raise ValueError(f"Не больше {MAX_QUERIES} отраслей за один запуск, сейчас {len(queries)}")
    too_long = next((query for query in queries if len(query) > MAX_QUERY_LENGTH), None)
    if too_long:
        raise ValueError(f"Запрос «{too_long[:30]}…» длиннее {MAX_QUERY_LENGTH} символов")
    return queries


def create_run(conn: psycopg.Connection, city: str, query: str, max_companies: int, *,
               daily_budget_usd: float | None = None) -> int:
    """Проверить параметры и лимит расходов, создать запись запуска со статусом queued.

    query: одна или несколько отраслей через запятую; max_companies: сколько компаний на каждую.
    """
    if city not in CITIES:
        raise ValueError(f"Неизвестный город: {city}")
    queries = split_queries(query)
    query = ", ".join(queries)
    if not 1 <= max_companies <= MAX_COMPANIES_LIMIT:
        raise ValueError(f"Число компаний на отрасль должно быть от 1 до {MAX_COMPANIES_LIMIT}")
    if len(queries) * max_companies > MAX_TOTAL_COMPANIES:
        raise ValueError(f"За один запуск не больше {MAX_TOTAL_COMPANIES} компаний: {len(queries)} отраслей"
                         f" × {max_companies} = {len(queries) * max_companies}. Уменьшите число компаний на отрасль.")
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


def start_run(dsn: str, city: str, query: str, max_companies: int, *,
              limits: browsers.BrowserLimits | None = None) -> int:
    """Создать запуск и выполнить его в фоновом потоке. Вернуть id запуска.

    limits: браузеры, общие с проверками из WhatsApp (в сервере web); без них свои по настройкам.
    """
    budget = daily_budget(load_settings())
    with db.connect(dsn) as conn:
        run_id = create_run(conn, city, query, max_companies, daily_budget_usd=budget)
    thread = threading.Thread(target=execute_run, args=(dsn, run_id), kwargs={"limits": limits},
                              name=f"run-{run_id}", daemon=True)
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


# Проверка из WhatsApp берёт из 2ГИС 5 записей (≈ 15 с): дольше 5 минут она не должна держать браузер.
RESEARCH_PARSER_TIMEOUT_SECONDS = 5 * 60


def reacher_per_minute(settings: Settings) -> int:
    """REACHER_MAX_PER_MINUTE числом от 1: столько же проверок в минуту пропускает сам Reacher (docker-compose.yml)."""
    value = settings.require("reacher_max_per_minute")
    if not value.isdigit() or int(value) < 1:
        raise SettingsError("REACHER_MAX_PER_MINUTE должен быть целым числом от 1, например 10. Исправьте его в .env.")
    return int(value)


def default_deps(settings: Settings, limits: browsers.BrowserLimits | None = None, *, urgent: bool = False) -> Deps:
    """Настоящие зависимости: parser-2gis, crawl4ai, Reacher, Claude API.

    Каждый запуск parser-2gis и обход сайта сначала занимает место браузера в limits (без них свои по настройкам).
    urgent: проверка из WhatsApp, она идёт вне очереди между шагами поиска, и parser-2gis у неё короче.
    """
    from tanbala_leads.sites import crawl_site

    limits = limits or browsers.limits_from_settings(settings)
    client = llm.make_client(settings)
    secret = settings.require("reacher_secret")
    # Лимит читается при первой проверке почты: неверный REACHER_MAX_PER_MINUTE не ломает проверку из WhatsApp,
    # ей Reacher не нужен (ревью 31.10.2026).
    reacher_limit = functools.cache(lambda: verify.RateLimiter(reacher_per_minute(settings)))

    def check_email(email: str) -> verify.EmailCheck:
        reacher_limit().wait()
        return verify.check_email(email, base_url=settings.reacher_url, secret=secret)

    parser_timeout = RESEARCH_PARSER_TIMEOUT_SECONDS if urgent else collect.PARSER_TIMEOUT_SECONDS
    headless = collect.parse_headless(settings.parser_2gis_headless)
    return Deps(
        run_parser=limits.gis.guard(lambda url, out, n: collect.run_parser(url, out, n, settings.parser_2gis_bin,
                                                                           timeout_seconds=parser_timeout,
                                                                           headless=headless),
                                    urgent=urgent),
        crawl=limits.sites.guard(lambda url: asyncio.run(crawl_site(url)), urgent=urgent),
        check_email=check_email,
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


def usage_recorder(conn: psycopg.Connection, run_id: int | None, company_id: int, log_path: Path):
    """Учёт токенов. Его сбой не должен выбросить уже оплаченный ответ модели. run_id None: проверка из WhatsApp."""

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
# Компании из WhatsApp сюда не попадают никогда: им не пишем (решение владельца).
UNFINISHED_SQL = """
SELECT c.id FROM companies c
WHERE c.id <> ALL(%(exclude)s)
  AND c.requested_via IS NULL
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


# Сбой поиска одной отрасли: parser-2gis (таймаут, код выхода, нет выгрузки, Chrome не отдал карточек), чтение
# или разбор выгрузки. BrowserBusy (Chrome занят дольше предела) и ошибки базы останавливают запуск, как раньше.
INDUSTRY_ERRORS = (collect.ParserError, OSError, ValueError)
MAX_INDUSTRY_ERROR_CHARS = 200


def _collect(conn: psycopg.Connection, run_id: int, run: dict, deps: Deps) -> tuple[int, ...]:
    """Поиск в 2ГИС по каждой отрасли запуска: по max_companies новых компаний на отрасль.

    Отрасль, по которой поиск не удался, пропускается и записывается в runs.error; запуск падает, только если не
    удался поиск по всем отраслям.
    """
    _set(conn, run_id, stage="Поиск в 2ГИС")
    queries = split_queries(run["query"])
    max_records = min(run["max_companies"] * PARSER_RECORDS_FACTOR, PARSER_RECORDS_LIMIT)
    new_ids: tuple[int, ...] = ()
    found = 0
    failed: list[str] = []
    for index, query in enumerate(queries, start=1):
        _set(conn, run_id, stage_detail=f"{query} ({index} из {len(queries)})" if len(queries) > 1 else query)
        export = deps.exports_dir / (f"run-{run_id}.json" if len(queries) == 1 else f"run-{run_id}-{index}.json")
        try:
            deps.run_parser(collect.build_search_url(run["city"], query), export, max_records)
            result = collect.load_companies(conn, export, run_id=run_id, limit=run["max_companies"],
                                            search_query=query)
        except collect.ParserStuck:
            # Зависший parser-2gis со своим Chrome мог остаться жить: следующая отрасль запустила бы второй Chrome
            # на 2 ГБ памяти. Запуск останавливается, как до ревью 01.11.2026.
            raise
        except INDUSTRY_ERRORS as exc:
            # Одна отрасль не нашлась (таймаут, сбой Chrome, битая выгрузка): остальные ищем дальше (ревью 01.11.2026).
            logger.warning("Запуск %s: поиск в 2ГИС по отрасли %s из %s не удался: %s", run_id, index, len(queries),
                           type(exc).__name__)
            failed.append(f"«{query}» ({safe_error(exc)[:MAX_INDUSTRY_ERROR_CHARS]})")
            continue
        new_ids += result.new_ids
        found += result.found
        _set(conn, run_id, found=found, new_companies=len(new_ids))
    _set(conn, run_id, stage_detail=None)
    if failed and len(failed) == len(queries):
        raise collect.ParserError("Поиск в 2ГИС не удался: " + "; ".join(failed))
    if failed:
        _set(conn, run_id, error=f"Поиск в 2ГИС не удался по {len(failed)} из {len(queries)} отраслей: "
                                 + "; ".join(failed) + ". Остальные отрасли обработаны.")
    total = run["max_companies"] * len(queries)
    return new_ids + _unfinished(conn, new_ids, total - len(new_ids))


# Ошибки, при которых следующие компании упадут так же: ключ, доступ, баланс. Запуск останавливается.
# BrowserBusy: браузер завис; без остановки каждая компания ждала бы по 5 минут и считалась без сайта.
FATAL_API_ERRORS = (anthropic.AuthenticationError, anthropic.PermissionDeniedError, browsers.BrowserBusy)


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

    def do_crawl(cid: int) -> str | None:
        try:
            crawl.crawl_company(conn, cid, deps.crawl, max_attempts=MAX_SITE_ATTEMPTS)
        except browsers.BrowserBusy:
            raise  # сайт не обходили: компания остаётся new, её дообработает следующий запуск
        except crawl.SiteUnavailable as exc:
            # Почты нет, сайт не открылся временно: компания остаётся new (причина в last_error), это ошибка запуска,
            # а не «Нет почты» навсегда.
            logger.warning("Запуск %s, компания %s: %s", run_id, cid, exc)
            _bump(conn, run_id, "errors")
            return None
        except Exception as exc:  # noqa: BLE001  сайт не открылся: дальше по карточке 2ГИС и её почтам
            _company_failed(conn, run_id, cid, exc)
            conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s AND status = 'new'", (cid,))
        return "crawled"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "new"), do_crawl)

    _set(conn, run_id, stage="Квалификация")

    def do_qualify(cid: int) -> str:
        if not _has_contacts(conn, cid):
            # Писать некуда: не тратим вызов модели. В базе rejected без оценки, в интерфейсе «Нет почты».
            conn.execute("UPDATE companies SET status = 'rejected', last_error = %s WHERE id = %s",
                         (NO_EMAIL_ERROR, cid))
            return "no_email"
        answer = qualify.qualify_company(conn, cid, client=deps.client, owner_doc=deps.owner_doc,
                                         on_usage=usage_recorder(conn, run_id, cid, log_path))
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
                                on_usage=usage_recorder(conn, run_id, cid, log_path))
        return "drafted"

    _each(conn, run_id, _ids_with_status(conn, company_ids, "verified"), do_draft)


def execute_run(dsn: str, run_id: int, deps: Deps | None = None, *,
                limits: browsers.BrowserLimits | None = None) -> None:
    """Выполнить все шаги запуска: 2ГИС → сайты → квалификация → проверка почт → письма.

    limits: общие браузеры для настоящих зависимостей (deps не задан).
    """
    try:
        conn = db.connect(dsn)
    except psycopg.Error as exc:
        logger.exception("Запуск %s: нет соединения с базой", run_id)
        _fail_with_new_connection(dsn, run_id, exc)
        return
    with conn:
        try:
            _set(conn, run_id, status="running", started_at=datetime.now(timezone.utc), stage="Подготовка")
            deps = deps or default_deps(load_settings(), limits)
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
