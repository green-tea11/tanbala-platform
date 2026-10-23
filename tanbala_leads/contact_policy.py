"""Кому можно писать: история писем и список «не писать». Раздел 13 документа о Tanbala.

База сама не даёт записать повторное первое письмо и письмо из do_not_contact (db.py).
Здесь та же проверка заранее, чтобы не писать черновики тем, кому писать нельзя.
"""

import psycopg

CAN_CONTACT_SQL = """
SELECT NOT (
    EXISTS (
        SELECT 1 FROM contact_history
        WHERE direction = 'out' AND kind = 'first_email' AND (email = %(email)s OR company_id = %(company_id)s)
    )
    OR EXISTS (
        SELECT 1 FROM do_not_contact d
        WHERE d.email = %(email)s
           OR d.company_id = %(company_id)s
           OR d.domain = %(domain)s
           OR right(%(domain)s, length(d.domain) + 1) = '.' || d.domain
    )
)
"""


def can_contact(conn: psycopg.Connection, company_id: int, email: str) -> bool:
    """Можно ли отправить первое письмо: компании и на этот адрес ещё не писали, они не в списке «не писать»."""
    email = email.strip().lower()
    domain = email.rsplit("@", 1)[-1]
    params = {"email": email, "company_id": company_id, "domain": domain}
    return conn.execute(CAN_CONTACT_SQL, params).fetchone()[0]


def record_message(conn: psycopg.Connection, *, company_id: int | None, email: str, direction: str,
                   kind: str = "first_email", draft_id: int | None = None, subject: str | None = None) -> int:
    """Записать письмо в contact_history. Повтор первого письма или письмо в do_not_contact база отклонит."""
    return conn.execute(
        "INSERT INTO contact_history (company_id, email, direction, kind, draft_id, subject)"
        " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
        (company_id, email.strip().lower(), direction, kind, draft_id, subject),
    ).fetchone()[0]


def block(conn: psycopg.Connection, *, reason: str, email: str | None = None, domain: str | None = None,
          company_id: int | None = None, note: str | None = None) -> None:
    """Добавить адрес, домен или компанию в do_not_contact. Повторная блокировка ничего не меняет."""
    conn.execute(
        "INSERT INTO do_not_contact (email, domain, company_id, reason, note) VALUES (%s, %s, %s, %s, %s)"
        " ON CONFLICT DO NOTHING",
        (email.strip().lower() if email else None, domain.strip().lower() if domain else None,
         company_id, reason, note),
    )
