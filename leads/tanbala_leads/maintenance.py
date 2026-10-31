"""Разовые исправления данных в базе по новым правилам, без вызова API. Запуск из командной строки (cli.py).

Сначала всегда --dry-run: он печатает, что изменится, и ничего не пишет.
"""

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tanbala_leads.steps import qualify

# Все оценки с тем, по чему проверяются цитаты (текст сайта и реклама в raw), как при квалификации.
QUALIFICATIONS_SQL = """
SELECT q.id, q.company_id, q.pains, c.name, c.site_text, c.raw
FROM qualifications q JOIN companies c ON c.id = q.company_id
ORDER BY q.company_id, q.id
"""
SOURCE_LABELS = {"2gis": "2ГИС", "site": "сайт"}
MAX_QUOTE_CHARS = 80


@dataclass(frozen=True)
class PainChange:
    """Боли одной оценки до и после проверки по новому правилу."""

    qualification_id: int
    company_id: int
    company_name: str
    card_only: bool
    before: list
    after: list[dict]


def pain_changes(conn: psycopg.Connection) -> list[PainChange]:
    """Оценки, у которых боли изменятся по новому правилу (решение владельца 01.11.2026).

    Рубрика, адрес и «Особенности» карточки 2ГИС больше не доказательство: цитата из них становится
    неподтверждённой, а без сайта и рекламы в 2ГИС болей нет совсем. Черновики писем не трогаются.
    """
    with conn.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(QUALIFICATIONS_SQL).fetchall()
    changes = []
    for row in rows:
        before = row["pains"] if isinstance(row["pains"], list) else []
        after = qualify.recheck_pains(before, qualify.evidence_sources(row))
        if after != before:
            changes.append(PainChange(qualification_id=row["id"], company_id=row["company_id"],
                                      company_name=row["name"], card_only=qualify.card_only(row),
                                      before=before, after=after))
    return changes


def apply_pain_changes(conn: psycopg.Connection, changes: list[PainChange]) -> None:
    """Записать новые боли одной транзакцией: всё или ничего."""
    with conn.transaction():
        for change in changes:
            conn.execute("UPDATE qualifications SET pains = %s WHERE id = %s",
                         (Jsonb(change.after), change.qualification_id))


def _verified(pains: list) -> int:
    return sum(1 for pain in pains if isinstance(pain, dict) and pain.get("verified") is True)


def _quote(text: object) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= MAX_QUOTE_CHARS else text[: MAX_QUOTE_CHARS - 1] + "…"


def _pain_line(pain: dict, after: dict | None) -> str:
    state = "подтверждена" if pain.get("verified") is True else "не подтверждена"
    source = SOURCE_LABELS.get(pain.get("source"), pain.get("source"))
    if after is None:
        new_state = "убрана"
    else:
        new_state = "подтверждена" if after["verified"] else "не подтверждена"
        new_state += f" ({SOURCE_LABELS.get(after['source'], after['source'])})" if after["verified"] else ""
    return f"  - {pain.get('pain')}: «{_quote(pain.get('evidence'))}», {source}: {state} → {new_state}"


def describe_pain_changes(changes: list[PainChange], checked: int) -> list[str]:
    """Отчёт по-русски: по строке на оценку и на каждую изменённую боль, в конце итог."""
    lines = []
    for change in changes:
        why = " (нет ни сайта, ни рекламы в 2ГИС: оценка только по карточке)" if change.card_only else ""
        lines.append(f"Компания {change.company_id} «{_quote(change.company_name)}», оценка {change.qualification_id}: "
                     f"подтверждённых болей {_verified(change.before)} → {_verified(change.after)}{why}")
        after_by_pain = {pain["pain"]: pain for pain in change.after}
        for pain in change.before:
            if not isinstance(pain, dict):
                continue
            after = after_by_pain.get(pain.get("pain"))
            if after is None or after["verified"] != (pain.get("verified") is True) or after["source"] != pain.get("source"):
                lines.append(_pain_line(pain, after))
    verified_before = sum(_verified(change.before) for change in changes)
    verified_after = sum(_verified(change.after) for change in changes)
    lines.append(f"Итого: оценок {checked}, изменится {len(changes)}; подтверждённых болей в них "
                 f"{verified_before} → {verified_after}.")
    return lines


DRY_RUN_NOTE = "Пробный прогон (--dry-run): в базе ничего не изменено."
SAVED_NOTE = "Записано."


def recheck_pains(conn: psycopg.Connection, *, dry_run: bool) -> list[str]:
    """Команда recheck-pains: перепроверить сохранённые боли, с dry_run только показать изменения."""
    changes = pain_changes(conn)
    checked = conn.execute("SELECT count(*) FROM qualifications").fetchone()[0]
    lines = describe_pain_changes(changes, checked)
    if dry_run:
        return [*lines, DRY_RUN_NOTE]
    apply_pain_changes(conn, changes)
    return [*lines, SAVED_NOTE]
