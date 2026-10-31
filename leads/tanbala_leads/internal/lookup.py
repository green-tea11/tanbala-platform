"""Поиск компании по домену, телефону и названию (GET /internal/lookup). Только код, без AI."""

from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

from tanbala_leads.contact_policy import FREE_MAIL_DOMAINS
from tanbala_leads.internal import normalize as norm

MAX_CANDIDATES = 3
EXACT_SCORE = 1.0
# Совпадение по названию всегда ниже совпадения по домену или телефону.
NAME_SCORE_FACTOR = 0.9
MIN_NAME_SIMILARITY = 0.7
MAX_NAME_CHARS = 200
MAX_RUBRIC_CHARS = 200

# Домен сайта компании и домены её почт, вместе с поддоменами: shop.sklad.kz и info@sklad.kz для sklad.kz.
BY_DOMAIN_SQL = """
SELECT id FROM companies
WHERE website_domain = %(domain)s OR right(website_domain, length(%(domain)s) + 1) = '.' || %(domain)s
UNION
SELECT company_id FROM contacts
WHERE split_part(email, '@', 2) = %(domain)s
   OR right(split_part(email, '@', 2), length(%(domain)s) + 1) = '.' || %(domain)s
"""

# Телефоны в базе как в 2ГИС (+77272...): приводим к 7XXXXXXXXXX так же, как normalize.normalize_phone.
BY_PHONE_SQL = r"""
SELECT DISTINCT c.id FROM companies c
CROSS JOIN LATERAL unnest(c.phones) AS p(raw)
CROSS JOIN LATERAL (SELECT regexp_replace(p.raw, '\D', '', 'g') AS digits) d
WHERE CASE WHEN length(d.digits) = 11 AND left(d.digits, 1) = '8' THEN '7' || substr(d.digits, 2)
           WHEN length(d.digits) = 10 THEN '7' || d.digits
           ELSE d.digits END = %(phone)s
"""

# Последнее исходящее письмо компании: по id, её адресам, домену сайта и корпоративному домену её почт.
# Как вкладка «Кому писали» (contact_policy.HISTORY_SQL). Тестовые отправки лежат в test_sends и не считаются.
LAST_LETTER_SQL = """
SELECT h.occurred_at, h.subject
FROM contact_history h
WHERE h.direction = 'out'
  AND (h.company_id = %(company_id)s
       OR h.email IN (SELECT email FROM contacts WHERE company_id = %(company_id)s)
       OR h.domain = (SELECT website_domain FROM companies WHERE id = %(company_id)s)
       OR (h.domain IN (SELECT split_part(email, '@', 2) FROM contacts WHERE company_id = %(company_id)s)
           AND NOT h.domain = ANY(%(free_mail)s)))
ORDER BY h.occurred_at DESC, h.id DESC
LIMIT 1
"""


@dataclass(frozen=True)
class Query:
    domain: str | None  # регистрируемый домен; None: не передан или общая почта
    phone: str | None
    name: str | None


@dataclass(frozen=True)
class Letter:
    sent_at: str  # ISO 8601, UTC
    subject: str | None


def _given(value: str | None) -> bool:
    return value is not None and bool(value.strip())


def parse_query(domain: str | None = None, phone: str | None = None, name: str | None = None) -> Query:
    """Разобрать параметры бота. Ни одного непустого или неразборчивый: BadInput."""
    if not any(_given(value) for value in (domain, phone, name)):
        raise norm.BadInput("нужен хотя бы один параметр: domain, phone или name")
    return Query(
        domain=norm.parse_domain(domain) if _given(domain) else None,
        phone=norm.normalize_phone(phone) if _given(phone) else None,
        name=norm.parse_name(name) if _given(name) else None,
    )


def _ids(conn: psycopg.Connection, query: str, params: dict) -> list[int]:
    return sorted(company_id for (company_id,) in conn.execute(query, params).fetchall())


def _by_name(conn: psycopg.Connection, name: str, city: str | None = None) -> list[tuple[int, float]]:
    """(id, похожесть) для названий не ниже MIN_NAME_SIMILARITY (norm.name_match); city: только компании этого города.

    Есть компания с тем же названием: совпадения только по первым словам не в счёт («Alser» и «Alser Service
    Center»: иначе разрыв оценок мал, и бот не выбрал бы ни одну, ревью 31.10.2026).
    """
    rows = conn.execute("SELECT id, name, city FROM companies ORDER BY id").fetchall()
    names = [(company_id, norm.normalize_name(company_name))
             for company_id, company_name, company_city in rows if city is None or company_city == city]
    if any(norm.name_similarity(name, company_name) == 1.0 for _, company_name in names):
        scored = [(company_id, norm.name_similarity(name, company_name)) for company_id, company_name in names]
    else:
        scored = [(company_id, norm.name_match(name, company_name)) for company_id, company_name in names]
    return [(company_id, similarity) for company_id, similarity in scored if similarity >= MIN_NAME_SIMILARITY]


def _matches(conn: psycopg.Connection, query: Query) -> dict[int, tuple[float, str]]:
    """id → (match_score, match_by): лучший способ для каждой компании, при равенстве domain → phone → name."""
    found: dict[int, tuple[float, str]] = {}

    def offer(company_id: int, score: float, match_by: str) -> None:
        if company_id not in found or score > found[company_id][0]:
            found[company_id] = (score, match_by)

    if query.domain:
        for company_id in _ids(conn, BY_DOMAIN_SQL, {"domain": query.domain}):
            offer(company_id, EXACT_SCORE, "domain")
    if query.phone:
        for company_id in _ids(conn, BY_PHONE_SQL, {"phone": query.phone}):
            offer(company_id, EXACT_SCORE, "phone")
    if query.name:
        for company_id, similarity in _by_name(conn, query.name):
            offer(company_id, round(NAME_SCORE_FACTOR * similarity, 2), "name")
    return found


def last_letter(conn: psycopg.Connection, company_id: int) -> Letter | None:
    """Последнее настоящее исходящее письмо компании или None."""
    row = conn.execute(LAST_LETTER_SQL, {"company_id": company_id, "free_mail": sorted(FREE_MAIL_DOMAINS)}).fetchone()
    if row is None:
        return None
    occurred_at: datetime = row[0]
    return Letter(sent_at=occurred_at.astimezone(timezone.utc).isoformat(timespec="seconds"), subject=row[1])


def find_candidates(conn: psycopg.Connection, query: Query) -> list[dict]:
    """До MAX_CANDIDATES компаний по убыванию match_score, при равенстве по id."""
    ranked = sorted(_matches(conn, query).items(), key=lambda item: (-item[1][0], item[0]))[:MAX_CANDIDATES]
    if not ranked:
        return []
    rows = conn.execute("SELECT id, name, city, rubric FROM companies WHERE id = ANY(%s)",
                        ([company_id for company_id, _ in ranked],)).fetchall()
    details = {row[0]: row[1:] for row in rows}
    candidates = []
    for company_id, (score, match_by) in ranked:
        name, city, rubric = details[company_id]
        letter = last_letter(conn, company_id)
        candidates.append({
            "id": company_id,
            "name": norm.clean_text(name, MAX_NAME_CHARS) or "",
            "city": norm.clean_text(city, MAX_NAME_CHARS),
            "rubric": norm.clean_text(rubric, MAX_RUBRIC_CHARS),
            "match_by": match_by,
            "match_score": score,
            "emailed": letter is not None,
            "emailed_at": letter.sent_at if letter else None,
        })
    return candidates


def find_known(conn: psycopg.Connection, query: Query, city: str | None) -> int | None:
    """Компания, которая точно та же: домен, телефон или одинаковое название в том же городе (city по-русски)."""
    if query.domain and (ids := _ids(conn, BY_DOMAIN_SQL, {"domain": query.domain})):
        return ids[0]
    if query.phone and (ids := _ids(conn, BY_PHONE_SQL, {"phone": query.phone})):
        return ids[0]
    if query.name and city:
        exact = [company_id for company_id, similarity in _by_name(conn, query.name, city) if similarity == 1.0]
        if exact:
            return exact[0]
    return None
