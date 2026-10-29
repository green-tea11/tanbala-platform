"""Компании из WhatsApp никогда не попадают в рассылку: пайплайн их пропускает, база не даёт им писать."""

from pathlib import Path

import pytest

from tanbala_leads import contact_policy, db, pipeline
from tanbala_leads.steps import collect

psycopg = pytest.importorskip("psycopg")
pytestmark = pytest.mark.db

FIXTURE = Path(__file__).parent / "fixtures" / "2gis-almaty-sklad.json"


@pytest.fixture(autouse=True)
def migrated(db_conn):
    db.migrate(db_conn)


def add_company(conn, name="Платформа-А", *, status="qualified", requested_via=None) -> int:
    return conn.execute(
        "INSERT INTO companies (name, city, status, requested_via) VALUES (%s, 'Алматы', %s, %s) RETURNING id",
        (name, status, requested_via),
    ).fetchone()[0]


def add_contact(conn, company_id, email="info@platforma.kz") -> int:
    return conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, %s) RETURNING id",
                        (company_id, email)).fetchone()[0]


def add_draft(conn, company_id, contact_id) -> int:
    return conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Тема', 'Текст')"
                        " RETURNING id", (company_id, contact_id)).fetchone()[0]


def test_unfinished_companies_skip_whatsapp(db_conn):
    regular = add_company(db_conn, "Обычная")
    whatsapp = add_company(db_conn, "Из WhatsApp", requested_via="whatsapp")
    for company_id in (regular, whatsapp):
        add_contact(db_conn, company_id, f"info@c{company_id}.kz")

    assert pipeline._unfinished(db_conn, (), 10) == (regular,)


def test_database_refuses_draft_for_whatsapp_company(db_conn):
    company_id = add_company(db_conn, requested_via="whatsapp")
    contact_id = add_contact(db_conn, company_id)

    with pytest.raises(psycopg.errors.CheckViolation):
        add_draft(db_conn, company_id, contact_id)


def test_database_refuses_to_approve_draft_after_company_came_from_whatsapp(db_conn):
    company_id = add_company(db_conn)
    draft_id = add_draft(db_conn, company_id, add_contact(db_conn, company_id))
    db_conn.execute("UPDATE companies SET requested_via = 'whatsapp' WHERE id = %s", (company_id,))

    with pytest.raises(psycopg.errors.CheckViolation):
        db_conn.execute("UPDATE drafts SET review_status = 'approved', approved_by = 'owner', approved_at = now()"
                        " WHERE id = %s", (draft_id,))
    db_conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (draft_id,))


def test_pipeline_letter_to_whatsapp_company_is_refused_but_import_is_kept(db_conn):
    company_id = add_company(db_conn, requested_via="whatsapp")

    with pytest.raises(psycopg.errors.CheckViolation):
        contact_policy.record_message(db_conn, company_id=company_id, email="info@platforma.kz", direction="out")
    contact_policy.record_message(db_conn, company_id=company_id, email="info@platforma.kz", direction="out",
                                  source="import")


def test_save_card_returns_known_company_or_adds_new_one(db_conn):
    cards = [card for item in collect.read_export(FIXTURE) if (card := collect.parse_item(item))]
    first = collect.save_card(db_conn, cards[0])

    assert collect.save_card(db_conn, cards[0]) == first
    assert collect.save_card(db_conn, cards[1]) != first
    assert db_conn.execute("SELECT count(*), min(source) FROM companies").fetchone() == (2, "2gis")
