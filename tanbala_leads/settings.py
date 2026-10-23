"""Настройки из переменных окружения и файла .env. Образец всех переменных: .env.example."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields

from dotenv import load_dotenv

# Поле настроек → переменная окружения.
ENV_NAMES: dict[str, str] = {
    "anthropic_key": "VENMART_ANTHROPIC_KEY",
    "database_url": "DATABASE_URL",
    "reacher_url": "REACHER_URL",
    "reacher_secret": "REACHER_SECRET",
    "parser_2gis_bin": "PARSER_2GIS_BIN",
    "llm_log_path": "LLM_LOG_PATH",
    "agent_name": "AGENT_NAME",
    "agent_whatsapp": "AGENT_WHATSAPP",
    "agent_email": "AGENT_EMAIL",
    "dry_run_to": "DRY_RUN_TO",
}

DEFAULTS: dict[str, str] = {
    "reacher_url": "http://127.0.0.1:8080",
    "parser_2gis_bin": ".venv-2gis/Scripts/parser-2gis.exe",
    "llm_log_path": "logs/llm_calls.jsonl",
}


class SettingsError(RuntimeError):
    """Не задана нужная переменная окружения."""


@dataclass(frozen=True)
class Settings:
    # Секреты не попадают в repr: иначе они окажутся в логах и traceback.
    anthropic_key: str = field(default="", repr=False)
    database_url: str = field(default="", repr=False)
    reacher_url: str = ""
    reacher_secret: str = field(default="", repr=False)
    parser_2gis_bin: str = ""
    llm_log_path: str = ""
    agent_name: str = ""
    agent_whatsapp: str = ""
    agent_email: str = ""
    dry_run_to: str = ""

    def require(self, name: str) -> str:
        """Вернуть значение поля или остановиться с понятной ошибкой, если оно пустое."""
        value = getattr(self, name)
        if not value:
            raise SettingsError(f"Не задана переменная {ENV_NAMES[name]}. Заполните её в .env по образцу .env.example.")
        return value


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Собрать настройки. Без аргумента читает .env и окружение процесса."""
    if env is None:
        load_dotenv()
        env = os.environ
    values = {
        item.name: env.get(ENV_NAMES[item.name], "").strip() or DEFAULTS.get(item.name, "")
        for item in fields(Settings)
    }
    return Settings(**values)
