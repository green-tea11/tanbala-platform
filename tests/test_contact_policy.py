import pytest

from tanbala_leads import contact_policy, db

pytestmark = pytest.mark.db


@pytest.fixture
def conn(db_conn):
    db.migrate(db_conn)
    return db_conn


def add_company(conn, name="ТОО Склад") -> int:
    return conn.execute("INSERT INTO companies (name) VALUES (%s) RETURNING id", (name,)).fetchone()[0]


def test_new_company_and_address_can_be_contacted(conn):
    assert contact_policy.can_contact(conn, add_company(conn), "info@sklad.kz")


def test_address_written_before_cannot_be_contacted_again(conn):
    first = add_company(conn, "Филиал 1")
    contact_policy.record_message(conn, company_id=first, email="info@set.kz", direction="out")

    assert not contact_policy.can_contact(conn, add_company(conn, "Филиал 2"), "Info@Set.kz")


def test_company_written_before_cannot_be_contacted_on_other_address(conn):
    company_id = add_company(conn)
    contact_policy.record_message(conn, company_id=company_id, email="info@sklad.kz", direction="out")

    assert not contact_policy.can_contact(conn, company_id, "sales@sklad.kz")


def test_incoming_reply_does_not_block_first_email(conn):
    company_id = add_company(conn)
    contact_policy.record_message(conn, company_id=company_id, email="info@sklad.kz", direction="in", kind="reply")

    assert contact_policy.can_contact(conn, company_id, "info@sklad.kz")


@pytest.mark.parametrize(
    ("target", "email"),
    [
        ({"email": "info@sklad.kz"}, "info@sklad.kz"),
        ({"domain": "sklad.kz"}, "sales@sklad.kz"),
        ({"domain": "sklad.kz"}, "sales@mail.sklad.kz"),
    ],
)
def test_blocked_targets_cannot_be_contacted(conn, target, email):
    contact_policy.block(conn, reason="refused", **target)

    assert not contact_policy.can_contact(conn, add_company(conn), email)


def test_blocked_company_cannot_be_contacted(conn):
    company_id = add_company(conn)
    contact_policy.block(conn, reason="complaint", company_id=company_id)

    assert not contact_policy.can_contact(conn, company_id, "new@other.kz")


def test_similar_domain_is_not_blocked(conn):
    contact_policy.block(conn, reason="refused", domain="sklad.kz")

    assert contact_policy.can_contact(conn, add_company(conn), "info@bigsklad.kz")


def test_blocking_twice_is_harmless(conn):
    contact_policy.block(conn, reason="refused", email="info@sklad.kz")
    contact_policy.block(conn, reason="complaint", email="info@sklad.kz")

    assert conn.execute("SELECT count(*) FROM do_not_contact").fetchone()[0] == 1
