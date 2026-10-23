from pathlib import Path

import pytest

from tanbala_leads import db
from tanbala_leads.steps import collect

FIXTURE = Path(__file__).parent / "fixtures" / "2gis-almaty-sklad.json"


def cards():
    return [card for item in collect.read_export(FIXTURE) if (card := collect.parse_item(item))]


def test_search_url_for_city_and_query():
    assert collect.build_search_url("almaty", " склад ") == "https://2gis.kz/almaty/search/%D1%81%D0%BA%D0%BB%D0%B0%D0%B4"


@pytest.mark.parametrize(("city", "query"), [("moscow", "склад"), ("almaty", "  ")])
def test_bad_search_is_rejected(city, query):
    with pytest.raises(ValueError):
        collect.build_search_url(city, query)


def test_parser_env_hides_secrets_and_keeps_temp_in_project(tmp_path, monkeypatch):
    monkeypatch.setenv("VENMART_ANTHROPIC_KEY", "sk-secret")
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@h/d")

    env = collect.parser_env(tmp_path)

    assert "VENMART_ANTHROPIC_KEY" not in env and "DATABASE_URL" not in env
    assert env["TEMP"] == env["TMP"] == str(tmp_path)


def test_area_entries_are_skipped():
    assert len(cards()) == 4


def test_card_fields_from_2gis():
    card = next(card for card in cards() if card.name.startswith("Asklad"))

    assert card.source_id == "70000001046073828"
    assert card.city == "Алматы"
    assert card.rubric == "Складское хранение"
    assert card.website == "http://kontainer.kz/sales"
    assert card.website_domain == "kontainer.kz"
    assert card.emails == ("hochu@kontainer.kz", "nadi@kontainer.kz")
    assert "+77076337017" in card.phones
    assert card.branches_count == 3
    # Ссылка ведёт на филиал из выдачи, а source_id это организация: по нему склеиваются филиалы.
    assert card.source_url == "https://2gis.kz/almaty/firm/70000001089840056"


def test_social_links_are_not_a_website():
    card = next(card for card in cards() if card.name.startswith("Asklad"))

    assert "tiktok" not in (card.website or "")


@pytest.mark.db
def test_load_companies_inserts_cards_and_2gis_emails(db_conn):
    db.migrate(db_conn)

    result = collect.load_companies(db_conn, FIXTURE)

    assert result.found == 4 and len(result.new_ids) == 4 and result.duplicates == 0
    assert db_conn.execute("SELECT count(*) FROM companies WHERE status = 'new'").fetchone()[0] == 4
    emails = {email for (email,) in db_conn.execute("SELECT email FROM contacts WHERE source_page = '2gis'")}
    assert {"info@pel.kz", "hochu@kontainer.kz"} <= emails


@pytest.mark.db
def test_second_load_finds_only_duplicates(db_conn):
    db.migrate(db_conn)
    collect.load_companies(db_conn, FIXTURE)

    result = collect.load_companies(db_conn, FIXTURE)

    assert result.new_ids == () and result.duplicates == 4


@pytest.mark.db
def test_load_respects_limit_and_run(db_conn):
    db.migrate(db_conn)
    run_id = db_conn.execute("INSERT INTO runs (city, query, max_companies) VALUES ('almaty', 'склад', 2)"
                             " RETURNING id").fetchone()[0]

    result = collect.load_companies(db_conn, FIXTURE, run_id=run_id, limit=2)

    assert len(result.new_ids) == 2
    assert db_conn.execute("SELECT count(*) FROM companies WHERE run_id = %s", (run_id,)).fetchone()[0] == 2


@pytest.mark.db
def test_same_phone_counts_as_duplicate(db_conn):
    db.migrate(db_conn)
    db_conn.execute("INSERT INTO companies (name, phones) VALUES ('Старая запись', ARRAY['+77772222016'])")

    result = collect.load_companies(db_conn, FIXTURE)

    assert result.duplicates == 1
