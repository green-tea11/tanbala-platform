import pytest

from tanbala_leads import db

pytestmark = pytest.mark.db

TABLES = {"companies", "contacts", "qualifications", "drafts", "contact_history", "do_not_contact"}


def table_names(conn) -> set[str]:
    rows = conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
    ).fetchall()
    return {name for (name,) in rows}


def add_company(conn, name="ТОО Склад", **fields) -> int:
    columns = ["name", *fields]
    placeholders = ", ".join(["%s"] * len(columns))
    sql = f"INSERT INTO companies ({', '.join(columns)}) VALUES ({placeholders}) RETURNING id"
    return conn.execute(sql, [name, *fields.values()]).fetchone()[0]


def add_contact(conn, company_id: int, email="info@sklad.kz") -> int:
    return conn.execute(
        "INSERT INTO contacts (company_id, email) VALUES (%s, %s) RETURNING id", (company_id, email)
    ).fetchone()[0]


def add_draft(conn, company_id: int, contact_id: int, **fields) -> int:
    columns = ["company_id", "contact_id", "subject", "body", *fields]
    placeholders = ", ".join(["%s"] * len(columns))
    sql = f"INSERT INTO drafts ({', '.join(columns)}) VALUES ({placeholders}) RETURNING id"
    return conn.execute(sql, [company_id, contact_id, "Тема", "Текст", *fields.values()]).fetchone()[0]


@pytest.fixture
def conn(db_conn):
    db.migrate(db_conn)
    return db_conn


def test_migrate_creates_all_tables(db_conn):
    applied = db.migrate(db_conn)

    assert applied == [1]
    assert TABLES <= table_names(db_conn)


def test_migrate_is_idempotent(db_conn):
    db.migrate(db_conn)

    assert db.migrate(db_conn) == []


def test_company_defaults_to_new(conn):
    company_id = add_company(conn)

    status = conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    assert status == "new"


def test_company_rejects_unknown_status(conn):
    psycopg = pytest.importorskip("psycopg")
    with pytest.raises(psycopg.errors.CheckViolation):
        add_company(conn, status="lost")


def test_company_dedup_by_website_domain(conn):
    psycopg = pytest.importorskip("psycopg")
    add_company(conn, website_domain="sklad.kz")
    with pytest.raises(psycopg.errors.UniqueViolation):
        add_company(conn, name="ТОО Склад филиал", website_domain="sklad.kz")


def test_contact_email_must_be_lowercase(conn):
    psycopg = pytest.importorskip("psycopg")
    company_id = add_company(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        add_contact(conn, company_id, email="Info@Sklad.kz")


def test_qualification_score_range(conn):
    psycopg = pytest.importorskip("psycopg")
    company_id = add_company(conn)
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute(
            "INSERT INTO qualifications (company_id, fit, score, reason, model) VALUES (%s, 'yes', 101, 'склад', 'm')",
            (company_id,),
        )


def test_draft_cannot_be_sent_without_approval(conn):
    psycopg = pytest.importorskip("psycopg")
    company_id = add_company(conn)
    contact_id = add_contact(conn, company_id)
    with pytest.raises(psycopg.errors.CheckViolation):
        add_draft(conn, company_id, contact_id, sent_at="2026-10-23T10:00:00+05:00")


def test_only_one_first_email_sent_per_company(conn):
    psycopg = pytest.importorskip("psycopg")
    company_id = add_company(conn)
    contact_id = add_contact(conn, company_id)
    approved = {"review_status": "approved", "approved_by": "owner", "approved_at": "2026-10-23T10:00:00+05:00"}
    add_draft(conn, company_id, contact_id, sent_at="2026-10-23T11:00:00+05:00", **approved)
    with pytest.raises(psycopg.errors.UniqueViolation):
        add_draft(conn, company_id, contact_id, sent_at="2026-10-24T11:00:00+05:00", **approved)


def test_contact_history_derives_domain_and_survives_company_delete(conn):
    company_id = add_company(conn)
    conn.execute(
        "INSERT INTO contact_history (company_id, email, direction) VALUES (%s, 'info@sklad.kz', 'out')",
        (company_id,),
    )

    conn.execute("DELETE FROM companies WHERE id = %s", (company_id,))

    row = conn.execute("SELECT company_id, domain FROM contact_history").fetchone()
    assert row == (None, "sklad.kz")


def test_do_not_contact_needs_a_target(conn):
    psycopg = pytest.importorskip("psycopg")
    with pytest.raises(psycopg.errors.CheckViolation):
        conn.execute("INSERT INTO do_not_contact (reason) VALUES ('refused')")


def test_blocked_company_cannot_be_deleted(conn):
    psycopg = pytest.importorskip("psycopg")
    company_id = add_company(conn)
    conn.execute("INSERT INTO do_not_contact (company_id, reason) VALUES (%s, 'complaint')", (company_id,))
    with pytest.raises(psycopg.errors.ForeignKeyViolation):
        conn.execute("DELETE FROM companies WHERE id = %s", (company_id,))


def test_updated_at_changes_on_update(conn):
    company_id = add_company(conn)
    before = conn.execute("SELECT updated_at FROM companies WHERE id = %s", (company_id,)).fetchone()[0]

    conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s", (company_id,))

    after = conn.execute("SELECT updated_at FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    assert after > before
