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


# Компания определяется и по корпоративному домену

def test_other_address_on_same_company_domain_is_blocked(conn):
    contact_policy.record_message(conn, company_id=None, email="info@sklad.kz", direction="out")

    assert not contact_policy.can_contact(conn, add_company(conn), "sales@sklad.kz")


def test_free_mail_domain_does_not_block_other_people(conn):
    contact_policy.record_message(conn, company_id=None, email="ivan@gmail.com", direction="out")

    assert contact_policy.can_contact(conn, add_company(conn), "olga@gmail.com")


def test_company_site_domain_matches_history(conn):
    contact_policy.record_message(conn, company_id=None, email="info@sklad.kz", direction="out")
    company_id = conn.execute("INSERT INTO companies (name, website_domain) VALUES ('Склад', 'sklad.kz') RETURNING id").fetchone()[0]

    assert not contact_policy.can_contact(conn, company_id, "director@gmail.com")


# Импорт прошлых писем и списка «не писать»

def test_import_written_addresses(conn):
    text = "info@sklad.kz\nINFO@sklad.kz\n  sales@pel.kz , \nне почта\n\n"

    result = contact_policy.import_contacts(conn, text, refused=False)

    assert (result.added, result.skipped) == (2, 1)
    assert result.invalid == ("не почта",)
    sources = {source for (source,) in conn.execute("SELECT source FROM contact_history")}
    assert sources == {"import"}
    assert not contact_policy.can_contact(conn, add_company(conn), "info@sklad.kz")


def test_import_refused_addresses_and_domains(conn):
    result = contact_policy.import_contacts(conn, "boss@pel.kz\nsklad.kz\nhttps://www.Kontainer.kz/", refused=True)

    assert result.added == 3
    assert not contact_policy.can_contact(conn, add_company(conn), "boss@pel.kz")
    assert not contact_policy.can_contact(conn, add_company(conn), "any@kontainer.kz")


def test_written_import_skips_blocked_address(conn):
    contact_policy.block(conn, reason="refused", email="info@sklad.kz")

    result = contact_policy.import_contacts(conn, "info@sklad.kz", refused=False)

    assert (result.added, result.skipped) == (0, 1)


def test_block_company_blocks_company_and_its_domain(conn):
    company_id = conn.execute("INSERT INTO companies (name, website_domain) VALUES ('Склад', 'sklad.kz') RETURNING id").fetchone()[0]

    contact_policy.block_company(conn, company_id, note="попросили не писать")

    assert not contact_policy.can_contact(conn, company_id, "x@other.kz")
    assert not contact_policy.can_contact(conn, add_company(conn), "info@sklad.kz")


def test_history_for_company_finds_rows_by_id_email_and_domain(conn):
    company_id = conn.execute("INSERT INTO companies (name, website_domain) VALUES ('Склад', 'sklad.kz') RETURNING id").fetchone()[0]
    contact_policy.record_message(conn, company_id=company_id, email="info@sklad.kz", direction="out")
    contact_policy.record_message(conn, company_id=None, email="old@sklad.kz", direction="out", kind="reply")
    contact_policy.record_message(conn, company_id=None, email="other@pel.kz", direction="out")

    rows = contact_policy.history_for_company(conn, company_id)

    assert {row["email"] for row in rows} == {"info@sklad.kz", "old@sklad.kz"}
