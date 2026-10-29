"""Шаг 4. Проверка почт через Reacher. Результат: contacts.verify_result, статус verified.

С домашнего IP SMTP-проверка часто невозможна (нет PTR и своего домена отправителя), тогда Reacher
отвечает unknown. Такие адреса считаем годными, отсеиваем только invalid.
"""

from collections.abc import Callable
from dataclasses import dataclass

import httpx
import psycopg
from psycopg.types.json import Jsonb

VERIFY_RESULTS = ("safe", "risky", "invalid", "unknown")
REACHER_TIMEOUT_SECONDS = 90
MAX_EMAILS_PER_COMPANY = 3


class ReacherUnavailable(RuntimeError):
    """Reacher не ответил ни по одному адресу компании: проверим в следующий запуск."""


@dataclass(frozen=True)
class EmailCheck:
    email: str
    result: str
    is_catch_all: bool | None
    is_role: bool
    note: str | None
    raw: dict
    # Сбой самого Reacher, а не ответ про адрес: результат не сохраняется.
    failed: bool = False


def _parse(email: str, data: dict) -> EmailCheck:
    result = data.get("is_reachable")
    smtp = data.get("smtp") if isinstance(data.get("smtp"), dict) else {}
    misc = data.get("misc") if isinstance(data.get("misc"), dict) else {}
    error = smtp.get("error") if isinstance(smtp.get("error"), dict) else None
    return EmailCheck(
        email=email,
        result=result if result in VERIFY_RESULTS else "unknown",
        is_catch_all=smtp.get("is_catch_all") if error is None else None,
        is_role=bool(misc.get("is_role_account")),
        note=f"SMTP: {error.get('message', '')[:200]}" if error else None,
        raw=data,
    )


def check_email(email: str, *, base_url: str, secret: str, client: httpx.Client | None = None) -> EmailCheck:
    """Проверить один адрес через Reacher. Сбой Reacher не роняет шаг: результат unknown с причиной."""
    own_client = client is None
    client = client or httpx.Client(timeout=REACHER_TIMEOUT_SECONDS)
    try:
        response = client.post(f"{base_url.rstrip('/')}/v1/check_email", json={"to_email": email},
                               headers={"x-reacher-secret": secret})
        response.raise_for_status()
        return _parse(email, response.json())
    except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
        note = f"Reacher недоступен или ответил ошибкой: {type(exc).__name__}"
        return EmailCheck(email=email, result="unknown", is_catch_all=None, is_role=False, note=note,
                          raw={"error": note}, failed=True)
    finally:
        if own_client:
            client.close()


def verify_company(conn: psycopg.Connection, company_id: int, checker: Callable[[str], EmailCheck]) -> int:
    """Проверить ещё не проверенные почты компании. Вернуть число годных (не invalid).

    Сбой Reacher не записывается: адрес остаётся непроверенным до следующего запуска.
    """
    rows = conn.execute(
        "SELECT id, email FROM contacts WHERE company_id = %s AND verify_result IS NULL ORDER BY id LIMIT %s",
        (company_id, MAX_EMAILS_PER_COMPANY),
    ).fetchall()
    failures = 0
    for contact_id, email in rows:
        check = checker(email)
        if check.failed:
            failures += 1
            continue
        raw = {**check.raw, "note": check.note} if check.note else check.raw
        conn.execute(
            "UPDATE contacts SET verify_result = %s, is_catch_all = %s, is_role = is_role OR %s,"
            " verify_raw = %s, verified_at = now() WHERE id = %s",
            (check.result, check.is_catch_all, check.is_role, Jsonb(raw), contact_id),
        )
    usable = conn.execute(
        "SELECT count(*) FROM contacts WHERE company_id = %s AND verify_result IN ('safe', 'risky', 'unknown')",
        (company_id,),
    ).fetchone()[0]
    if usable == 0 and failures:
        raise ReacherUnavailable("Reacher не ответил, почты проверим в следующий запуск")
    return usable
