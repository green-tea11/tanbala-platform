"""Разовые исправления данных (maintenance.py, команды CLI): сначала --dry-run, письма не трогаются."""

import pytest
from psycopg.types.json import Jsonb

from tanbala_leads import cli, db, maintenance
from tanbala_leads.settings import load_settings

pytestmark = pytest.mark.db

RUBRIC = "Складское хранение, Железнодорожные грузоперевозки"
RUBRIC_PAIN = {"pain": "Цифры в 1С не сходятся с тем, что на полках", "evidence": RUBRIC, "source": "2gis",
               "verified": True}
SITE_PAIN = {"pain": "Инвентаризация занимает дни и отрывает людей", "evidence": "Ответственное хранение паллет",
             "source": "site", "verified": True}


@pytest.fixture(autouse=True)
def migrated(db_conn):
    db.migrate(db_conn)


def add_qualified(conn, name, pains, *, site_text=None, ad_text=None) -> int:
    raw = {"ads": {"text": ad_text}} if ad_text else {}
    company_id = conn.execute(
        "INSERT INTO companies (name, rubric, site_text, raw, status) VALUES (%s, %s, %s, %s, 'drafted') RETURNING id",
        (name, RUBRIC, site_text, Jsonb(raw)),
    ).fetchone()[0]
    conn.execute("INSERT INTO qualifications (company_id, fit, score, reason, segment, model, pains)"
                 " VALUES (%s, 'yes', 80, 'Склад.', 'Склад, логистика, дистрибуция', 'claude-haiku-5-5', %s)",
                 (company_id, Jsonb(pains)))
    contact_id = conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@sklad.kz') RETURNING id",
                              (company_id,)).fetchone()[0]
    conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Тема', 'Текст')",
                 (company_id, contact_id))
    return company_id


def stored_pains(conn, company_id):
    return conn.execute("SELECT pains FROM qualifications WHERE company_id = %s", (company_id,)).fetchone()[0]


def test_dry_run_reports_changes_and_writes_nothing(db_conn):
    card_only = add_qualified(db_conn, "Склад-Только-Карточка", [RUBRIC_PAIN])
    with_site = add_qualified(db_conn, "Склад-С-Сайтом", [RUBRIC_PAIN, SITE_PAIN],
                              site_text="Ответственное хранение паллет и контейнеров.")
    untouched = add_qualified(db_conn, "Склад-Хороший", [SITE_PAIN], site_text="Ответственное хранение паллет.")

    lines = maintenance.recheck_pains(db_conn, dry_run=True)

    text = "\n".join(lines)
    assert f"Компания {card_only} " in text and "оценка только по карточке" in text
    assert f"Компания {with_site} " in text and f"Компания {untouched} " not in text
    assert "подтверждена → убрана" in text and "подтверждена → не подтверждена" in text
    assert lines[-2] == "Итого: оценок 3, изменится 2; подтверждённых болей в них 3 → 1."
    assert lines[-1] == maintenance.DRY_RUN_NOTE
    assert stored_pains(db_conn, card_only) == [RUBRIC_PAIN]


def test_recheck_writes_new_pains_and_keeps_drafts(db_conn):
    card_only = add_qualified(db_conn, "Склад-Только-Карточка", [RUBRIC_PAIN])
    with_site = add_qualified(db_conn, "Склад-С-Сайтом", [RUBRIC_PAIN, SITE_PAIN],
                              site_text="Ответственное хранение паллет и контейнеров.")
    with_ad = add_qualified(db_conn, "Склад-С-Рекламой", [{**SITE_PAIN, "source": "2gis"}],
                            ad_text="Ответственное хранение паллет от 1 дня")
    drafts_before = db_conn.execute("SELECT id, subject, body, updated_at FROM drafts ORDER BY id").fetchall()

    lines = maintenance.recheck_pains(db_conn, dry_run=False)

    assert lines[-1] == maintenance.SAVED_NOTE
    assert stored_pains(db_conn, card_only) == []
    assert stored_pains(db_conn, with_site) == [SITE_PAIN, {**RUBRIC_PAIN, "verified": False}]
    assert stored_pains(db_conn, with_ad) == [{**SITE_PAIN, "source": "2gis"}]
    assert db_conn.execute("SELECT id, subject, body, updated_at FROM drafts ORDER BY id").fetchall() == drafts_before
    assert maintenance.pain_changes(db_conn) == []  # второй прогон ничего не меняет


def test_cli_recheck_pains_dry_run(db_conn, monkeypatch, capsys):
    add_qualified(db_conn, "Склад-Только-Карточка", [RUBRIC_PAIN])
    monkeypatch.setattr(cli, "load_settings", lambda: load_settings({"DATABASE_URL": "postgresql://test"}))
    monkeypatch.setattr(cli.db, "connect", lambda dsn: db_conn)
    monkeypatch.setattr(db_conn, "close", lambda: None)

    assert cli.main(["recheck-pains", "--dry-run"]) == 0

    assert maintenance.DRY_RUN_NOTE in capsys.readouterr().out
    assert maintenance.pain_changes(db_conn) != []


# fix-emails: прилипшая подпись в сохранённых почтах (ревью 01.11.2026)

def add_company_with_emails(conn, name, emails, *, status="qualified") -> tuple[int, list[int]]:
    company_id = conn.execute("INSERT INTO companies (name, status) VALUES (%s, %s) RETURNING id",
                              (name, status)).fetchone()[0]
    ids = [conn.execute("INSERT INTO contacts (company_id, email, verify_result, verified_at)"
                        " VALUES (%s, %s, 'invalid', now()) RETURNING id", (company_id, email)).fetchone()[0]
           for email in emails]
    return company_id, ids


def emails_of(conn, company_id):
    return conn.execute("SELECT email, verify_result, is_role FROM contacts WHERE company_id = %s ORDER BY id",
                        (company_id,)).fetchall()


def test_fix_emails_dry_run_then_apply(db_conn):
    erda, _ = add_company_with_emails(db_conn, "Erda Holding", ["e-mailinfo@erdaholding.com"], status="verified")
    dup, _ = add_company_with_emails(db_conn, "Пэл", ["mailsales@pel.kz", "sales@pel.kz"])
    lettered, (glued_id,) = add_company_with_emails(db_conn, "Контейнер", ["emailzakaz@kontainer.kz"])
    db_conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Тема', 'Текст')",
                    (lettered, glued_id))
    fine, _ = add_company_with_emails(db_conn, "Почтовик", ["mailbox@pochta.kz"])

    lines = maintenance.fix_emails(db_conn, dry_run=True)

    assert lines == [
        f"Компания {erda} «Erda Holding»: e-mailinfo@erdaholding.com → info@erdaholding.com (исправить)",
        f"Компания {dup} «Пэл»: mailsales@pel.kz → sales@pel.kz (удалить: такой адрес у компании уже есть)",
        f"Компания {lettered} «Контейнер»: emailzakaz@kontainer.kz → zakaz@kontainer.kz"
        " (не трогать: по этой почте есть письмо)",
        "Итого: почт 5, исправить 1, удалить 1, пропустить 1.",
        maintenance.DRY_RUN_NOTE,
    ]
    assert emails_of(db_conn, erda) == [("e-mailinfo@erdaholding.com", "invalid", False)]

    assert maintenance.fix_emails(db_conn, dry_run=False)[-1] == maintenance.SAVED_NOTE

    assert emails_of(db_conn, erda) == [("info@erdaholding.com", None, True)]
    assert db_conn.execute("SELECT status FROM companies WHERE id = %s", (erda,)).fetchone()[0] == "qualified"
    assert [email for email, _, _ in emails_of(db_conn, dup)] == ["sales@pel.kz"]
    assert [email for email, _, _ in emails_of(db_conn, lettered)] == ["emailzakaz@kontainer.kz"]
    assert [email for email, _, _ in emails_of(db_conn, fine)] == ["mailbox@pochta.kz"]
    assert db_conn.execute("SELECT count(*) FROM drafts").fetchone()[0] == 1


def test_fix_emails_waits_for_an_active_run(db_conn):
    company_id, _ = add_company_with_emails(db_conn, "Erda Holding", ["e-mailinfo@erdaholding.com"])
    db_conn.execute("INSERT INTO runs (city, query, max_companies, status) VALUES ('almaty', 'склад', 1, 'running')")

    lines = maintenance.fix_emails(db_conn, dry_run=False)

    assert lines[-1] == maintenance.RUN_ACTIVE_NOTE
    assert [email for email, _, _ in emails_of(db_conn, company_id)] == ["e-mailinfo@erdaholding.com"]


def test_two_glued_copies_of_one_address_become_one(db_conn):
    company_id, _ = add_company_with_emails(db_conn, "Erda", ["e-mailinfo@erdaholding.com", "mailinfo@erdaholding.com"])

    maintenance.fix_emails(db_conn, dry_run=False)

    assert [email for email, _, _ in emails_of(db_conn, company_id)] == ["info@erdaholding.com"]
