import pytest

from tanbala_leads import db
from tanbala_leads.steps import approve

pytestmark = pytest.mark.db


@pytest.fixture
def draft_id(db_conn, monkeypatch):
    db.migrate(db_conn)
    monkeypatch.setattr(approve, "check_results_json", lambda subject, body: [])
    company_id = db_conn.execute("INSERT INTO companies (name, status) VALUES ('ТОО', 'drafted') RETURNING id").fetchone()[0]
    contact_id = db_conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@a.kz') RETURNING id",
                                 (company_id,)).fetchone()[0]
    return db_conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Т', 'Т')"
                           " RETURNING id", (company_id, contact_id)).fetchone()[0]


def test_approve_sets_status(db_conn, draft_id):
    approve.approve(db_conn, draft_id, "владелец")

    assert db_conn.execute("SELECT review_status FROM drafts").fetchone()[0] == "approved"
    assert db_conn.execute("SELECT status FROM companies").fetchone()[0] == "approved"


def test_rejected_draft_cannot_be_approved_or_edited(db_conn, draft_id):
    approve.reject(db_conn, draft_id, "владелец")

    with pytest.raises(approve.DraftNotFound):
        approve.approve(db_conn, draft_id, "владелец")
    with pytest.raises(approve.DraftNotFound):
        approve.update_draft(db_conn, draft_id, "Новая тема", "Новый текст")
    assert db_conn.execute("SELECT review_status FROM drafts").fetchone()[0] == "rejected"


def test_edit_resets_approval(db_conn, draft_id):
    approve.approve(db_conn, draft_id, "владелец")

    approve.update_draft(db_conn, draft_id, "Новая тема", "Новый текст")

    assert db_conn.execute("SELECT review_status, subject FROM drafts").fetchone() == ("pending", "Новая тема")
