"""Справка о компании для WhatsApp-бота (GET /internal/companies/{id}/brief).

Только то, что можно сказать клиенту: оценка, причина и подтверждённые боли. Не отдаём заметки проверяющему,
непроверенные боли, текст письма, адреса почты, имена людей и телефоны. Тексты с сайтов и от модели чистим.
"""

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.internal import lookup
from tanbala_leads.internal import normalize as norm
from tanbala_leads.steps.qualify import MAX_PAINS, PAIN_SOURCES

MAX_NAME_CHARS = 200
MAX_RUBRIC_CHARS = 200
MAX_SEGMENT_CHARS = 100
MAX_REASON_CHARS = 600
MAX_PAIN_CHARS = 200
MAX_EVIDENCE_CHARS = 300
MAX_SUBJECT_CHARS = 200
# Сначала убрать невидимые символы: иначе ivan@<нулевая ширина>sklad.kz прошёл бы мимо поиска почт.
MAX_RAW_CHARS = 20_000

# Последняя оценка компании, как в карточке интерфейса.
BRIEF_SQL = """
SELECT c.id, c.name, c.city, c.rubric, q.segment, q.fit, q.score, q.reason, q.pains
FROM companies c
LEFT JOIN LATERAL (
    SELECT segment, fit, score, reason, pains FROM qualifications
    WHERE company_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
) q ON true
WHERE c.id = %s
"""


def _without_contacts(value: str | None, limit: int) -> str | None:
    return norm.clean_text(norm.hide_contacts(norm.clean_text(value, MAX_RAW_CHARS)), limit)


def _pains(raw: object) -> list[dict]:
    """Только подтверждённые боли: цитату нашёл код во входных данных, Claude её не придумал."""
    pains = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict) or item.get("verified") is not True or item.get("source") not in PAIN_SOURCES:
            continue
        pain = norm.clean_text(str(item.get("pain") or ""), MAX_PAIN_CHARS)
        evidence = _without_contacts(str(item.get("evidence") or ""), MAX_EVIDENCE_CHARS)
        if pain and evidence:
            pains.append({"pain": pain, "evidence": evidence, "source": item["source"]})
    return pains[:MAX_PAINS]


def mark_whatsapp_contact(conn: psycopg.Connection, company_id: int) -> None:
    """Отметка «клиент писал в WhatsApp»: дата первого запроса справки, повторный запрос её не меняет."""
    conn.execute("UPDATE companies SET whatsapp_contacted_at = now() WHERE id = %s AND whatsapp_contacted_at IS NULL",
                 (company_id,))


def company_brief(conn: psycopg.Connection, company_id: int) -> dict | None:
    """Справка по контракту или None, если компании нет."""
    with conn.cursor(row_factory=dict_row) as cursor:
        row = cursor.execute(BRIEF_SQL, (company_id,)).fetchone()
    if row is None:
        return None
    letter = lookup.last_letter(conn, company_id)
    return {
        "id": row["id"],
        "name": norm.clean_text(row["name"], MAX_NAME_CHARS) or "",
        "city": norm.clean_text(row["city"], MAX_NAME_CHARS),
        "rubric": norm.clean_text(row["rubric"], MAX_RUBRIC_CHARS),
        "segment": norm.clean_text(row["segment"], MAX_SEGMENT_CHARS),
        "fit": row["fit"],
        "fit_score": row["score"],
        "reason": _without_contacts(row["reason"], MAX_REASON_CHARS),
        "pains": _pains(row["pains"]),
        "emailed": letter is not None,
        "emailed_at": letter.sent_at if letter else None,
        "email_subject": _without_contacts(letter.subject, MAX_SUBJECT_CHARS) if letter else None,
    }
