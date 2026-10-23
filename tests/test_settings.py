import re
from pathlib import Path

import pytest

from tanbala_leads import llm
from tanbala_leads.settings import ENV_NAMES, SettingsError, load_settings

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", ".venv", ".venv-2gis", "__pycache__", ".pytest_cache", "data", "logs"}
# Собрано из частей, чтобы этот файл сам не попадал в поиск.
FORBIDDEN_VAR = "ANTHROPIC" + "_API_KEY"


def test_load_settings_reads_mapping():
    settings = load_settings({"VENMART_ANTHROPIC_KEY": "sk-test", "DATABASE_URL": "postgresql://x"})

    assert settings.anthropic_key == "sk-test"
    assert settings.database_url == "postgresql://x"


def test_require_names_missing_variable():
    settings = load_settings({})

    with pytest.raises(SettingsError, match="VENMART_ANTHROPIC_KEY"):
        settings.require("anthropic_key")


def test_make_client_passes_key_explicitly():
    client = llm.make_client(load_settings({"VENMART_ANTHROPIC_KEY": "sk-test"}))

    assert client.api_key == "sk-test"


def test_make_client_refuses_without_key():
    with pytest.raises(SettingsError, match="VENMART_ANTHROPIC_KEY"):
        llm.make_client(load_settings({"VENMART_ANTHROPIC_KEY": ""}))


def test_env_example_lists_every_setting():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    declared = set(re.findall(r"^([A-Z0-9_]+)=", example, flags=re.MULTILINE))

    assert set(ENV_NAMES.values()) <= declared


def test_forbidden_anthropic_variable_is_not_used_anywhere():
    offenders = []
    for path in ROOT.rglob("*"):
        if not path.is_file() or SKIP_DIRS & set(path.relative_to(ROOT).parts):
            continue
        if path.suffix in {".pyc", ".png", ".jpg", ".zip"}:
            continue
        if FORBIDDEN_VAR in path.read_text(encoding="utf-8", errors="ignore"):
            offenders.append(str(path.relative_to(ROOT)))

    assert offenders == []
