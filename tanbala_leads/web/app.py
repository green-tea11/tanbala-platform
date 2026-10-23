"""Веб-интерфейс поиска клиентов: поиск по кнопке, список компаний, карточка компании с письмом.

Работает только на 127.0.0.1. Страницы показывают текст с чужих сайтов и от модели, поэтому:
Jinja экранирует всё, ссылки выводятся только http(s), в JS данные попадают только через textContent,
каждый POST требует CSRF-токен и своё Origin. Отправки писем здесь нет.

Один модуль чуть длиннее 800 строк сознательно: по договорённости веб-часть живёт в app.py и шаблонах.
Если будет расти, делить по готовым разделам: форматирование, запросы, данные для шаблонов, маршруты.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
import secrets
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import psycopg
import uvicorn
from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from psycopg.rows import dict_row
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from tanbala_leads import __version__, db, pipeline
from tanbala_leads.settings import load_settings
from tanbala_leads.steps import approve as approve_step
from tanbala_leads.steps.collect import CITIES

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

BIND_HOST = "127.0.0.1"
# Защита от DNS rebinding: чужое имя хоста в запросе получает 400.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
REVIEWER = "владелец"

DEFAULT_CITY = "almaty"
DEFAULT_MAX_COMPANIES = 5
QUICK_QUERIES = ("склад", "логистика", "производство", "магазин одежды", "оборотная тара", "строительная компания")
POLL_INTERVAL_MS = 2000
COMPANIES_PER_PAGE = 50
RECENT_RUNS = 20
RUN_FILTER_CHOICES = 50
SITE_TEXT_PREVIEW_CHARS = 20_000
MAX_SUBJECT_LENGTH = 200
MAX_BODY_LENGTH = 10_000
MAX_ID_DIGITS = 18
MAX_DB_ID = 2**63 - 1  # bigint: больший id даже не отправляем в базу
MAX_FORM_BYTES = 256 * 1024  # правка письма до 10 000 символов кириллицы в urlencoded
NOTE_PREFIXES = ("[Проверить:", "[Ответить лично:")

# Оценка для кнопки: квалификация и черновик письма, по одному вызову Haiku на компанию.
APPROX_CALLS_PER_COMPANY = 2
APPROX_USD_PER_COMPANY = 0.002

# Цены на 06.10.2026, примерно. Доллары за миллион токенов; запись в кэш по цене 5-минутного кэша.
MODEL_PRICES_USD_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write": 0.125},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20, "cache_write": 2.50},
}
TOKEN_KINDS = ("input", "output", "cache_read", "cache_write")
TOKENS_PER_MTOK = 1_000_000

# Коды этапов в runs.stage, их названия и счётчики из строки runs.
STAGES: tuple[tuple[str, str, tuple[tuple[str, str], ...]], ...] = (
    ("collect", "Поиск в 2ГИС", (("found", "найдено"), ("new_companies", "новых"))),
    ("crawl", "Сайты", (("crawled", "обойдено"),)),
    ("qualify", "Квалификация", (("qualified", "подходят"), ("rejected", "не подходят"))),
    ("verify", "Проверка почт", (("verified", "проверено"),)),
    ("draft", "Письма", (("drafted", "писем"),)),
)
# Пайплайн пишет в runs.stage русские названия этапов, «Подготовка» и «Готово»; коды тоже понимаем.
STAGE_ALIASES = {"Подготовка": 0}
STAGE_STATE_LABELS = {"done": "готово", "current": "идёт", "failed": "ошибка", "pending": "ждёт"}
STAGE_HINTS = {
    "collect": "компании по запросу",
    "crawl": "почты и текст с сайта",
    "qualify": "Claude Haiku: нужен ли им RFID",
    "verify": "существует ли почта",
    "draft": "черновик первого письма",
}
RUN_STATUSES = {
    "queued": ("В очереди", "neutral"),
    "running": ("Идёт", "accent"),
    "done": ("Готово", "pos"),
    "failed": ("Ошибка", "neg"),
}
FINISHED_RUN_STATUSES = frozenset({"done", "failed"})
COMPANY_STATUSES = {
    "new": ("Найдена", "neutral"),
    "crawled": ("Сайт обойдён", "neutral"),
    "qualified": ("Подходит", "neutral"),
    "rejected": ("Не подходит", "muted"),
    "verified": ("Почта проверена", "neutral"),
    "drafted": ("Письмо готово", "accent"),
    "approved": ("Одобрено", "pos"),
    "sent": ("Отправлено", "pos"),
    "replied": ("Ответили", "pos"),
}
STATUS_CARDS = (("", "Все"), ("drafted", "Письмо готово"), ("approved", "Одобрено"), ("rejected", "Не подходит"))
VERIFY_RESULTS = {
    "safe": ("Существует", "pos"),
    "risky": ("Рискованная", "warn"),
    "invalid": ("Не существует", "neg"),
    "unknown": ("Не удалось проверить", "neutral"),
    None: ("Не проверена", "neutral"),
}
FIT_LABELS = {"yes": "подходит", "maybe": "возможно", "no": "не подходит"}
REVIEW_LABELS = {"pending": "Ждёт проверки", "approved": "Одобрено", "rejected": "Отклонено"}
CHECK_LABELS = {
    "dashes": "Тире",
    "prices": "Цены",
    "stop_words": "Стоп-слова",
    "links": "Ссылки",
    "length": "Длина",
    "signature": "Подпись",
    "notes": "Пометки для владельца",
    "jargon": "Жаргон",
    "style": "Стиль",
}
DONE_MESSAGES = {
    "approved": "Письмо одобрено. Отправка писем пока выключена.",
    "rejected": "Письмо отклонено. Компания вернулась к статусу «Почта проверена».",
    "saved": "Изменения сохранены, проверки пройдены заново.",
}
ERROR_MESSAGES = {
    400: "Неверный запрос.",
    403: "Форма устарела или пришла не с этой страницы. Обновите страницу и повторите.",
    404: "Такой страницы нет.",
    405: "Так эту страницу открыть нельзя.",
    409: "Действие сейчас невозможно.",
    413: "Слишком большой запрос.",
}
DB_ERROR_MESSAGE = "База данных недоступна или вернула ошибку. Проверьте, что Docker запущен, и обновите страницу."
# Ошибки шагов хранятся текстом исключения; перед показом прячем то, что похоже на ключи и пароли.
_SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]+"),
    re.compile(r"\b(?:postgres(?:ql)?|mysql|redis|amqp)://\S+", re.IGNORECASE),
    re.compile(r"\b(?:api[_-]?key|x-api-key|secret|password|passwd|token|authorization)\b\s*[=:]\s*\S+",
               re.IGNORECASE),
)
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
)
_HOST_RE = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}(:\d+)?$", re.IGNORECASE)
_LIKE_SPECIAL = str.maketrans({"\\": "\\\\", "%": "\\%", "_": "\\_"})

RUN_COLUMNS = (
    "id, city, query, max_companies, status, stage, found, new_companies, crawled, qualified, rejected,"
    " verified, drafted, errors, error, created_at, started_at, finished_at"
)
TOKEN_SUMS = (
    "sum(input_tokens)::bigint AS input_tokens, sum(output_tokens)::bigint AS output_tokens,"
    " sum(cache_read_tokens)::bigint AS cache_read_tokens, sum(cache_write_tokens)::bigint AS cache_write_tokens"
)
# Лучший адрес компании: существующий, потом непроверенный надёжно, рискованный, ещё не проверенный, несуществующий.
CONTACT_ORDER = (
    "CASE verify_result WHEN 'safe' THEN 0 WHEN 'unknown' THEN 1 WHEN 'risky' THEN 2"
    " WHEN 'invalid' THEN 4 ELSE 3 END, id"
)
COMPANY_LIST_SQL = f"""
SELECT c.id, c.name, c.rubric, c.city, c.status, c.created_at, c.last_error,
       q.score, q.fit, ct.email, ct.verify_result, ct.is_catch_all, ct.is_role,
       d.id AS draft_id, d.review_status, d.check_result
FROM companies c
LEFT JOIN LATERAL (SELECT score, fit FROM qualifications WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) q ON true
LEFT JOIN LATERAL (SELECT email, verify_result, is_catch_all, is_role FROM contacts WHERE company_id = c.id
                   ORDER BY {CONTACT_ORDER} LIMIT 1) ct ON true
LEFT JOIN LATERAL (SELECT id, review_status, check_result FROM drafts WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) d ON true
{{where}}
ORDER BY c.created_at DESC, c.id DESC
LIMIT %s OFFSET %s
"""


# ---------- расходы ----------


@dataclass(frozen=True)
class Cost:
    """Токены и примерная цена. unpriced_tokens: токены моделей без цены в MODEL_PRICES_USD_PER_MTOK."""

    tokens: int = 0
    usd: float = 0.0
    unpriced_tokens: int = 0

    @property
    def priced(self) -> bool:
        return self.unpriced_tokens == 0


def call_cost_usd(model: str, input_tokens: int, output_tokens: int,
                  cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float | None:
    """Примерная цена вызовов одной модели. Неизвестная модель: None."""
    prices = MODEL_PRICES_USD_PER_MTOK.get(model)
    if prices is None:
        return None
    total = (input_tokens * prices["input"] + output_tokens * prices["output"]
             + cache_read_tokens * prices["cache_read"] + cache_write_tokens * prices["cache_write"])
    return total / TOKENS_PER_MTOK


def cost_from_rows(rows: Iterable[dict[str, Any]]) -> Cost:
    """Сложить строки вида {model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}."""
    tokens, usd, unpriced = 0, 0.0, 0
    for row in rows:
        counts = {f"{kind}_tokens": int(row.get(f"{kind}_tokens") or 0) for kind in TOKEN_KINDS}
        row_tokens = sum(counts.values())
        price = call_cost_usd(row["model"], **counts)
        tokens += row_tokens
        if price is None:
            unpriced += row_tokens
        else:
            usd += price
    return Cost(tokens=tokens, usd=usd, unpriced_tokens=unpriced)


def format_usd(value: float) -> str:
    """$0,0123 для копеечных сумм, $12,34 от доллара."""
    if value <= 0:
        return "$0"
    if value < 0.0001:
        return "< $0,0001"
    text = f"{value:,.4f}" if value < 1 else f"{value:,.2f}"
    return "$" + text.replace(",", " ").replace(".", ",")


def format_cost(cost: Cost) -> str:
    if cost.tokens == 0:
        return "$0"
    if cost.priced:
        return f"≈ {format_usd(cost.usd)}"
    unpriced = f"{fmt_int(cost.unpriced_tokens)} {plural(cost.unpriced_tokens, TOKEN_FORMS)} без цены"
    return f"≈ {format_usd(cost.usd)} + {unpriced}" if cost.usd > 0 else unpriced


def format_approx_usd(value: float) -> str:
    """Округлённая оценка: $0,002, $0,01, $0,04."""
    return "$" + f"{value:.3f}".rstrip("0").rstrip(".").replace(".", ",")


def format_estimate(companies: int) -> str:
    """«За 5 компаний около $0,01» для строки под кнопкой."""
    usd = format_approx_usd(companies * APPROX_USD_PER_COMPANY)
    return f"За {companies} {plural(companies, COMPANY_FORMS)} около {usd}"


# ---------- форматирование ----------

TOKEN_FORMS = ("токен", "токена", "токенов")
COMPANY_FORMS = ("компанию", "компании", "компаний")


def plural(number: int, forms: tuple[str, str, str]) -> str:
    """Русская форма слова для числа: 1 токен, 2 токена, 5 токенов."""
    n = abs(number) % 100
    if 11 <= n <= 14:
        return forms[2]
    if n % 10 == 1:
        return forms[0]
    if 2 <= n % 10 <= 4:
        return forms[1]
    return forms[2]


def fmt_int(value: int | None) -> str:
    return "—" if value is None else f"{value:,}".replace(",", " ")


def fmt_dt(value: datetime | None, now: datetime | None = None) -> str:
    """Время по часам компьютера: «сегодня, 14:05», «вчера, 09:10», «21.10, 18:00»."""
    if value is None:
        return "—"
    local = value.astimezone()
    today = (now or datetime.now().astimezone()).date()
    clock = local.strftime("%H:%M")
    if local.date() == today:
        return f"сегодня, {clock}"
    if local.date() == today - timedelta(days=1):
        return f"вчера, {clock}"
    if local.year == today.year:
        return f"{local:%d.%m}, {clock}"
    return f"{local:%d.%m.%Y}, {clock}"


def safe_href(value: str | None) -> str | None:
    """Ссылка для href только http(s). javascript:, data: и прочее с чужих сайтов не пропускаем."""
    if not value:
        return None
    text = value.strip()
    if any(ch.isspace() or ord(ch) < 32 for ch in text):
        return None
    if "://" not in text and _HOST_RE.match(text.split("/", 1)[0]):
        text = "https://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    return text


def display_url(value: str) -> str:
    text = re.sub(r"^https?://", "", value.strip(), flags=re.IGNORECASE)
    return text[4:].rstrip("/") if text.lower().startswith("www.") else text.rstrip("/")


def tel_href(phone: str) -> str | None:
    digits = re.sub(r"[^\d+]", "", phone)
    return f"tel:{digits}" if sum(ch.isdigit() for ch in digits) >= 5 else None


def parse_id(value: str | None) -> int | None:
    text = (value or "").strip()
    # isascii: isdigit() пропускает «²» и «٣», а int() на них падает.
    return int(text) if text.isascii() and text.isdigit() and len(text) <= MAX_ID_DIGITS else None


def redact(text: str | None) -> str | None:
    if not text:
        return text
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[скрыто]", text)
    return text


def escape_like(text: str) -> str:
    return text.translate(_LIKE_SPECIAL)


def parse_checks(raw: Any) -> list[dict[str, Any]]:
    """drafts.check_result → список проверок. Чужую форму не роняем, а пропускаем."""
    if not isinstance(raw, list):
        return []
    checks = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        details = item.get("details") or []
        if not isinstance(details, list):
            details = [details]
        checks.append({
            "name": name,
            "label": CHECK_LABELS.get(name, name or "Проверка"),
            "passed": item.get("passed") is True,
            "details": [str(detail) for detail in details],
        })
    return checks


def body_lines(body: str) -> list[dict[str, Any]]:
    """Строки письма; пометки для владельца «[Проверить: …]» выделяются."""
    return [{"text": line, "note": line.lstrip().startswith(NOTE_PREFIXES)} for line in body.splitlines()]


def companies_url(run_id: int | None = None, status: str | None = None, q: str | None = None,
                  page: int | None = None) -> str:
    params = {"run": run_id, "status": status, "q": q, "page": page if page and page > 1 else None}
    query = urlencode({key: value for key, value in params.items() if value not in (None, "")})
    return "/companies" + (f"?{query}" if query else "")


# ---------- запросы ----------


def _rows(conn: psycopg.Connection, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def _row(conn: psycopg.Connection, sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchone()


def fetch_run(conn, run_id: int) -> dict[str, Any] | None:
    return _row(conn, f"SELECT {RUN_COLUMNS} FROM runs WHERE id = %s", (run_id,))


def fetch_active_run(conn) -> dict[str, Any] | None:
    return _row(conn, f"SELECT {RUN_COLUMNS} FROM runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1")


def fetch_recent_runs(conn, limit: int) -> list[dict[str, Any]]:
    return _rows(conn, f"SELECT {RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT %s", (limit,))


def fetch_total_cost(conn) -> Cost:
    return cost_from_rows(_rows(conn, f"SELECT model, {TOKEN_SUMS} FROM llm_calls GROUP BY model"))


def fetch_company_cost(conn, company_id: int) -> Cost:
    sql = f"SELECT model, {TOKEN_SUMS} FROM llm_calls WHERE company_id = %s GROUP BY model"
    return cost_from_rows(_rows(conn, sql, (company_id,)))


def fetch_run_costs(conn, run_ids: list[int]) -> dict[int, Cost]:
    if not run_ids:
        return {}
    sql = f"SELECT run_id, model, {TOKEN_SUMS} FROM llm_calls WHERE run_id = ANY(%s) GROUP BY run_id, model"
    grouped: dict[int, list[dict[str, Any]]] = {}
    for row in _rows(conn, sql, (run_ids,)):
        grouped.setdefault(row["run_id"], []).append(row)
    return {run_id: cost_from_rows(rows) for run_id, rows in grouped.items()}


def _company_where(run_id: int | None, q: str, status: str | None = None) -> tuple[str, list[Any]]:
    clauses, params = [], []
    if run_id is not None:
        clauses.append("c.run_id = %s")
        params.append(run_id)
    if q:
        pattern = f"%{escape_like(q)}%"
        clauses.append("(c.name ILIKE %s OR c.rubric ILIKE %s)")
        params += [pattern, pattern]
    if status:
        clauses.append("c.status = %s")
        params.append(status)
    return ("WHERE " + " AND ".join(clauses) if clauses else ""), params


def fetch_status_counts(conn, run_id: int | None, q: str) -> dict[str, int]:
    where, params = _company_where(run_id, q)
    rows = _rows(conn, f"SELECT c.status, count(*) AS n FROM companies c {where} GROUP BY c.status", params)
    return {row["status"]: row["n"] for row in rows}


def fetch_companies(conn, run_id: int | None, status: str | None, q: str, page: int) -> list[dict[str, Any]]:
    where, params = _company_where(run_id, q, status)
    offset = (page - 1) * COMPANIES_PER_PAGE
    return _rows(conn, COMPANY_LIST_SQL.format(where=where), [*params, COMPANIES_PER_PAGE, offset])


def fetch_draft(conn, draft_id: int) -> dict[str, Any]:
    row = _row(conn, "SELECT company_id, review_status FROM drafts WHERE id = %s", (draft_id,)) \
        if draft_id <= MAX_DB_ID else None
    if row is None:
        raise HTTPException(404, "Письмо не найдено.")
    return row


# ---------- данные для шаблонов ----------


def stage_index(stage: str | None) -> int | None:
    for index, (code, label, _) in enumerate(STAGES):
        if stage in (code, label):
            return index
    return STAGE_ALIASES.get(stage or "")


def stage_states(status: str, stage: str | None) -> list[str]:
    """Состояние каждого этапа: done, current, failed или pending. Сбой без известного этапа: на первом."""
    if status == "done":
        return ["done"] * len(STAGES)
    current = stage_index(stage)
    if current is None:
        current = -1 if status == "queued" else 0
    states = []
    for index in range(len(STAGES)):
        if index < current:
            states.append("done")
        elif index == current:
            states.append("failed" if status == "failed" else "current")
        else:
            states.append("pending")
    return states


def cost_json(cost: Cost) -> dict[str, Any]:
    return {"tokens": cost.tokens, "usd": round(cost.usd, 6), "priced": cost.priced, "text": format_cost(cost)}


def run_json(row: dict[str, Any], cost: Cost) -> dict[str, Any]:
    """Строка runs для /api/runs: сами поля, примерный расход и подписи. Страница строится из того же."""
    label, tone = RUN_STATUSES.get(row["status"], (row["status"], "neutral"))
    states = stage_states(row["status"], row["stage"])
    return {
        **row,
        "error": redact(row["error"]),
        "cost": cost_json(cost),
        "status_label": label,
        "status_tone": tone,
        "stage_label": next((name for code, name, _ in STAGES if row["stage"] in (code, name)), row["stage"]),
        "stages": [{"code": code, "label": name, "state": state, "state_label": STAGE_STATE_LABELS[state]}
                   for (code, name, _), state in zip(STAGES, states, strict=True)],
        "finished": row["status"] in FINISHED_RUN_STATUSES,
    }


def run_view(row: dict[str, Any], cost: Cost) -> dict[str, Any]:
    view = run_json(row, cost)
    stages = [
        {**stage, "hint": STAGE_HINTS[stage["code"]],
         "counters": [{"field": field, "label": text, "value": row[field]} for field, text in counters]}
        for stage, (_, _, counters) in zip(view["stages"], STAGES, strict=True)
    ]
    return {**view, "stages": stages, "city_name": CITIES.get(row["city"], row["city"]), "cost": cost,
            "cost_text": format_cost(cost), "companies_url": companies_url(run_id=row["id"])}


def draft_summary(review_status: str | None, check_result: Any) -> dict[str, Any] | None:
    if review_status is None:
        return None
    checks = parse_checks(check_result)
    return {
        "review_status": review_status,
        "review_label": REVIEW_LABELS.get(review_status, review_status),
        "checks_total": len(checks),
        "checks_failed": sum(1 for check in checks if not check["passed"]),
    }


def contact_view(row: dict[str, Any]) -> dict[str, Any]:
    label, tone = VERIFY_RESULTS.get(row.get("verify_result"), (str(row.get("verify_result")), "neutral"))
    flags = []
    if row.get("is_catch_all"):
        flags.append("принимает любые адреса")
    if row.get("is_role"):
        flags.append("общий ящик")
    return {**row, "verify_label": label, "verify_tone": tone, "flags": flags,
            "source_href": safe_href(row.get("source_page"))}


def company_row_view(row: dict[str, Any]) -> dict[str, Any]:
    label, tone = COMPANY_STATUSES.get(row["status"], (row["status"], "neutral"))
    contact = contact_view(row) if row.get("email") else None
    return {
        **row, "status_label": label, "status_tone": tone, "city_name": CITIES.get(row["city"], row["city"]),
        "fit_label": FIT_LABELS.get(row.get("fit"), row.get("fit")), "contact": contact,
        "draft": draft_summary(row.get("review_status"), row.get("check_result")),
        "url": f"/companies/{row['id']}",
    }


@dataclass(frozen=True)
class CompanyFilters:
    run_id: int | None
    status: str | None
    q: str
    page: int


def companies_context(conn, filters: CompanyFilters) -> dict[str, Any]:
    counts = fetch_status_counts(conn, filters.run_id, filters.q)
    total_all = sum(counts.values())
    total = counts.get(filters.status, 0) if filters.status else total_all
    pages = max(1, math.ceil(total / COMPANIES_PER_PAGE))
    page = min(filters.page, pages)
    rows = fetch_companies(conn, filters.run_id, filters.status, filters.q, page)
    first = (page - 1) * COMPANIES_PER_PAGE + 1 if rows else 0
    run = fetch_run(conn, filters.run_id) if filters.run_id is not None else None
    cards = [{"label": label, "count": total_all if not code else counts.get(code, 0),
              "url": companies_url(filters.run_id, code or None, filters.q), "selected": (filters.status or "") == code}
             for code, label in STATUS_CARDS]
    statuses = [{"code": code, "label": label, "count": counts.get(code, 0)}
                for code, (label, _) in COMPANY_STATUSES.items()]
    return {
        "title": "Компании", "nav": "companies", "filters": filters, "rows": [company_row_view(r) for r in rows],
        "cards": cards, "statuses": statuses, "total": total, "first": first, "last": first + len(rows) - 1,
        "page": page, "pages": pages,
        "prev_url": companies_url(filters.run_id, filters.status, filters.q, page - 1) if page > 1 else None,
        "next_url": companies_url(filters.run_id, filters.status, filters.q, page + 1) if page < pages else None,
        "run": run_view(run, Cost()) if run else None,
        "run_choices": [run_view(r, Cost()) for r in fetch_recent_runs(conn, RUN_FILTER_CHOICES)],
        "clear_url": "/companies", "max_query_length": pipeline.MAX_QUERY_LENGTH,
    }


def company_context(conn, company_id: int) -> dict[str, Any] | None:
    if company_id > MAX_DB_ID:
        return None
    company = _row(conn, (
        "SELECT id, name, city, rubric, address, phones, website, source_url, branches_count, site_text,"
        " status, last_error, run_id, created_at FROM companies WHERE id = %s"), (company_id,))
    if company is None:
        return None
    qualification = _row(conn, (
        "SELECT fit, score, reason, segment, model, created_at FROM qualifications WHERE company_id = %s"
        " ORDER BY created_at DESC, id DESC LIMIT 1"), (company_id,))
    contacts = _rows(conn, (
        "SELECT id, email, source_page, verify_result, is_catch_all, is_role, verified_at FROM contacts"
        f" WHERE company_id = %s ORDER BY {CONTACT_ORDER}"), (company_id,))
    draft = _row(conn, (
        "SELECT d.id, d.kind, d.subject, d.body, d.model, d.check_result, d.review_status, d.approved_by,"
        " d.approved_at, d.sent_at, d.created_at, d.updated_at, ct.email AS to_email FROM drafts d"
        " LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.company_id = %s"
        " ORDER BY d.created_at DESC, d.id DESC LIMIT 1"), (company_id,))
    label, tone = COMPANY_STATUSES.get(company["status"], (company["status"], "neutral"))
    site_text = company["site_text"] or ""
    website_href = safe_href(company["website"])
    return {
        "title": company["name"], "nav": "companies",
        "company": {**company, "status_label": label, "status_tone": tone, "last_error": redact(company["last_error"]),
                    "city_name": CITIES.get(company["city"], company["city"]),
                    "website_href": website_href,
                    "website_text": display_url(website_href) if website_href else company["website"],
                    "source_href": safe_href(company["source_url"]),
                    "phones": [{"text": p, "href": tel_href(p)} for p in company["phones"] or []]},
        "qualification": ({**qualification, "fit_label": FIT_LABELS.get(qualification["fit"], qualification["fit"])}
                          if qualification else None),
        "contacts": [contact_view(c) for c in contacts],
        "draft": draft_view(draft) if draft else None,
        "site_text": site_text[:SITE_TEXT_PREVIEW_CHARS], "site_text_length": len(site_text),
        "site_text_truncated": len(site_text) > SITE_TEXT_PREVIEW_CHARS,
        "company_cost": format_cost(fetch_company_cost(conn, company_id)),
        "run_url": companies_url(run_id=company["run_id"]) if company["run_id"] else None,
    }


def draft_view(draft: dict[str, Any]) -> dict[str, Any]:
    # Непройденные проверки первыми: их нужно прочитать до одобрения.
    checks = sorted(parse_checks(draft["check_result"]), key=lambda check: check["passed"])
    editable = draft["sent_at"] is None and draft["review_status"] != "rejected"
    return {
        **draft, "lines": body_lines(draft["body"]), "checks": checks,
        "checks_failed": sum(1 for check in checks if not check["passed"]),
        "review_label": REVIEW_LABELS.get(draft["review_status"], draft["review_status"]),
        "can_approve": editable and draft["review_status"] != "approved",
        "can_reject": editable, "can_edit": editable,
    }


def search_form(city: str = DEFAULT_CITY, query: str = "", max_companies: str | int = DEFAULT_MAX_COMPANIES) -> dict:
    return {"city": city if city in CITIES else DEFAULT_CITY, "query": query[: pipeline.MAX_QUERY_LENGTH],
            "max_companies": str(max_companies)[:4]}


def validate_draft_edit(subject: str, body: str) -> tuple[str, str, str | None]:
    """Тема и текст после правки: CRLF → LF, пустое и слишком длинное не пускаем."""
    subject = " ".join(subject.split())
    body = body.replace("\r\n", "\n").replace("\r", "\n").strip("\n")
    if not subject or not body.strip():
        return subject, body, "Тема и текст письма не должны быть пустыми."
    if len(subject) > MAX_SUBJECT_LENGTH or len(body) > MAX_BODY_LENGTH:
        return subject, body, f"Тема до {MAX_SUBJECT_LENGTH} символов, текст до {fmt_int(MAX_BODY_LENGTH)} символов."
    return subject, body, None


# ---------- приложение ----------


def _static_version() -> str:
    digest = hashlib.sha256(__version__.encode())
    for path in sorted(p for p in STATIC_DIR.glob("*") if p.is_file()):
        digest.update(path.name.encode() + path.read_bytes())
    return digest.hexdigest()[:10]


def _make_templates() -> Jinja2Templates:
    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR), autoescape=True, undefined=StrictUndefined,
                      trim_blocks=True, lstrip_blocks=True)
    version = _static_version()
    env.globals["static"] = lambda name: f"/static/{name}?v={version}"
    env.filters.update(fmt_int=fmt_int, fmt_dt=fmt_dt, plural=plural)
    return Jinja2Templates(env=env)


async def _security_headers(request: Request, call_next: Callable) -> Response:
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    # Адрес интерфейса не уходит на сайты компаний. no-referrer не годится: с ним браузер шлёт в POST «Origin: null».
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if not request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def create_app(connect: Callable[[], psycopg.Connection], start_run: Callable[[str, str, int], int], *,
               csrf_token: str | None = None) -> FastAPI:
    """Собрать приложение. connect открывает соединение на запрос, start_run запускает поиск в фоне."""
    token = csrf_token or secrets.token_urlsafe(32)
    templates = _make_templates()
    app = FastAPI(title="Tanbala", docs_url=None, redoc_url=None, openapi_url=None)
    app.middleware("http")(_security_headers)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOSTS))
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @contextmanager
    def open_conn() -> Iterator[psycopg.Connection]:
        conn = connect()
        try:
            yield conn
        finally:
            conn.close()

    def get_conn() -> Iterator[psycopg.Connection]:
        with open_conn() as conn:
            yield conn

    async def csrf_guard(request: Request) -> None:
        """Каждый POST: своё Origin (если браузер его прислал) и токен из скрытого поля формы."""
        origin = request.headers.get("origin")
        own_origin = f"{request.url.scheme}://{request.headers.get('host', '')}"
        if origin is not None and origin != own_origin:
            raise HTTPException(403, ERROR_MESSAGES[403])
        if request.headers.get("sec-fetch-site") == "cross-site":
            raise HTTPException(403, ERROR_MESSAGES[403])
        length = request.headers.get("content-length", "")
        if length.isascii() and length.isdigit() and int(length) > MAX_FORM_BYTES:
            raise HTTPException(413, "Слишком большой запрос.")
        form = await request.form()
        sent = form.get("csrf_token")
        if not isinstance(sent, str) or not secrets.compare_digest(sent.encode(), token.encode()):
            raise HTTPException(403, ERROR_MESSAGES[403])

    def render(request: Request, name: str, context: dict[str, Any], *, conn: psycopg.Connection | None = None,
               status_code: int = 200) -> HTMLResponse:
        api_cost = fetch_total_cost(conn) if conn is not None else None
        full = {"csrf_token": token, "api_cost": api_cost,
                "api_cost_text": f"≈ {format_usd(api_cost.usd)}" if api_cost else "", "token_forms": TOKEN_FORMS, **context}
        return templates.TemplateResponse(request, name, full, status_code=status_code)

    def render_search(request: Request, conn, *, form: dict, run_id: int | None = None,
                      message: str | None = None, status_code: int = 200) -> HTMLResponse:
        active = fetch_active_run(conn)
        recent = fetch_recent_runs(conn, RECENT_RUNS)
        shown = (fetch_run(conn, run_id) if run_id is not None else None) or active or (recent[0] if recent else None)
        ids = sorted({row["id"] for row in recent} | ({shown["id"]} if shown else set()))
        costs = fetch_run_costs(conn, ids)
        limit = pipeline.MAX_COMPANIES_LIMIT
        context = {
            "title": "Поиск", "nav": "search", "cities": CITIES, "form": form, "message": message,
            "quick_queries": QUICK_QUERIES, "max_limit": limit, "max_query_length": pipeline.MAX_QUERY_LENGTH,
            "calls_per_company": APPROX_CALLS_PER_COMPANY, "usd_per_company": format_approx_usd(APPROX_USD_PER_COMPANY),
            "estimates": {str(n): format_estimate(n) for n in range(1, limit + 1)},
            "estimate": format_estimate(parse_id(form["max_companies"]) or DEFAULT_MAX_COMPANIES),
            "run": run_view(shown, costs.get(shown["id"], Cost())) if shown else None,
            "active_run": run_view(active, Cost()) if active else None,
            "history": [run_view(row, costs.get(row["id"], Cost())) for row in recent],
            "poll_ms": POLL_INTERVAL_MS,
            "stage_legend": [{"code": code, "label": label, "hint": STAGE_HINTS[code]} for code, label, _ in STAGES],
        }
        return render(request, "search.html", context, conn=conn, status_code=status_code)

    def render_company(request: Request, conn, company_id: int, *, done: str | None = None,
                       edit: dict | None = None, status_code: int = 200) -> HTMLResponse:
        context = company_context(conn, company_id)
        if context is None:
            raise HTTPException(404, "Компания не найдена.")
        draft = context["draft"]
        default_edit = {"subject": draft["subject"], "body": draft["body"], "error": None} if draft else None
        context.update(done_message=DONE_MESSAGES.get(done or ""), edit=edit or default_edit,
                       edit_open=bool(edit and edit.get("error")))
        return render(request, "company.html", context, conn=conn, status_code=status_code)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        detail = exc.detail if isinstance(exc.detail, str) else ""
        if not detail or detail == HTTPStatus(exc.status_code).phrase:
            detail = ERROR_MESSAGES.get(exc.status_code, "Что-то пошло не так.")
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": detail}, status_code=exc.status_code)
        context = {"title": "Ошибка", "nav": "", "status_code": exc.status_code, "message": detail}
        return render(request, "error.html", context, status_code=exc.status_code)

    @app.exception_handler(psycopg.Error)
    async def db_error(request: Request, exc: psycopg.Error) -> Response:
        # Текст ошибки не пишем: в нём бывают адрес сервера и имя пользователя базы.
        logger.error("Ошибка базы данных: %s, sqlstate=%s", type(exc).__name__, getattr(exc, "sqlstate", None))
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": DB_ERROR_MESSAGE}, status_code=503)
        context = {"title": "База недоступна", "nav": "", "status_code": 503, "message": DB_ERROR_MESSAGE}
        return render(request, "error.html", context, status_code=503)

    @app.get("/", response_class=HTMLResponse)
    def search_page(request: Request, run: str | None = None, q: str | None = None,
                    conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_search(request, conn, form=search_form(query=(q or "").strip()), run_id=parse_id(run))

    @app.post("/runs", dependencies=[Depends(csrf_guard)])
    def create_run(request: Request, city: str = Form(""), query: str = Form(""),
                   max_companies: str = Form("")) -> Response:
        form = search_form(city, query.strip(), max_companies.strip())
        count = parse_id(max_companies)
        try:
            if count is None:
                raise ValueError(f"Число компаний должно быть от 1 до {pipeline.MAX_COMPANIES_LIMIT}")
            run_id = start_run(city, query.strip(), count)
        except pipeline.RunAlreadyActive as exc:
            message, status_code = str(exc), 409
        except ValueError as exc:
            message, status_code = str(exc), 400
        else:
            return RedirectResponse(f"/?run={int(run_id)}", status_code=303)
        with open_conn() as conn:
            return render_search(request, conn, form=form, message=message, status_code=status_code)

    @app.get("/companies", response_class=HTMLResponse)
    def companies_page(request: Request, run: str | None = None, status: str | None = None, q: str | None = None,
                       page: str | None = None, conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        filters = CompanyFilters(
            run_id=parse_id(run), status=status if status in COMPANY_STATUSES else None,
            q=" ".join((q or "").split())[: pipeline.MAX_QUERY_LENGTH], page=max(1, parse_id(page) or 1))
        return render(request, "companies.html", companies_context(conn, filters), conn=conn)

    @app.get("/companies/{company_id:int}", response_class=HTMLResponse)
    def company_page(request: Request, company_id: int, done: str | None = None,
                     conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_company(request, conn, company_id, done=done)

    def review_action(conn, draft_id: int, action: Callable[[], None], done: str, *,
                      allow_rejected: bool = False) -> Response:
        draft = fetch_draft(conn, draft_id)
        company_id = draft["company_id"]
        # Кнопки отклонённого письма скрыты; старая вкладка или повтор запроса не должны его вернуть.
        if draft["review_status"] == "rejected" and not allow_rejected:
            raise HTTPException(409, "Письмо уже отклонено. Новый черновик напишет следующий запуск.")
        try:
            action()
        except approve_step.DraftNotFound as exc:
            raise HTTPException(404, "Письмо не найдено или уже отправлено.") from exc
        except psycopg.errors.IntegrityError as exc:
            raise HTTPException(409, "У компании уже есть другое активное письмо.") from exc
        return RedirectResponse(f"/companies/{company_id}?done={done}", status_code=303)

    @app.post("/drafts/{draft_id:int}/approve", dependencies=[Depends(csrf_guard)])
    def approve_draft(draft_id: int, conn: psycopg.Connection = Depends(get_conn)) -> Response:
        return review_action(conn, draft_id, lambda: approve_step.approve(conn, draft_id, REVIEWER), "approved")

    @app.post("/drafts/{draft_id:int}/reject", dependencies=[Depends(csrf_guard)])
    def reject_draft(draft_id: int, conn: psycopg.Connection = Depends(get_conn)) -> Response:
        return review_action(conn, draft_id, lambda: approve_step.reject(conn, draft_id, REVIEWER), "rejected",
                             allow_rejected=True)

    @app.post("/drafts/{draft_id:int}/edit", dependencies=[Depends(csrf_guard)])
    def edit_draft(request: Request, draft_id: int, subject: str = Form(""), body: str = Form(""),
                   conn: psycopg.Connection = Depends(get_conn)) -> Response:
        company_id = fetch_draft(conn, draft_id)["company_id"]
        subject, body, error = validate_draft_edit(subject, body)
        if error:
            edit = {"subject": subject, "body": body, "error": error}
            return render_company(request, conn, company_id, edit=edit, status_code=400)
        return review_action(conn, draft_id, lambda: approve_step.update_draft(conn, draft_id, subject, body), "saved")

    @app.get("/api/runs/active")
    def api_active_run(conn: psycopg.Connection = Depends(get_conn)) -> JSONResponse:
        row = fetch_active_run(conn)
        if row is None:
            raise HTTPException(404, "Сейчас ничего не идёт.")
        return JSONResponse(jsonable_encoder(run_json(row, fetch_run_costs(conn, [row["id"]]).get(row["id"], Cost()))))

    @app.get("/api/runs/{run_id:int}")
    def api_run(run_id: int, conn: psycopg.Connection = Depends(get_conn)) -> JSONResponse:
        row = fetch_run(conn, run_id) if run_id <= MAX_DB_ID else None
        if row is None:
            raise HTTPException(404, "Запуск не найден.")
        return JSONResponse(jsonable_encoder(run_json(row, fetch_run_costs(conn, [run_id]).get(run_id, Cost()))))

    return app


def serve(host: str = BIND_HOST, port: int = 8000) -> None:
    """Настоящее приложение: миграции, пометить прерванные запуски, uvicorn только на 127.0.0.1."""
    if host != BIND_HOST:
        raise ValueError(f"Интерфейс слушает только {BIND_HOST}: он может тратить деньги на API")
    dsn = load_settings().require("database_url")
    with db.connect(dsn) as conn:
        db.migrate(conn)
        pipeline.recover_stale_runs(conn)
    app = create_app(
        connect=lambda: db.connect(dsn),
        start_run=lambda city, query, n: pipeline.start_run(dsn, city, query, n),
    )
    uvicorn.run(app, host=host, port=port, proxy_headers=False, server_header=False)
