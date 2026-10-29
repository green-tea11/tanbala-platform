"""Кому можно писать: история писем и список «не писать». Раздел 13 документа о Tanbala.

База сама не даёт записать повторное первое письмо и письмо из do_not_contact (db.py).
Здесь та же проверка заранее, чтобы не писать черновики тем, кому писать нельзя.

Компания определяется по id, по адресу и по корпоративному домену: письмо на sales@sklad.kz после
info@sklad.kz считается вторым письмом той же компании. Бесплатная почта (gmail.com, mail.ru…) так не
склеивается и по домену не блокируется: иначе один отказ закрыл бы всех её пользователей.
"""

import re
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.sites import normalize_domain

FREE_MAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "internet.ru",
    "yandex.ru", "yandex.kz", "yandex.com", "ya.ru", "rambler.ru", "yahoo.com", "outlook.com",
    "hotmail.com", "live.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "mail.kz",
    "tut.by", "ukr.net", "yandex.by", "live.ru", "hotmail.ru", "yahoo.ru", "gmx.com", "msn.com", "aol.com",
    "zoho.com",
})
# Зоны, которые нельзя блокировать целиком: блок com.kz закрыл бы все компании в нём.
PUBLIC_SUFFIXES = frozenset({
    "kz", "com.kz", "org.kz", "net.kz", "gov.kz", "edu.kz", "mil.kz", "xn--80ao21a",
    "ru", "com.ru", "org.ru", "net.ru", "xn--p1ai", "com", "org", "net", "uk", "co.uk", "by", "kg", "uz",
})
EMAIL_RE = re.compile(r"^[^@\s<>\"',;:\x00]{1,64}@[^@\s<>\"',;:\x00]+\.[^@\s<>\"',;:\x00]+$")
MAX_EMAIL_CHARS = 254
MAX_IMPORT_LINES = 20_000

CAN_CONTACT_SQL = """
SELECT NOT (
    EXISTS (
        SELECT 1 FROM contact_history h
        WHERE h.direction = 'out' AND h.kind = 'first_email'
          AND (h.email = %(email)s
               OR h.company_id = %(company_id)s
               OR (h.domain = %(domain)s AND NOT %(free_mail)s)
               OR h.domain = (SELECT website_domain FROM companies WHERE id = %(company_id)s))
    )
    OR EXISTS (
        SELECT 1 FROM do_not_contact d
        LEFT JOIN companies c ON c.id = %(company_id)s
        WHERE d.email = %(email)s
           OR d.company_id = %(company_id)s
           OR d.domain = %(domain)s
           OR right(%(domain)s, length(d.domain) + 1) = '.' || d.domain
           OR d.domain = c.website_domain
           OR right(c.website_domain, length(d.domain) + 1) = '.' || d.domain
    )
)
"""

HISTORY_SQL = """
SELECT h.id, h.occurred_at, h.email, h.direction, h.kind, h.source, h.subject, h.note, h.draft_id
FROM contact_history h
WHERE h.company_id = %(company_id)s
   OR h.email IN (SELECT email FROM contacts WHERE company_id = %(company_id)s)
   OR h.domain = (SELECT website_domain FROM companies WHERE id = %(company_id)s)
   OR (h.domain IN (SELECT split_part(email, '@', 2) FROM contacts WHERE company_id = %(company_id)s)
       AND NOT h.domain = ANY(%(free_mail)s))
ORDER BY h.occurred_at DESC, h.id DESC
"""


@dataclass(frozen=True)
class ImportResult:
    added: int
    skipped: int
    invalid: tuple[str, ...]


def is_free_mail(domain: str) -> bool:
    return domain.lower() in FREE_MAIL_DOMAINS


def can_contact(conn: psycopg.Connection, company_id: int, email: str) -> bool:
    """Можно ли отправить первое письмо: компании и на этот адрес ещё не писали, они не в списке «не писать»."""
    email = email.strip().lower()
    domain = email.rsplit("@", 1)[-1]
    params = {"email": email, "company_id": company_id, "domain": domain, "free_mail": is_free_mail(domain)}
    return conn.execute(CAN_CONTACT_SQL, params).fetchone()[0]


def record_message(conn: psycopg.Connection, *, company_id: int | None, email: str, direction: str,
                   kind: str = "first_email", draft_id: int | None = None, subject: str | None = None,
                   source: str = "pipeline", note: str | None = None) -> int:
    """Записать письмо в contact_history. Повтор первого письма или письмо в do_not_contact база отклонит."""
    return conn.execute(
        "INSERT INTO contact_history (company_id, email, direction, kind, draft_id, subject, source, note)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (company_id, email.strip().lower(), direction, kind, draft_id, subject, source, note),
    ).fetchone()[0]


def block(conn: psycopg.Connection, *, reason: str, email: str | None = None, domain: str | None = None,
          company_id: int | None = None, note: str | None = None) -> bool:
    """Добавить адрес, домен или компанию в do_not_contact. Вернуть True, если запись новая."""
    row = conn.execute(
        "INSERT INTO do_not_contact (email, domain, company_id, reason, note) VALUES (%s, %s, %s, %s, %s)"
        " ON CONFLICT DO NOTHING RETURNING id",
        (email.strip().lower() if email else None, domain.strip().lower() if domain else None,
         company_id, reason, note),
    ).fetchone()
    return row is not None


def block_company(conn: psycopg.Connection, company_id: int, note: str | None = None) -> None:
    """Кнопка «Больше не писать»: компания, её корпоративный домен и все её адреса в do_not_contact."""
    with conn.transaction():
        block(conn, reason="manual", company_id=company_id, note=note)
        domain = conn.execute("SELECT website_domain FROM companies WHERE id = %s", (company_id,)).fetchone()
        if domain and domain[0] and not is_free_mail(domain[0]):
            block(conn, reason="manual", domain=domain[0], note=note)
        for (email,) in conn.execute("SELECT email FROM contacts WHERE company_id = %s", (company_id,)).fetchall():
            block(conn, reason="manual", email=email, note=note)


def _block_refused_email(conn: psycopg.Connection, email: str) -> bool:
    """Отказ с адреса: сам адрес, а для корпоративной почты ещё домен и компании с этим адресом."""
    added = block(conn, reason="refused", email=email, note="импорт")
    domain = email.rsplit("@", 1)[-1]
    if not is_free_mail(domain) and domain not in PUBLIC_SUFFIXES:
        added = block(conn, reason="refused", domain=domain, note="импорт: отказ с адреса компании") or added
    for (company_id,) in conn.execute("SELECT DISTINCT company_id FROM contacts WHERE email = %s", (email,)).fetchall():
        added = block(conn, reason="refused", company_id=company_id, note="импорт") or added
    return added


def _import_line(conn: psycopg.Connection, item: str, refused: bool) -> bool | None:
    """Одна строка импорта: True добавлена, False уже была или запрещена, None не распознана."""
    if len(item) <= MAX_EMAIL_CHARS and EMAIL_RE.match(item):
        email = item.lower()
        if refused:
            return _block_refused_email(conn, email)
        company = conn.execute("SELECT company_id FROM contacts WHERE email = %s ORDER BY id LIMIT 1",
                               (email,)).fetchone()
        try:
            with conn.transaction():
                record_message(conn, company_id=company[0] if company else None, email=email, direction="out",
                               source="import", note="импорт прошлых писем")
        except (psycopg.errors.UniqueViolation, psycopg.errors.CheckViolation):
            return False
        return True
    if "@" in item or "\x00" in item:
        return None
    domain = normalize_domain(item) if refused else None
    if domain is None or is_free_mail(domain) or domain in PUBLIC_SUFFIXES:
        return None
    return block(conn, reason="refused", domain=domain, note="импорт")


def import_contacts(conn: psycopg.Connection, text: str, *, refused: bool) -> ImportResult:
    """Загрузить список одной транзакцией: по строке на адрес.

    refused=False: кому уже писали раньше вручную (только адреса почты) → contact_history.
    refused=True: кому не писать (адреса или домены) → do_not_contact; отказ с корпоративного адреса
    закрывает и домен компании.
    """
    items = [line.strip().strip(",;").strip() for line in text.splitlines()]
    items = [item for item in items if item]
    if len(items) > MAX_IMPORT_LINES:
        raise ValueError(f"Слишком много строк: {len(items)}. За один раз не больше {MAX_IMPORT_LINES}.")
    added = skipped = 0
    invalid: list[str] = []
    with conn.transaction():
        for item in items:
            try:
                with conn.transaction():
                    outcome = _import_line(conn, item, refused)
            except psycopg.DataError:
                outcome = None
            if outcome is None:
                invalid.append(item[:100])
            elif outcome:
                added += 1
            else:
                skipped += 1
    return ImportResult(added=added, skipped=skipped, invalid=tuple(invalid))


def history_for_company(conn: psycopg.Connection, company_id: int) -> list[dict]:
    """История писем компании: по id, по её адресам и по домену сайта."""
    with conn.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(HISTORY_SQL, {"company_id": company_id, "free_mail": sorted(FREE_MAIL_DOMAINS)}).fetchall()
