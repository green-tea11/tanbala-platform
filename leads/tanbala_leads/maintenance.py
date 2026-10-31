"""Разовые исправления данных в базе по новым правилам, без вызова API. Запуск из командной строки (cli.py).

Сначала всегда --dry-run: он печатает, что изменится, и ничего не пишет.
"""

from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from tanbala_leads import sites
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


# Почты компаний и есть ли у почты письмо (черновик или отправка): такие не трогаем.
CONTACTS_SQL = """
SELECT ct.id, ct.company_id, ct.email, c.name, c.status,
       EXISTS (SELECT 1 FROM drafts d WHERE d.contact_id = ct.id) AS has_letter
FROM contacts ct JOIN companies c ON c.id = ct.company_id
ORDER BY ct.company_id, ct.id
"""


@dataclass(frozen=True)
class EmailFix:
    """Почта с прилипшей подписью (e-mailinfo@…) и что с ней сделать: update, delete (такой адрес уже есть) или skip."""

    contact_id: int
    company_id: int
    company_name: str
    company_status: str
    email: str
    fixed: str
    action: str


def email_fixes(conn: psycopg.Connection) -> list[EmailFix]:
    """Почты из базы, у которых sites.without_glued_label снимает подпись, по тому же правилу, что при обходе сайта."""
    with conn.cursor(row_factory=dict_row) as cursor:
        rows = cursor.execute(CONTACTS_SQL).fetchall()
    emails_by_company: dict[int, set[str]] = {}
    for row in rows:
        emails_by_company.setdefault(row["company_id"], set()).add(row["email"])
    taken = {company_id: set(emails) for company_id, emails in emails_by_company.items()}
    fixes = []
    for row in rows:
        fixed = sites.without_glued_label(row["email"], emails_by_company[row["company_id"]])
        if fixed == row["email"]:
            continue
        if row["has_letter"]:
            action = "skip"
        elif fixed in taken[row["company_id"]]:
            action = "delete"
        else:
            action = "update"
            taken[row["company_id"]].add(fixed)
        fixes.append(EmailFix(contact_id=row["id"], company_id=row["company_id"], company_name=row["name"],
                              company_status=row["status"], email=row["email"], fixed=fixed, action=action))
    return fixes


def apply_email_fixes(conn: psycopg.Connection, fixes: list[EmailFix]) -> None:
    """Одной транзакцией. Исправленный адрес снова не проверен: Reacher проверит его в следующем запуске.

    Компания «Почта проверена» без письма возвращается в «Подходит», чтобы запуск проверил новый адрес до письма.
    """
    with conn.transaction():
        for fix in fixes:
            if fix.action == "delete":
                conn.execute("DELETE FROM contacts WHERE id = %s", (fix.contact_id,))
            elif fix.action == "update":
                conn.execute(
                    "UPDATE contacts SET email = %s, is_role = %s, verify_result = NULL, verify_raw = NULL,"
                    " is_catch_all = NULL, verified_at = NULL WHERE id = %s",
                    (fix.fixed, sites.is_role_address(fix.fixed), fix.contact_id),
                )
                conn.execute("UPDATE companies SET status = 'qualified' WHERE id = %s AND status = 'verified'",
                             (fix.company_id,))


EMAIL_ACTIONS = {"update": "исправить", "delete": "удалить: такой адрес у компании уже есть",
                 "skip": "не трогать: по этой почте есть письмо"}


def describe_email_fixes(fixes: list[EmailFix], checked: int) -> list[str]:
    lines = [f"Компания {fix.company_id} «{_quote(fix.company_name)}»: {fix.email} → {fix.fixed} "
             f"({EMAIL_ACTIONS[fix.action]})" for fix in fixes]
    counts = {action: sum(1 for fix in fixes if fix.action == action) for action in EMAIL_ACTIONS}
    lines.append(f"Итого: почт {checked}, исправить {counts['update']}, удалить {counts['delete']}, "
                 f"пропустить {counts['skip']}.")
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


def fix_emails(conn: psycopg.Connection, *, dry_run: bool) -> list[str]:
    """Команда fix-emails: снять прилипшую подпись с сохранённых почт, с dry_run только показать."""
    fixes = email_fixes(conn)
    checked = conn.execute("SELECT count(*) FROM contacts").fetchone()[0]
    lines = describe_email_fixes(fixes, checked)
    if dry_run:
        return [*lines, DRY_RUN_NOTE]
    apply_email_fixes(conn, fixes)
    return [*lines, SAVED_NOTE]
