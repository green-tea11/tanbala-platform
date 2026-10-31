import pytest

from tanbala_leads import db

psycopg = pytest.importorskip("psycopg")
errors = psycopg.errors

pytestmark = pytest.mark.db

TABLES = {
    "companies", "contacts", "qualifications", "drafts", "contact_history", "do_not_contact",
    "runs", "llm_calls", "test_sends", "research_jobs",
}
APPROVED = {"review_status": "approved", "approved_by": "owner", "approved_at": "2026-10-23T10:00:00+05:00"}


def table_names(conn) -> set[str]:
    rows = conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()"
    ).fetchall()
    return {name for (name,) in rows}


def insert(conn, table: str, **fields) -> int:
    columns = ", ".join(fields)
    placeholders = ", ".join(["%s"] * len(fields))
    sql = f"INSERT INTO {table} ({columns}) VALUES ({placeholders}) RETURNING id"
    return conn.execute(sql, list(fields.values())).fetchone()[0]


def add_company(conn, name="ТОО Склад", **fields) -> int:
    return insert(conn, "companies", name=name, **fields)


def add_contact(conn, company_id: int, email="info@sklad.kz") -> int:
    return insert(conn, "contacts", company_id=company_id, email=email)


def add_draft(conn, company_id: int, contact_id: int, **fields) -> int:
    return insert(conn, "drafts", company_id=company_id, contact_id=contact_id, subject="Тема", body="Текст", **fields)


def add_sent(conn, email: str, company_id: int | None = None, kind="first_email") -> int:
    return insert(conn, "contact_history", company_id=company_id, email=email, direction="out", kind=kind)


@pytest.fixture
def conn(db_conn):
    db.migrate(db_conn)
    return db_conn


# Миграция

def test_migrate_creates_all_tables(db_conn):
    applied = db.migrate(db_conn)

    assert applied == [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert TABLES <= table_names(db_conn)


def test_migrate_is_idempotent(db_conn):
    db.migrate(db_conn)

    assert db.migrate(db_conn) == []


# companies

def test_company_defaults_to_new(conn):
    company_id = add_company(conn)

    status = conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    assert status == "new"


def test_company_rejects_unknown_status(conn):
    with pytest.raises(errors.CheckViolation):
        add_company(conn, status="lost")


def test_company_dedup_by_website_domain(conn):
    add_company(conn, website_domain="sklad.kz")
    with pytest.raises(errors.UniqueViolation):
        add_company(conn, name="ТОО Склад филиал", website_domain="sklad.kz")


@pytest.mark.parametrize("domain", ["www.sklad.kz", "https://sklad.kz", "sklad.kz/", "Sklad.kz", "sklad"])
def test_website_domain_must_be_bare_host(conn, domain):
    with pytest.raises(errors.CheckViolation):
        add_company(conn, website_domain=domain)


def test_website_domain_accepts_punycode(conn):
    add_company(conn, website_domain="xn--80ao21a.xn--80ao21a")


def test_updated_at_changes_on_update(conn):
    company_id = add_company(conn)
    before = conn.execute("SELECT updated_at FROM companies WHERE id = %s", (company_id,)).fetchone()[0]

    conn.execute("UPDATE companies SET status = 'crawled' WHERE id = %s", (company_id,))

    after = conn.execute("SELECT updated_at FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    assert after > before


# contacts, qualifications

@pytest.mark.parametrize("email", ["Info@Sklad.kz", "a@b@c.kz", "info @sklad.kz", "info@sklad"])
def test_contact_email_format(conn, email):
    company_id = add_company(conn)
    with pytest.raises(errors.CheckViolation):
        add_contact(conn, company_id, email=email)


def test_qualification_score_range(conn):
    company_id = add_company(conn)
    with pytest.raises(errors.CheckViolation):
        insert(conn, "qualifications", company_id=company_id, fit="yes", score=101, reason="склад", model="m")


# drafts

def test_draft_cannot_be_sent_without_approval(conn):
    company_id = add_company(conn)
    contact_id = add_contact(conn, company_id)
    with pytest.raises(errors.CheckViolation):
        add_draft(conn, company_id, contact_id, sent_at="2026-10-23T10:00:00+05:00")


def test_only_one_active_first_email_draft_per_company(conn):
    company_id = add_company(conn)
    contact_id = add_contact(conn, company_id)
    add_draft(conn, company_id, contact_id)
    with pytest.raises(errors.UniqueViolation):
        add_draft(conn, company_id, contact_id)


def test_rejected_draft_allows_new_one(conn):
    company_id = add_company(conn)
    contact_id = add_contact(conn, company_id)
    add_draft(conn, company_id, contact_id, review_status="rejected")

    add_draft(conn, company_id, contact_id)


def test_draft_contact_must_belong_to_company(conn):
    company_a = add_company(conn, name="А")
    company_b = add_company(conn, name="Б")
    contact_b = add_contact(conn, company_b, email="info@b.kz")
    with pytest.raises(errors.ForeignKeyViolation):
        add_draft(conn, company_a, contact_b)


# contact_history: кому уже писали

def test_contact_history_derives_domain(conn):
    add_sent(conn, "info@sklad.kz")

    assert conn.execute("SELECT domain FROM contact_history").fetchone()[0] == "sklad.kz"


def test_first_email_to_same_address_only_once(conn):
    add_sent(conn, "info@set.kz", company_id=add_company(conn, name="Филиал 1"))
    with pytest.raises(errors.UniqueViolation):
        add_sent(conn, "info@set.kz", company_id=add_company(conn, name="Филиал 2"))


def test_first_email_to_same_company_only_once(conn):
    company_id = add_company(conn)
    add_sent(conn, "info@sklad.kz", company_id=company_id)
    with pytest.raises(errors.UniqueViolation):
        add_sent(conn, "sales@sklad.kz", company_id=company_id)


def test_replies_to_same_address_are_allowed(conn):
    add_sent(conn, "info@sklad.kz", kind="first_email")
    add_sent(conn, "info@sklad.kz", kind="reply")

    add_sent(conn, "info@sklad.kz", kind="reply")


def test_company_with_history_cannot_be_deleted(conn):
    company_id = add_company(conn)
    add_sent(conn, "info@sklad.kz", company_id=company_id)
    with pytest.raises(errors.ForeignKeyViolation):
        conn.execute("DELETE FROM companies WHERE id = %s", (company_id,))


# do_not_contact: кому больше не пишем

def test_do_not_contact_needs_exactly_one_target(conn):
    with pytest.raises(errors.CheckViolation):
        insert(conn, "do_not_contact", reason="refused")
    with pytest.raises(errors.CheckViolation):
        insert(conn, "do_not_contact", email="info@sklad.kz", domain="sklad.kz", reason="refused")


def test_send_to_blocked_address_is_refused(conn):
    insert(conn, "do_not_contact", email="info@sklad.kz", reason="refused")
    with pytest.raises(errors.CheckViolation):
        add_sent(conn, "info@sklad.kz")


def test_send_to_blocked_domain_and_subdomain_is_refused(conn):
    insert(conn, "do_not_contact", domain="sklad.kz", reason="complaint")
    with pytest.raises(errors.CheckViolation):
        add_sent(conn, "sales@sklad.kz")
    with pytest.raises(errors.CheckViolation):
        add_sent(conn, "sales@mail.sklad.kz")


def test_send_to_blocked_company_is_refused(conn):
    company_id = add_company(conn)
    insert(conn, "do_not_contact", company_id=company_id, reason="manual")
    with pytest.raises(errors.CheckViolation):
        add_sent(conn, "new@other.kz", company_id=company_id)


def test_similar_domain_is_not_blocked(conn):
    insert(conn, "do_not_contact", domain="sklad.kz", reason="refused")

    add_sent(conn, "info@bigsklad.kz")


def test_inbound_from_blocked_address_is_recorded(conn):
    insert(conn, "do_not_contact", email="info@sklad.kz", reason="refused")

    insert(conn, "contact_history", email="info@sklad.kz", direction="in", kind="reply")


def test_blocked_company_cannot_be_deleted(conn):
    company_id = add_company(conn)
    insert(conn, "do_not_contact", company_id=company_id, reason="complaint")
    with pytest.raises(errors.ForeignKeyViolation):
        conn.execute("DELETE FROM companies WHERE id = %s", (company_id,))


# runs, llm_calls: запуски из интерфейса и учёт токенов

def add_run(conn, **fields) -> int:
    return insert(conn, "runs", **{"city": "almaty", "query": "склад", "max_companies": 5, **fields})


def test_run_defaults_to_queued(conn):
    run_id = add_run(conn)

    assert conn.execute("SELECT status FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "queued"


def test_only_one_active_run(conn):
    add_run(conn, status="running")
    with pytest.raises(errors.UniqueViolation):
        add_run(conn)


def test_finished_runs_do_not_block_new_one(conn):
    add_run(conn, status="done")
    add_run(conn, status="failed")

    add_run(conn)


def test_run_limits_company_count(conn):
    with pytest.raises(errors.CheckViolation):
        add_run(conn, max_companies=0)


def test_company_links_to_run(conn):
    run_id = add_run(conn)

    company_id = add_company(conn, run_id=run_id)

    assert conn.execute("SELECT run_id FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == run_id


def test_llm_call_is_logged_with_tokens(conn):
    run_id = add_run(conn)
    company_id = add_company(conn, run_id=run_id)

    insert(conn, "llm_calls", task="qualify", model="claude-haiku-5-5", run_id=run_id, company_id=company_id,
           input_tokens=1200, output_tokens=150, cache_read_tokens=9000)

    total = conn.execute("SELECT sum(input_tokens + output_tokens) FROM llm_calls WHERE run_id = %s", (run_id,))
    assert total.fetchone()[0] == 1350


def test_llm_call_tokens_cannot_be_negative(conn):
    with pytest.raises(errors.CheckViolation):
        insert(conn, "llm_calls", task="qualify", model="m", input_tokens=-1, output_tokens=0)


# Миграция 3: боли с доказательствами, источник записи в истории

def test_qualification_keeps_pains(conn):
    company_id = add_company(conn)
    pains = '[{"pain": "Инвентаризация занимает дни", "evidence": "инвентаризация раз в квартал", "source": "site", "verified": true}]'
    conn.execute("INSERT INTO qualifications (company_id, fit, score, reason, model, pains) VALUES (%s, 'yes', 80, 'r', 'm', %s)",
                 (company_id, pains))

    stored = conn.execute("SELECT pains FROM qualifications").fetchone()[0]
    assert stored[0]["pain"] == "Инвентаризация занимает дни"


def test_old_qualifications_get_empty_pains(conn):
    company_id = add_company(conn)
    insert(conn, "qualifications", company_id=company_id, fit="yes", score=70, reason="r", model="m")

    assert conn.execute("SELECT pains FROM qualifications").fetchone()[0] == []


def test_history_source_is_pipeline_by_default_and_checked(conn):
    add_sent(conn, "info@sklad.kz")

    assert conn.execute("SELECT source FROM contact_history").fetchone()[0] == "pipeline"
    with pytest.raises(errors.CheckViolation):
        insert(conn, "contact_history", email="a@b.kz", direction="out", source="spam")


# Миграция 4: несколько отраслей за запуск

def test_company_remembers_its_search_query(conn):
    company_id = add_company(conn, search_query="склад")

    assert conn.execute("SELECT search_query FROM companies WHERE id = %s", (company_id,)).fetchone()[0] == "склад"


def test_run_has_stage_detail(conn):
    run_id = add_run(conn, stage_detail="склад, 1 из 3")

    assert conn.execute("SELECT stage_detail FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "склад, 1 из 3"
