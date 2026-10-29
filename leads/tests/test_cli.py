"""Командная строка: поиск не создаёт запуск, если parser-2gis заведомо не запустится. Без базы и без сети."""

import pytest

from tanbala_leads import cli
from tanbala_leads.settings import load_settings


@pytest.mark.parametrize(("env", "message"), [
    ({"PARSER_2GIS_HEADLESS": "да"}, "PARSER_2GIS_HEADLESS"),
    ({"PARSER_2GIS_BIN": "no-such-dir/parser-2gis.exe"}, "PARSER_2GIS_BIN"),
])
def test_search_stops_on_bad_parser_settings_before_database(monkeypatch, capsys, env, message):
    monkeypatch.setattr(cli, "load_settings", lambda: load_settings({"DATABASE_URL": "postgresql://test", **env}))
    monkeypatch.setattr(cli, "_search", lambda *args: pytest.fail("запуск не должен создаваться"))

    assert cli.main(["search", "--query", "склад", "--limit", "1"]) == 1
    assert message in capsys.readouterr().err
