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
