"""Шаг 1. Компании из 2ГИС через parser-2gis. Результат: companies, статус new."""

from pathlib import Path


def run_parser(rubric_url: str, output_path: Path, max_records: int) -> Path:
    """Выгрузить одну ссылку рубрики 2ГИС в JSON.

    TODO: вызвать parser-2gis (PARSER_2GIS_BIN) через subprocess с ограничением max_records.
    Окружение процессу передавать урезанное, без VENMART_ANTHROPIC_KEY и паролей.
    """
    raise NotImplementedError


def load_companies(conn, export_path: Path) -> int:
    """Загрузить выгрузку в companies. Вернуть число новых компаний.

    TODO: нормализовать телефоны и домен сайта, дубли по сайту и телефону пропускать.
    """
    raise NotImplementedError
