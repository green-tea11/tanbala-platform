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


def test_parser_timeout_kills_whole_process_tree(tmp_path, monkeypatch):
    killed = []

    class HangingProcess:
        pid = 4242
        returncode = None

        def communicate(self, timeout=None):
            raise collect.subprocess.TimeoutExpired("parser-2gis", timeout)

        def kill(self):
            killed.append("kill")

        def wait(self, timeout=None):
            return -9

    binary = tmp_path / "parser-2gis.exe"
    binary.write_text("")
    monkeypatch.setattr(collect.subprocess, "Popen", lambda *a, **k: HangingProcess())
    monkeypatch.setattr(collect, "_kill_tree", lambda pid: killed.append(pid))

    with pytest.raises(collect.ParserError, match="не уложился"):
        collect.run_parser("https://2gis.kz/almaty/search/x", tmp_path / "out.json", 5, str(binary))

    assert killed[0] == 4242


def test_slash_in_name_stays_inside_search():
    url = collect.build_search_url("almaty", "x/../../almaty/firm/123")

    assert url == "https://2gis.kz/almaty/search/x%2F..%2F..%2Falmaty%2Ffirm%2F123"


def test_parser_on_linux_runs_in_own_group_and_timeout_hides_command(tmp_path, monkeypatch):
    """На Linux Chrome parser-2gis убивается вместе с ним (группа процессов); в ошибке нет команды с названием."""
    started, killed = [], []

    class HangingProcess:
        pid = 4242
        returncode = None

        def communicate(self, timeout=None):
            started.append(timeout)
            raise collect.subprocess.TimeoutExpired(["parser-2gis", "-i", "https://2gis.kz/almaty/search/Иванов"],
                                                    timeout)

        def wait(self, timeout=None):
            return -9

    def popen(command, **kwargs):
        started.append(kwargs["start_new_session"])
        return HangingProcess()

    binary = tmp_path / "parser-2gis"
    binary.write_text("")
    monkeypatch.setattr(collect, "IS_WINDOWS", False)
    monkeypatch.setattr(collect.subprocess, "Popen", popen)
    monkeypatch.setattr(collect.os, "killpg", lambda pid, sig: killed.append((pid, sig)), raising=False)
    monkeypatch.setattr(collect.signal, "SIGKILL", 9, raising=False)

    with pytest.raises(collect.ParserError, match="не уложился в 300 с") as error:
        collect.run_parser("https://2gis.kz/almaty/search/x", tmp_path / "out.json", 5, str(binary),
                           timeout_seconds=300)

    assert started == [True, 300] and killed == [(4242, 9)]
    assert error.value.__cause__ is None and error.value.__suppress_context__


def test_parser_that_does_not_stop_after_kill_is_parser_error(tmp_path, monkeypatch):
    class StuckProcess:
        pid = 4242

        def communicate(self, timeout=None):
            raise collect.subprocess.TimeoutExpired(["parser-2gis", "-i", "https://2gis.kz/almaty/search/Иванов"],
                                                    timeout)

        def wait(self, timeout=None):
            raise collect.subprocess.TimeoutExpired(["parser-2gis", "-i", "https://2gis.kz/almaty/search/Иванов"],
                                                    timeout)

    binary = tmp_path / "parser-2gis"
    binary.write_text("")
    monkeypatch.setattr(collect.subprocess, "Popen", lambda *a, **k: StuckProcess())
    monkeypatch.setattr(collect, "_kill_tree", lambda pid: None)

    with pytest.raises(collect.ParserError, match="не остановился") as error:
        collect.run_parser("https://2gis.kz/almaty/search/x", tmp_path / "out.json", 5, str(binary))

    assert error.value.__cause__ is None and error.value.__suppress_context__
    assert "Иванов" not in str(error.value)


def test_kill_of_finished_parser_on_linux_is_quiet(monkeypatch):
    def gone(pid, sig):
        raise ProcessLookupError(pid)

    monkeypatch.setattr(collect, "IS_WINDOWS", False)
    monkeypatch.setattr(collect.os, "killpg", gone, raising=False)
    monkeypatch.setattr(collect.signal, "SIGKILL", 9, raising=False)

    collect._kill_tree(4242)
