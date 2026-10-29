import re
import subprocess
from pathlib import Path

import pytest

from tanbala_leads import llm
from tanbala_leads.settings import ENV_NAMES, SettingsError, load_settings

ROOT = Path(__file__).resolve().parents[1]
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


def test_make_client_ignores_base_url_from_environment(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9")

    client = llm.make_client(load_settings({"VENMART_ANTHROPIC_KEY": "sk-test"}))

    assert str(client.base_url).startswith(llm.API_BASE_URL)


def test_secrets_are_hidden_from_repr():
    settings = load_settings({
        "VENMART_ANTHROPIC_KEY": "sk-secret",
        "REACHER_SECRET": "reacher-secret",
        "DATABASE_URL": "postgresql://u:db-secret@h/d",
    })

    text = repr(settings)

    assert "sk-secret" not in text
    assert "reacher-secret" not in text
    assert "db-secret" not in text


def test_free_tests_cannot_reach_the_api():
    client = llm.make_client(load_settings({"VENMART_ANTHROPIC_KEY": "sk-test"}))

    with pytest.raises(pytest.fail.Exception, match="Реальный вызов"):
        client.messages.create(model="claude-haiku-5-5", max_tokens=1, messages=[{"role": "user", "content": "x"}])


def test_env_example_lists_every_setting():
    example = (ROOT / ".env.example").read_text(encoding="utf-8")
    declared = set(re.findall(r"^([A-Z0-9_]+)=", example, flags=re.MULTILINE))

    assert set(ENV_NAMES.values()) <= declared


def project_files() -> list[Path]:
    """Файлы в git и новые, ещё не добавленные, без игнорируемых. Плюс локальный .env."""
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
    ).stdout.splitlines()
    files = [ROOT / name for name in listed]
    if (ROOT / ".env").exists():
        files.append(ROOT / ".env")
    return [path for path in files if path.is_file()]


def test_forbidden_anthropic_variable_is_not_used_anywhere():
    offenders = [
        str(path.relative_to(ROOT))
        for path in project_files()
        if FORBIDDEN_VAR in path.read_text(encoding="utf-8", errors="ignore")
    ]

    assert offenders == []
