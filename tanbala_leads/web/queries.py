"""Чтение из базы для страниц. Все значения передаются параметрами; в тексте SQL только константы этого модуля."""

from typing import Any

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.web.format import Cost, cost_from_rows, escape_like
from tanbala_leads.web.labels import COMPANIES_PER_PAGE, LETTER_FILTERS, LETTERS_IN_LIST, MAX_DB_ID

RUN_COLUMNS = (
    "id, city, query, max_companies, status, stage, found, new_companies, crawled, qualified, rejected,"
    " verified, drafted, errors, error, created_at, started_at, finished_at, stage_detail"
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
SELECT c.id, c.name, c.rubric, c.city, c.status, c.created_at, c.last_error, c.search_query,
       q.score, q.fit, ct.email, ct.verify_result, ct.is_catch_all, ct.is_role,
       d.id AS draft_id, d.subject, d.review_status, d.check_result
FROM companies c
LEFT JOIN LATERAL (SELECT score, fit FROM qualifications WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) q ON true
LEFT JOIN LATERAL (SELECT email, verify_result, is_catch_all, is_role FROM contacts WHERE company_id = c.id
                   ORDER BY {CONTACT_ORDER} LIMIT 1) ct ON true
LEFT JOIN LATERAL (SELECT id, subject, review_status, check_result FROM drafts WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) d ON true
{{where}}
ORDER BY c.created_at DESC, c.id DESC
LIMIT %s OFFSET %s
"""
# Последняя квалификация компании (алиас c) и сколько её болей подтверждено цитатой.
QUAL_LATERAL = """LEFT JOIN LATERAL (
    SELECT ql.score, ql.fit, ql.reason, ql.segment, ql.pains,
           (SELECT count(*) FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(ql.pains) = 'array' THEN ql.pains ELSE '[]'::jsonb END) AS p
            WHERE p->>'verified' = 'true')::int AS verified_pains
    FROM qualifications ql WHERE ql.company_id = c.id ORDER BY ql.created_at DESC, ql.id DESC LIMIT 1) q ON true"""
# «Не писать»: сама компания или её домен (с поддоменами). Для письма ещё адрес получателя и его домен.
COMPANY_BLOCKED = """EXISTS (SELECT 1 FROM do_not_contact x WHERE x.company_id = c.id
    OR (c.website_domain IS NOT NULL AND (x.domain = c.website_domain
        OR right(c.website_domain, length(x.domain) + 1) = '.' || x.domain)))"""
LETTER_BLOCKED = """EXISTS (SELECT 1 FROM do_not_contact x WHERE x.company_id = c.id
    OR (c.website_domain IS NOT NULL AND (x.domain = c.website_domain
        OR right(c.website_domain, length(x.domain) + 1) = '.' || x.domain))
    OR x.email = ct.email OR x.domain = split_part(ct.email, '@', 2)
    OR right(split_part(ct.email, '@', 2), length(x.domain) + 1) = '.' || x.domain)"""
# Порядок проверки: лучшая оценка, больше подтверждённых болей, раньше написано. Ключ для «следующего письма».
QUEUE_ORDER = "coalesce(q.score, -1) DESC, coalesce(q.verified_pains, 0) DESC, d.created_at, d.id"
QUEUE_KEY = "(-coalesce(q.score, -1), -coalesce(q.verified_pains, 0), d.created_at, d.id)"
# Письма запуска: компания найдена в этом запуске или черновик написан, пока запуск шёл
# (запуск дорабатывает и компании прошлых запусков; одновременно идёт только один запуск).
LETTER_RUN_CLAUSE = (
    "(c.run_id = %s OR EXISTS (SELECT 1 FROM runs r WHERE r.id = %s AND d.created_at >= r.started_at"
    " AND d.created_at <= coalesce(r.finished_at, now())))"
)
# Очередь: ждущие проверки по QUEUE_ORDER; решённые — сначала последние.
LETTER_ORDER = {
    "pending": QUEUE_ORDER,
    "approved": "d.updated_at DESC, d.id DESC",
    "rejected": "d.updated_at DESC, d.id DESC",
    "all": ("(d.review_status = 'pending') DESC, CASE WHEN d.review_status = 'pending' THEN -coalesce(q.score, -1) END,"
            " CASE WHEN d.review_status = 'pending' THEN -coalesce(q.verified_pains, 0) END,"
            " CASE WHEN d.review_status = 'pending' THEN d.created_at END,"
            " CASE WHEN d.review_status = 'pending' THEN d.id END, d.updated_at DESC, d.id DESC"),
}
LETTER_REVIEW = {code: review for code, _, review in LETTER_FILTERS}
LETTER_FROM = f"""FROM drafts d JOIN companies c ON c.id = d.company_id
LEFT JOIN contacts ct ON ct.id = d.contact_id
{QUAL_LATERAL}"""
LETTER_LIST_SQL = f"""
SELECT d.id, d.kind, d.subject, d.review_status, d.check_result, d.sent_at, d.created_at, d.updated_at,
       c.id AS company_id, c.name AS company_name, c.search_query, q.score, q.verified_pains,
       {LETTER_BLOCKED} AS blocked
{LETTER_FROM}
{{where}}
ORDER BY {{order}}
LIMIT %s
"""
LETTER_SQL = f"""
SELECT d.id, d.kind, d.subject, d.body, d.model, d.check_result, d.review_status, d.approved_by, d.approved_at,
       d.sent_at, d.created_at, d.updated_at,
       c.id AS company_id, c.name AS company_name, c.rubric, c.city, c.website, c.source_url, c.run_id,
       c.search_query, c.whatsapp_contacted_at,
       ct.email AS to_email, ct.verify_result, ct.is_catch_all, ct.is_role,
       q.score, q.fit, q.reason, q.segment, q.pains, {LETTER_BLOCKED} AS blocked
{LETTER_FROM}
WHERE d.id = %s
"""
OVERVIEW_SQL = f"""
SELECT (SELECT count(*) FROM companies) AS companies,
       (SELECT count(*) FROM companies WHERE status = ANY(%(fit)s)) AS fit,
       (SELECT round(avg(q.score)) FROM companies c {QUAL_LATERAL} WHERE c.status = ANY(%(fit)s)) AS avg_score,
       (SELECT count(*) FROM drafts WHERE review_status = 'pending') AS pending,
       (SELECT count(*) FROM drafts WHERE review_status = 'approved') AS approved
"""


def _rows(conn: psycopg.Connection, sql: str, params: tuple | list = ()) -> list[dict[str, Any]]:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchall()


def _row(conn: psycopg.Connection, sql: str, params: tuple | list = ()) -> dict[str, Any] | None:
    with conn.cursor(row_factory=dict_row) as cur:
        return cur.execute(sql, params).fetchone()


# ---------- запуски и расходы ----------


def fetch_run(conn, run_id: int) -> dict[str, Any] | None:
    if run_id > MAX_DB_ID:
        return None
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


# ---------- компании ----------


def _company_where(run_id: int | None, q: str, status: str | None = None,
                   query: str | None = None) -> tuple[str, list[Any]]:
    clauses, params = [], []
    if run_id is not None:
        clauses.append("c.run_id = %s")
        params.append(run_id)
    if query:
        clauses.append("c.search_query = %s")
        params.append(query)
    if q:
        pattern = f"%{escape_like(q)}%"
        clauses.append("(c.name ILIKE %s OR c.rubric ILIKE %s)")
        params += [pattern, pattern]
    if status:
        clauses.append("c.status = %s")
        params.append(status)
    return ("WHERE " + " AND ".join(clauses) if clauses else ""), params


def fetch_status_counts(conn, run_id: int | None, q: str, query: str | None = None) -> dict[str, int]:
    where, params = _company_where(run_id, q, query=query)
    rows = _rows(conn, f"SELECT c.status, count(*) AS n FROM companies c {where} GROUP BY c.status", params)
    return {row["status"]: row["n"] for row in rows}


def fetch_industry_counts(conn, run_id: int | None, q: str, status: str | None) -> list[dict[str, Any]]:
    """Отрасли (companies.search_query) с числом компаний при остальных фильтрах; без отрасли не считаем."""
    where, params = _company_where(run_id, q, status)
    where = f"{where} AND c.search_query IS NOT NULL" if where else "WHERE c.search_query IS NOT NULL"
    return _rows(conn, (f"SELECT c.search_query AS query, count(*) AS n FROM companies c {where}"
                        " GROUP BY c.search_query ORDER BY n DESC, c.search_query"), params)


def fetch_companies(conn, run_id: int | None, status: str | None, q: str, page: int,
                    query: str | None = None) -> list[dict[str, Any]]:
    where, params = _company_where(run_id, q, status, query)
    offset = (page - 1) * COMPANIES_PER_PAGE
    return _rows(conn, COMPANY_LIST_SQL.format(where=where), [*params, COMPANIES_PER_PAGE, offset])


def fetch_company(conn, company_id: int) -> dict[str, Any] | None:
    if company_id > MAX_DB_ID:
        return None
    return _row(conn, (
        "SELECT c.id, c.name, c.city, c.rubric, c.address, c.phones, c.website, c.website_domain, c.source_url,"
        " c.search_query,"
        " c.branches_count, c.site_text, c.status, c.last_error, c.run_id, c.created_at, c.whatsapp_contacted_at,"
        " c.requested_via,"
        f" {COMPANY_BLOCKED} AS blocked FROM companies c WHERE c.id = %s"), (company_id,))


def fetch_qualification(conn, company_id: int) -> dict[str, Any] | None:
    return _row(conn, (
        "SELECT fit, score, reason, segment, pains, model, created_at FROM qualifications WHERE company_id = %s"
        " ORDER BY created_at DESC, id DESC LIMIT 1"), (company_id,))


# ---------- сводка и «Кому писали» ----------


def fetch_overview(conn, fit_statuses: tuple[str, ...]) -> dict[str, Any]:
    return _row(conn, OVERVIEW_SQL, {"fit": list(fit_statuses)})


def fetch_history_page(conn, page: int, per_page: int) -> tuple[list[dict[str, Any]], int]:
    """Кому писали: все записи contact_history, новые сверху, с компанией, если она известна."""
    total = _row(conn, "SELECT count(*) AS n FROM contact_history")["n"]
    rows = _rows(conn, (
        "SELECT h.id, h.occurred_at, h.email, h.direction, h.kind, h.source, h.note, h.company_id,"
        " c.name AS company_name FROM contact_history h LEFT JOIN companies c ON c.id = h.company_id"
        " ORDER BY h.occurred_at DESC, h.id DESC LIMIT %s OFFSET %s"), (per_page, (page - 1) * per_page))
    return rows, total


def fetch_blocked_page(conn, page: int, per_page: int) -> tuple[list[dict[str, Any]], int]:
    """Список «не писать»: адрес, домен или компания, причина, заметка, дата."""
    total = _row(conn, "SELECT count(*) AS n FROM do_not_contact")["n"]
    rows = _rows(conn, (
        "SELECT x.id, x.email, x.domain, x.company_id, c.name AS company_name, x.reason, x.note, x.created_at"
        " FROM do_not_contact x LEFT JOIN companies c ON c.id = x.company_id"
        " ORDER BY x.created_at DESC, x.id DESC LIMIT %s OFFSET %s"), (per_page, (page - 1) * per_page))
    return rows, total


def fetch_contacts(conn, company_id: int) -> list[dict[str, Any]]:
    return _rows(conn, (
        "SELECT id, email, source_page, verify_result, is_catch_all, is_role, verified_at FROM contacts"
        f" WHERE company_id = %s ORDER BY {CONTACT_ORDER}"), (company_id,))


def fetch_latest_draft(conn, company_id: int) -> dict[str, Any] | None:
    return _row(conn, (
        "SELECT d.id, d.kind, d.subject, d.body, d.model, d.check_result, d.review_status, d.approved_by,"
        " d.approved_at, d.sent_at, d.created_at, d.updated_at, ct.email AS to_email FROM drafts d"
        " LEFT JOIN contacts ct ON ct.id = d.contact_id WHERE d.company_id = %s"
        " ORDER BY d.created_at DESC, d.id DESC LIMIT 1"), (company_id,))


# ---------- письма ----------


def fetch_draft_ref(conn, draft_id: int) -> dict[str, Any] | None:
    """Компания, статус, «не писать» и место письма в очереди: для проверок перед действием и поиска следующего."""
    if draft_id > MAX_DB_ID:
        return None
    sql = (f"SELECT d.id, d.company_id, d.review_status, {LETTER_BLOCKED} AS blocked, -coalesce(q.score, -1) AS k1,"
           f" -coalesce(q.verified_pains, 0) AS k2, d.created_at {LETTER_FROM} WHERE d.id = %s")
    return _row(conn, sql, (draft_id,))


def _letter_where(run_id: int | None, review_status: str | None = None) -> tuple[list[str], list[Any]]:
    clauses, params = [], []
    if run_id is not None:
        clauses.append(LETTER_RUN_CLAUSE)
        params += [run_id, run_id]
    if review_status:
        clauses.append("d.review_status = %s")
        params.append(review_status)
    return clauses, params


def fetch_letter_counts(conn, run_id: int | None) -> dict[str, int]:
    clauses, params = _letter_where(run_id)
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    rows = _rows(conn, ("SELECT d.review_status, count(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id"
                        f" {where} GROUP BY d.review_status"), params)
    return {row["review_status"]: row["n"] for row in rows}


def letter_blocked(conn, draft_id: int) -> bool:
    row = _row(conn, f"SELECT {LETTER_BLOCKED} AS blocked {LETTER_FROM} WHERE d.id = %s", (draft_id,))
    return bool(row and row["blocked"])


def fetch_letters(conn, filter_code: str, run_id: int | None) -> list[dict[str, Any]]:
    clauses, params = _letter_where(run_id, LETTER_REVIEW[filter_code])
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    sql = LETTER_LIST_SQL.format(where=where, order=LETTER_ORDER[filter_code])
    return _rows(conn, sql, [*params, LETTERS_IN_LIST])


def fetch_letter(conn, draft_id: int) -> dict[str, Any] | None:
    if draft_id > MAX_DB_ID:
        return None
    return _row(conn, LETTER_SQL, (draft_id,))


def fetch_next_pending(conn, after: dict[str, Any], run_id: int | None) -> int | None:
    """Следующее письмо, ждущее проверки, после данного в порядке очереди; если дальше нет, первое."""
    clauses, params = _letter_where(run_id, "pending")
    clauses.append("d.id <> %s")
    params.append(after["id"])
    sql = (f"SELECT d.id {LETTER_FROM} WHERE " + " AND ".join(clauses)
           + f" ORDER BY ({QUEUE_KEY} > (%s, %s, %s, %s)) DESC, {QUEUE_ORDER} LIMIT 1")
    row = _row(conn, sql, [*params, after["k1"], after["k2"], after["created_at"], after["id"]])
    return row["id"] if row else None


def count_pending_letters(conn, run_id: int | None = None) -> int:
    clauses, params = _letter_where(run_id, "pending")
    sql = "SELECT count(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE " + " AND ".join(clauses)
    return _row(conn, sql, params)["n"]


# ---------- тестовые отправки ----------


def fetch_test_sends(conn, draft_id: int, limit: int) -> list[dict[str, Any]]:
    """Тестовые отправки письма (только на адрес владельца), новые сверху."""
    return _rows(conn, ("SELECT id, sent_to, real_to, status, error, created_at FROM test_sends WHERE draft_id = %s"
                        " ORDER BY created_at DESC, id DESC LIMIT %s"), (draft_id, limit))
