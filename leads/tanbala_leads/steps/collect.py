"""Шаг 1. Компании из 2ГИС через parser-2gis. Результат: companies, статус new."""

import json
import os
import re
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import psycopg
from psycopg.types.json import Jsonb

from tanbala_leads import PROJECT_ROOT
from tanbala_leads.sites import extract_emails, is_role_address, normalize_domain

PARSER_TIMEOUT_SECONDS = 20 * 60
KILL_WAIT_SECONDS = 30  # сколько ждать, пока убитый parser-2gis завершится
IS_WINDOWS = os.name == "nt"
# parser-2gis живёт в отдельном окружении со старыми зависимостями: ключа API и паролей он не видит.
# Последняя строка для Linux: Chrome на сервере нужны домашняя папка и язык.
PASSED_ENV_KEYS = (
    "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
    "HOME", "LANG", "LANGUAGE", "LC_ALL",
)
# Только для Chrome с окном: на сервере это Xvfb (xvfb-run пишет файл ключа в XAUTHORITY). Без окна экран не нужен.
WINDOW_ENV_KEYS = ("DISPLAY", "XAUTHORITY")
# PARSER_2GIS_HEADLESS: Chrome для 2ГИС без окна. Пусто: с окном, как на ПК.
HEADLESS_VALUES = {"": False, "false": False, "no": False, "0": False, "true": True, "yes": True, "1": True}

CITIES: dict[str, str] = {
    "almaty": "Алматы",
    "astana": "Астана",
    "shymkent": "Шымкент",
    "karaganda": "Караганда",
    "aktobe": "Актобе",
    "atyrau": "Атырау",
    "pavlodar": "Павлодар",
    "ust_kamenogorsk": "Усть-Каменогорск",
}


class ParserError(RuntimeError):
    """parser-2gis не отработал."""


class ParserStuck(ParserError):
    """parser-2gis не уложился и не остановился: его Chrome может жить, второй запускать нельзя (2 ГБ на сервере)."""


# Строка лога parser-2gis уровня ERROR или CRITICAL: «12:00:00.000 | ERROR    | Ошибка получения ответа сервера.»
PARSER_LOG_ERROR_RE = re.compile(r"\|\s*(?:ERROR|CRITICAL)\s*\|([^\n]*)")


def build_search_url(city: str, query: str) -> str:
    """Ссылка на выдачу 2ГИС по городу и запросу."""
    if city not in CITIES:
        raise ValueError(f"Неизвестный город {city!r}")
    if not query.strip():
        raise ValueError("Пустой запрос")
    # safe="": «/» в названии от клиента бота не уведёт parser-2gis на другую страницу 2ГИС.
    return f"https://2gis.kz/{city}/search/{quote(query.strip(), safe='')}"


def parser_env(tmp_dir: Path, *, headless: bool = False) -> dict[str, str]:
    """Окружение для parser-2gis: только системные переменные, временные файлы Chrome в папке проекта."""
    keys = PASSED_ENV_KEYS if headless else PASSED_ENV_KEYS + WINDOW_ENV_KEYS
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env["TEMP"] = env["TMP"] = env["TMPDIR"] = str(tmp_dir)  # TEMP и TMP читает Windows, TMPDIR — Linux
    env["PYTHONUTF8"] = "1"
    return env


def parse_headless(value: str) -> bool:
    """Значение PARSER_2GIS_HEADLESS: true, yes, 1 или false, no, 0 (регистр не важен), пусто — false."""
    key = value.strip().lower()
    if key not in HEADLESS_VALUES:
        raise ValueError("PARSER_2GIS_HEADLESS должен быть true или false (пусто — false)")
    return HEADLESS_VALUES[key]


def parser_binary(parser_bin: str) -> Path:
    """Путь к parser-2gis из PARSER_2GIS_BIN; относительный считается от папки проекта."""
    binary = Path(parser_bin)
    return binary if binary.is_absolute() else PROJECT_ROOT / binary


def check_parser_setup(parser_bin: str, headless: bool) -> None:
    """До запуска сервера и поиска: parser-2gis на месте, а на Linux без экрана Chrome пойдёт без окна.

    Иначе ошибка всплыла бы только на первом поиске (путь Windows из .env ПК, Chrome с окном без DISPLAY).
    """
    if not parser_binary(parser_bin).exists():
        raise ValueError(f"PARSER_2GIS_BIN: не найден {parser_bin}. На Linux: .venv-2gis/bin/parser-2gis "
                         "(docs/SETUP.md)")
    if not IS_WINDOWS and not headless and not os.environ.get("DISPLAY"):
        raise ValueError("На сервере без экрана нужен PARSER_2GIS_HEADLESS=true (или Xvfb и DISPLAY)")


def run_parser(search_url: str, output_path: Path, max_records: int, parser_bin: str, *,
               timeout_seconds: int = PARSER_TIMEOUT_SECONDS, headless: bool = False) -> Path:
    """Выгрузить одну ссылку 2ГИС в JSON через CLI parser-2gis. Не уложился в timeout_seconds: ParserError.

    headless: Chrome без окна (сервер без экрана, PARSER_2GIS_HEADLESS).
    """
    if max_records < 1:
        raise ValueError("max_records должен быть больше нуля")
    binary = parser_binary(parser_bin)
    if not binary.exists():
        raise ParserError(f"Не найден parser-2gis: {binary}. Установите окружение .venv-2gis (docs/SETUP.md).")
    tmp_dir = PROJECT_ROOT / "data" / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(binary), "-i", search_url, "-o", str(output_path), "-f", "json",
        "--parser.max-records", str(max_records),
        *(["--chrome.headless", "yes"] if headless else []),
    ]
    process = subprocess.Popen(
        command, env=parser_env(tmp_dir, headless=headless), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", start_new_session=not IS_WINDOWS,  # своя группа: убить и Chrome
    )
    try:
        stdout, stderr = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        _kill_tree(process.pid)
        # from None: в TimeoutExpired вся команда со ссылкой, а в ней название компании от клиента бота.
        try:
            process.wait(timeout=KILL_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            raise ParserStuck(f"parser-2gis не уложился в {timeout_seconds} с и не остановился") from None
        raise ParserError(f"parser-2gis не уложился в {timeout_seconds} с") from None
    if process.returncode != 0 or not output_path.exists():
        tail = (stderr or stdout or "").strip()[-500:]
        raise ParserError(f"parser-2gis завершился с кодом {process.returncode}: {tail}")
    # parser-2gis ловит свои исключения сам: Chrome не открыл страницу — а выход 0 и пустой «[]», как у выдачи без
    # результатов («Точных совпадений нет» он пишет как WARNING). Пустая выгрузка и строка ERROR в логе — это сбой.
    errors = PARSER_LOG_ERROR_RE.findall(f"{stdout or ''}\n{stderr or ''}")
    if errors and _is_empty_export(output_path):
        raise ParserError(f"parser-2gis не вернул ни одной карточки: {errors[-1].strip()[:300]}")
    return output_path


def _is_empty_export(output_path: Path) -> bool:
    try:
        return read_export(output_path) == []
    except (OSError, ValueError, ParserError):
        return False  # битую выгрузку разберёт load_companies и упадёт с понятной ошибкой


def _kill_tree(pid: int) -> None:
    """Остановить parser-2gis вместе с его Chrome: обычный kill оставляет браузер жить, а место браузера
    в лимите (browsers.py) уже свободно. На Linux parser-2gis запущен в своей группе процессов."""
    if IS_WINDOWS:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, check=False)
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass  # уже завершился


@dataclass(frozen=True)
class CompanyCard:
    source_id: str
    name: str
    city: str | None
    rubric: str | None
    address: str | None
    phones: tuple[str, ...]
    website: str | None
    website_domain: str | None
    emails: tuple[str, ...]
    source_url: str | None
    branches_count: int | None
    raw: dict


@dataclass(frozen=True)
class LoadResult:
    found: int
    new_ids: tuple[int, ...]
    duplicates: int


def read_export(export_path: Path) -> list[dict]:
    """Прочитать JSON parser-2gis: список карточек, файл с BOM."""
    data = json.loads(export_path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, list):
        raise ParserError(f"{export_path}: ожидался список карточек")
    return data


def _contacts(item: dict, kind: str) -> list[dict]:
    return [contact for group in item.get("contact_groups") or [] for contact in group.get("contacts") or []
            if contact.get("type") == kind]


def _unique(values) -> tuple[str, ...]:
    return tuple(dict.fromkeys(value for value in values if value))


def parse_item(item: dict) -> CompanyCard | None:
    """Карточка организации из ответа 2ГИС. Районы и здания (не branch) пропускаем."""
    if item.get("type") != "branch" or not item.get("name"):
        return None
    firm_id = str(item.get("id", "")).split("_")[0]
    org = item.get("org") or {}
    city_alias = item.get("city_alias")
    city = next((div["name"] for div in item.get("adm_div") or [] if div.get("type") == "city"),
                CITIES.get(city_alias))
    websites = [contact.get("url") or contact.get("text") for contact in _contacts(item, "website")]
    website = next((url for url in websites if url and normalize_domain(url)), None)
    emails = _unique(email for contact in _contacts(item, "email")
                     for email in extract_emails(contact.get("value") or contact.get("text") or ""))
    return CompanyCard(
        source_id=str(org.get("id") or firm_id),
        name=item["name"],
        city=city,
        rubric=", ".join(rubric["name"] for rubric in item.get("rubrics") or [] if rubric.get("name")) or None,
        address=item.get("address_name"),
        phones=_unique(re.sub(r"[^\d+]", "", contact.get("value") or "") for contact in _contacts(item, "phone")),
        website=website,
        website_domain=normalize_domain(website) if website else None,
        emails=emails,
        source_url=f"https://2gis.kz/{city_alias}/firm/{firm_id}" if city_alias and firm_id else None,
        branches_count=org.get("branch_count"),
        raw=item,
    )


def find_duplicate(conn: psycopg.Connection, card: CompanyCard) -> int | None:
    """id компании, которая уже есть в базе: тот же 2ГИС id, сайт или телефон."""
    row = conn.execute(
        "SELECT id FROM companies WHERE (source = '2gis' AND source_id = %s)"
        " OR website_domain = %s OR (cardinality(%s::text[]) > 0 AND phones && %s::text[]) ORDER BY id LIMIT 1",
        (card.source_id, card.website_domain, list(card.phones), list(card.phones)),
    ).fetchone()
    return row[0] if row else None


def save_card(conn: psycopg.Connection, card: CompanyCard, *, requested_via: str | None = None) -> int:
    """Одна карточка 2ГИС: id уже известной компании или новой со статусом new.

    requested_via ставится только новой компании и в той же вставке: поиск не успеет взять её в рассылку.
    """
    existing = find_duplicate(conn, card)
    if existing is not None:
        return existing
    company_id = _insert(conn, card, None, None, requested_via=requested_via)
    return company_id if company_id is not None else find_duplicate(conn, card)


def _insert(conn: psycopg.Connection, card: CompanyCard, run_id: int | None, search_query: str | None, *,
            requested_via: str | None = None) -> int | None:
    with conn.transaction():
        row = conn.execute(
            "INSERT INTO companies (name, city, rubric, address, phones, website, website_domain, source,"
            " source_id, source_url, branches_count, raw, run_id, search_query, requested_via)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, '2gis', %s, %s, %s, %s, %s, %s, %s)"
            " ON CONFLICT DO NOTHING RETURNING id",
            (card.name, card.city, card.rubric, card.address, list(card.phones), card.website, card.website_domain,
             card.source_id, card.source_url, card.branches_count, Jsonb(card.raw), run_id, search_query,
             requested_via),
        ).fetchone()
        if row is None:
            return None
        for email in card.emails:
            conn.execute(
                "INSERT INTO contacts (company_id, email, source_page, is_role) VALUES (%s, %s, '2gis', %s)"
                " ON CONFLICT DO NOTHING",
                (row[0], email, is_role_address(email)),
            )
    return row[0]


def load_companies(conn: psycopg.Connection, export_path: Path, *, run_id: int | None = None,
                   limit: int | None = None, search_query: str | None = None) -> LoadResult:
    """Загрузить выгрузку в companies со статусом new. Дубли по 2ГИС id, сайту и телефону пропускаются."""
    cards = [card for item in read_export(export_path) if (card := parse_item(item))]
    new_ids: list[int] = []
    duplicates = 0
    for card in cards:
        if limit is not None and len(new_ids) >= limit:
            break
        company_id = None if find_duplicate(conn, card) is not None else _insert(conn, card, run_id, search_query)
        if company_id is None:
            duplicates += 1
        else:
            new_ids.append(company_id)
    return LoadResult(found=len(cards), new_ids=tuple(new_ids), duplicates=duplicates)
