"""Чтение из базы для страниц. Все значения передаются параметрами; в тексте SQL только константы этого модуля."""

from typing import Any

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.web.format import Cost, cost_from_rows, escape_like
from tanbala_leads.web.labels import COMPANIES_PER_PAGE, LETTER_FILTERS, LETTERS_IN_LIST, MAX_DB_ID

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
# Письма запуска: компания найдена в этом запуске или черновик написан, пока запуск шёл
# (запуск дорабатывает и компании прошлых запусков; одновременно идёт только один запуск).
LETTER_RUN_CLAUSE = (
    "(c.run_id = %s OR EXISTS (SELECT 1 FROM runs r WHERE r.id = %s AND d.created_at >= r.started_at"
    " AND d.created_at <= coalesce(r.finished_at, now())))"
)
# Очередь: ждущие проверки по порядку появления; решённые — сначала последние.
LETTER_ORDER = {
    "pending": "d.created_at, d.id",
    "approved": "d.updated_at DESC, d.id DESC",
    "rejected": "d.updated_at DESC, d.id DESC",
    "all": ("(d.review_status = 'pending') DESC, CASE WHEN d.review_status = 'pending' THEN d.created_at END,"
            " CASE WHEN d.review_status = 'pending' THEN d.id END, d.updated_at DESC, d.id DESC"),
}
LETTER_REVIEW = {code: review for code, _, review in LETTER_FILTERS}
LETTER_LIST_SQL = """
SELECT d.id, d.kind, d.subject, d.review_status, d.check_result, d.sent_at, d.created_at, d.updated_at,
       c.id AS company_id, c.name AS company_name
FROM drafts d JOIN companies c ON c.id = d.company_id
{where}
ORDER BY {order}
LIMIT %s
"""
LETTER_SQL = """
SELECT d.id, d.kind, d.subject, d.body, d.model, d.check_result, d.review_status, d.approved_by, d.approved_at,
       d.sent_at, d.created_at, d.updated_at,
       c.id AS company_id, c.name AS company_name, c.rubric, c.city, c.website, c.source_url, c.run_id,
       ct.email AS to_email, ct.verify_result, ct.is_catch_all, ct.is_role,
       q.score, q.fit, q.reason, q.segment
FROM drafts d
JOIN companies c ON c.id = d.company_id
LEFT JOIN contacts ct ON ct.id = d.contact_id
LEFT JOIN LATERAL (SELECT score, fit, reason, segment FROM qualifications WHERE company_id = c.id
                   ORDER BY created_at DESC, id DESC LIMIT 1) q ON true
WHERE d.id = %s
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


def fetch_company(conn, company_id: int) -> dict[str, Any] | None:
    if company_id > MAX_DB_ID:
        return None
    return _row(conn, (
        "SELECT id, name, city, rubric, address, phones, website, source_url, branches_count, site_text,"
        " status, last_error, run_id, created_at FROM companies WHERE id = %s"), (company_id,))


def fetch_qualification(conn, company_id: int) -> dict[str, Any] | None:
    return _row(conn, (
        "SELECT fit, score, reason, segment, model, created_at FROM qualifications WHERE company_id = %s"
        " ORDER BY created_at DESC, id DESC LIMIT 1"), (company_id,))


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
    """Компания, статус и время письма: для проверок перед действием и поиска следующего."""
    if draft_id > MAX_DB_ID:
        return None
    return _row(conn, "SELECT id, company_id, review_status, created_at FROM drafts WHERE id = %s", (draft_id,))


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
    sql = ("SELECT d.id FROM drafts d JOIN companies c ON c.id = d.company_id WHERE " + " AND ".join(clauses)
           + " ORDER BY ((d.created_at, d.id) > (%s, %s)) DESC, d.created_at, d.id LIMIT 1")
    row = _row(conn, sql, [*params, after["created_at"], after["id"]])
    return row["id"] if row else None


def count_pending_letters(conn, run_id: int | None = None) -> int:
    clauses, params = _letter_where(run_id, "pending")
    sql = "SELECT count(*) AS n FROM drafts d JOIN companies c ON c.id = d.company_id WHERE " + " AND ".join(clauses)
    return _row(conn, sql, params)["n"]
