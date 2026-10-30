"""Чтение из базы для API консоли: то, чего нет у старых страниц. Значения только параметрами, в тексте SQL
только константы этого модуля и web/queries.py. Ничего не пишет.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.contact_policy import FREE_MAIL_DOMAINS
from tanbala_leads.internal import research
from tanbala_leads.steps import send as send_step
from tanbala_leads.web import queries as q
from tanbala_leads.web.format import escape_like

# Сутки консоли — по Алматы, UTC+5, как у бота (сдвиг постоянный).
ALMATY = timezone(timedelta(hours=5))
NOT_WHATSAPP = "c.requested_via IS DISTINCT FROM 'whatsapp'"
LAST_QUAL = """LEFT JOIN LATERAL (SELECT score, fit, segment FROM qualifications WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) q ON true"""
# «Не писать» для строки списка, как в карточке: сама компания или её домен (q.COMPANY_BLOCKED), а ещё адрес или
# домен получателя последнего письма компании (как q.LETTER_BLOCKED у этого письма).
LAST_LETTER_BLOCKED = """EXISTS (
    SELECT 1 FROM (SELECT ct.email FROM drafts ld JOIN contacts ct ON ct.id = ld.contact_id
                   WHERE ld.company_id = c.id ORDER BY ld.created_at DESC, ld.id DESC LIMIT 1) last
    JOIN do_not_contact x ON x.email = last.email OR x.domain = split_part(last.email, '@', 2)
        OR right(split_part(last.email, '@', 2), length(x.domain) + 1) = '.' || x.domain)"""
LIST_BLOCKED = f"({q.COMPANY_BLOCKED} OR {LAST_LETTER_BLOCKED})"
HAS_LETTER = "EXISTS (SELECT 1 FROM drafts dd WHERE dd.company_id = c.id)"
COMPANY_ORDER = {
    "new": "c.created_at DESC, c.id DESC",
    "score": "q.score DESC NULLS LAST, c.created_at DESC, c.id DESC",
    "letter": "d.created_at DESC NULLS LAST, c.created_at DESC, c.id DESC",
}
COMPANY_PAGE_SQL = f"""
SELECT c.id, c.name, c.rubric, c.city, c.status, c.created_at, c.last_error, c.search_query, c.requested_via,
       c.whatsapp_contacted_at, q.score, q.fit, q.segment, ct.email, ct.verify_result, ct.is_catch_all, ct.is_role,
       d.id AS draft_id, d.subject, d.review_status, d.check_result, {LIST_BLOCKED} AS blocked
FROM companies c
{LAST_QUAL}
LEFT JOIN LATERAL (SELECT email, verify_result, is_catch_all, is_role FROM contacts WHERE company_id = c.id
                   ORDER BY {q.CONTACT_ORDER} LIMIT 1) ct ON true
LEFT JOIN LATERAL (SELECT id, subject, review_status, check_result, created_at FROM drafts WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) d ON true
{{where}}
ORDER BY {{order}}
LIMIT %s OFFSET %s
"""
OVERVIEW_SQL = f"""
SELECT (SELECT count(*) FROM companies c WHERE {NOT_WHATSAPP}) AS companies,
       (SELECT count(*) FROM companies c WHERE {NOT_WHATSAPP} AND c.status = ANY(%(fit)s)) AS fit,
       (SELECT round(avg(q.score)) FROM companies c {q.QUAL_LATERAL}
        WHERE {NOT_WHATSAPP} AND c.status = ANY(%(fit)s)) AS avg_score,
       (SELECT count(*) FROM drafts d JOIN companies c ON c.id = d.company_id
        WHERE {NOT_WHATSAPP} AND d.review_status = 'pending') AS pending,
       (SELECT count(*) FROM drafts d JOIN companies c ON c.id = d.company_id
        WHERE {NOT_WHATSAPP} AND d.review_status = 'approved') AS approved,
       (SELECT count(*) FROM companies c WHERE c.requested_via = 'whatsapp') AS whatsapp
"""
# Расход по дням Алматы, моделям и задачам. Границы периода приходят из Python (UTC+5).
SPEND_SQL = """
SELECT to_char(created_at AT TIME ZONE INTERVAL '+05:00', 'YYYY-MM-DD') AS day, model, task,
       count(*)::int AS calls, sum(input_tokens)::bigint AS input, sum(output_tokens)::bigint AS output,
       sum(cache_read_tokens)::bigint AS cache_read, sum(cache_write_tokens)::bigint AS cache_write
FROM llm_calls
WHERE created_at >= %(start)s AND created_at < %(end)s
GROUP BY 1, model, task
ORDER BY 1, model, task
"""
# Письма компании — как internal/lookup.LAST_LETTER_SQL: по id, адресам, домену сайта и корпоративному домену почт.
# Тестовые отправки лежат в test_sends и не считаются.
DIGEST_SQL = f"""
SELECT c.id, c.name, c.city, c.rubric, c.status, c.requested_via, c.whatsapp_contacted_at,
       q.fit, q.score, q.segment, {LIST_BLOCKED} AS blocked, l.first_at, l.last_at
FROM companies c
{LAST_QUAL}
LEFT JOIN LATERAL (
    SELECT min(h.occurred_at) AS first_at, max(h.occurred_at) AS last_at FROM contact_history h
    WHERE h.direction = 'out'
      AND (h.company_id = c.id
           OR h.email IN (SELECT email FROM contacts WHERE company_id = c.id)
           OR h.domain = c.website_domain
           OR (h.domain IN (SELECT split_part(email, '@', 2) FROM contacts WHERE company_id = c.id)
               AND NOT h.domain = ANY(%(free_mail)s)))) l ON true
WHERE c.id = ANY(%(ids)s)
"""
# Поле error не выбирается: подробности сбоя наружу не отдаются. Телефон клиента бота тоже.
RESEARCH_COLUMNS = "id::text AS id, name, city, domain, status, reason, company_id, created_at, started_at, finished_at"


def _rows(conn: psycopg.Connection, sql: str, params: Any = ()) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def _value(conn: psycopg.Connection, sql: str, params: Any = ()) -> Any:
    return conn.execute(sql, params).fetchone()[0]


# ---------- сводка ----------


def overview(conn: psycopg.Connection, fit_statuses: tuple[str, ...]) -> dict[str, Any]:
    return _rows(conn, OVERVIEW_SQL, {"fit": list(fit_statuses)})[0]


def research_today(conn: psycopg.Connection) -> int:
    """Проверки из WhatsApp за сутки по Алматы, как считает дневной лимит RESEARCH_PER_DAY."""
    return _value(conn, research.TODAY_JOBS_SQL)


def test_sends_today(conn: psycopg.Connection) -> int:
    """Успешные тестовые отправки за сутки по Алматы, как считает лимит в steps/send.py."""
    return _value(conn, send_step.TODAY_SENDS_SQL)


def active_research_jobs(conn: psycopg.Connection) -> list[dict[str, Any]]:
    return _rows(conn, f"SELECT {RESEARCH_COLUMNS} FROM research_jobs WHERE status IN ('queued', 'running')"
                       " ORDER BY created_at, id")


def research_jobs_page(conn: psycopg.Connection, status: str | None, page: int,
                       per_page: int) -> tuple[list[dict[str, Any]], int]:
    where, params = ("WHERE status = %s", [status]) if status else ("", [])
    total = _value(conn, f"SELECT count(*) FROM research_jobs {where}", params)
    if (page - 1) * per_page >= total:
        return [], total
    rows = _rows(conn, f"SELECT {RESEARCH_COLUMNS} FROM research_jobs {where}"
                       " ORDER BY created_at DESC, id DESC LIMIT %s OFFSET %s", [*params, per_page, (page - 1) * per_page])
    return rows, total


# ---------- расход ----------


def spend_rows(conn: psycopg.Connection, start: date, end: date) -> list[dict[str, Any]]:
    """Строки llm_calls по дням (Алматы), моделям и задачам за дни от start до end включительно."""
    bounds = {"start": datetime.combine(start, time(0), ALMATY),
              "end": datetime.combine(end + timedelta(days=1), time(0), ALMATY)}
    return _rows(conn, SPEND_SQL, bounds)


# ---------- компании ----------


@dataclass(frozen=True)
class CompanyFilters:
    """Фильтры списка компаний: старые (запуск, статус, текст, отрасль) и новые (откуда, WhatsApp, «не писать»,
    есть письмо), сортировка и страница."""

    run_id: int | None = None
    status: str | None = None
    q: str = ""
    query: str | None = None  # отрасль: companies.search_query, точное совпадение
    via: str | None = None  # whatsapp или regular
    wa: bool = False  # писал в WhatsApp
    blocked: bool = False
    letter: bool = False
    sort: str = "new"
    page: int = 1


def company_where(filters: CompanyFilters, *, skip: tuple[str, ...] = ()) -> tuple[str, list[Any]]:
    """WHERE по фильтрам, кроме названных в skip (для чисел у самих фильтров)."""
    clauses: list[str] = []
    params: list[Any] = []
    if filters.run_id is not None:
        clauses.append("c.run_id = %s")
        params.append(filters.run_id)
    if filters.query and "query" not in skip:
        clauses.append("c.search_query = %s")
        params.append(filters.query)
    if filters.q:
        pattern = f"%{escape_like(filters.q)}%"
        clauses.append("(c.name ILIKE %s OR c.rubric ILIKE %s)")
        params += [pattern, pattern]
    if filters.status and "status" not in skip:
        clauses.append("c.status = %s")
        params.append(filters.status)
    if filters.via == "whatsapp":
        clauses.append("c.requested_via = 'whatsapp'")
    elif filters.via == "regular":
        clauses.append(NOT_WHATSAPP)
    if filters.wa:
        clauses.append("c.whatsapp_contacted_at IS NOT NULL")
    if filters.blocked:
        clauses.append(LIST_BLOCKED)
    if filters.letter:
        clauses.append(HAS_LETTER)
    return ("WHERE " + " AND ".join(clauses) if clauses else ""), params


def company_status_counts(conn: psycopg.Connection, filters: CompanyFilters) -> dict[str, int]:
    """Числа по статусам при всех фильтрах, кроме статуса."""
    where, params = company_where(filters, skip=("status",))
    rows = _rows(conn, f"SELECT c.status, count(*) AS n FROM companies c {where} GROUP BY c.status", params)
    return {row["status"]: row["n"] for row in rows}


def company_industry_counts(conn: psycopg.Connection, filters: CompanyFilters) -> list[dict[str, Any]]:
    """Отрасли с числами при всех фильтрах, кроме отрасли; компании без отрасли не считаются."""
    where, params = company_where(filters, skip=("query",))
    where = f"{where} AND c.search_query IS NOT NULL" if where else "WHERE c.search_query IS NOT NULL"
    return _rows(conn, (f"SELECT c.search_query AS query, count(*) AS n FROM companies c {where}"
                        " GROUP BY c.search_query ORDER BY n DESC, c.search_query"), params)


def companies_page(conn: psycopg.Connection, filters: CompanyFilters, per_page: int) -> list[dict[str, Any]]:
    where, params = company_where(filters)
    sql = COMPANY_PAGE_SQL.format(where=where, order=COMPANY_ORDER[filters.sort])
    return _rows(conn, sql, [*params, per_page, (filters.page - 1) * per_page])


def digest(conn: psycopg.Connection, ids: list[int]) -> list[dict[str, Any]]:
    return _rows(conn, DIGEST_SQL, {"ids": ids, "free_mail": sorted(FREE_MAIL_DOMAINS)})


# ---------- запуски ----------


def runs_page(conn: psycopg.Connection, page: int, per_page: int) -> tuple[list[dict[str, Any]], int]:
    total = _value(conn, "SELECT count(*) FROM runs")
    if (page - 1) * per_page >= total:
        return [], total
    rows = _rows(conn, f"SELECT {q.RUN_COLUMNS} FROM runs ORDER BY id DESC LIMIT %s OFFSET %s",
                 (per_page, (page - 1) * per_page))
    return rows, total
