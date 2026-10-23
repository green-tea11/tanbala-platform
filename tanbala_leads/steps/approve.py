"""Шаг 7. Одобрение человеком. Результат: drafts.review_status, статус компании approved."""

from dataclasses import asdict

import psycopg
from psycopg.types.json import Jsonb


class DraftNotFound(LookupError):
    """Черновика нет или он уже отправлен."""


def check_results_json(subject: str, body: str) -> list[dict]:
    """Проверки кодом в виде, который хранится в drafts.check_result."""
    from tanbala_leads.checks import run_all

    return [asdict(result) for result in run_all(subject, body)]


def approve(conn: psycopg.Connection, draft_id: int, approved_by: str) -> None:
    """Одобрить черновик. Отправка письма отдельный шаг, сейчас она выключена."""
    with conn.transaction():
        row = conn.execute(
            "UPDATE drafts SET review_status = 'approved', approved_by = %s, approved_at = now()"
            " WHERE id = %s AND sent_at IS NULL RETURNING company_id",
            (approved_by, draft_id),
        ).fetchone()
        if row is None:
            raise DraftNotFound(draft_id)
        conn.execute("UPDATE companies SET status = 'approved' WHERE id = %s", row)


def reject(conn: psycopg.Connection, draft_id: int, reviewer: str) -> None:
    """Отклонить черновик. Компания возвращается к статусу verified, можно написать новый черновик."""
    with conn.transaction():
        row = conn.execute(
            "UPDATE drafts SET review_status = 'rejected', approved_by = NULL, approved_at = NULL"
            " WHERE id = %s AND sent_at IS NULL RETURNING company_id",
            (draft_id,),
        ).fetchone()
        if row is None:
            raise DraftNotFound(draft_id)
        conn.execute("UPDATE companies SET status = 'verified' WHERE id = %s", row)


def update_draft(conn: psycopg.Connection, draft_id: int, subject: str, body: str) -> list[dict]:
    """Сохранить правку человека и заново прогнать проверки кодом. Одобрение снимается."""
    checks = check_results_json(subject, body)
    with conn.transaction():
        row = conn.execute(
            "UPDATE drafts SET subject = %s, body = %s, check_result = %s,"
            " review_status = 'pending', approved_by = NULL, approved_at = NULL"
            " WHERE id = %s AND sent_at IS NULL RETURNING company_id",
            (subject, body, Jsonb(checks), draft_id),
        ).fetchone()
        if row is None:
            raise DraftNotFound(draft_id)
        conn.execute("UPDATE companies SET status = 'drafted' WHERE id = %s AND status = 'approved'", row)
    return checks
