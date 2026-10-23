"""Шаг 1. Компании из 2ГИС через parser-2gis. Результат: companies, статус new."""

import json
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import psycopg
from psycopg.types.json import Jsonb

from tanbala_leads import PROJECT_ROOT
from tanbala_leads.sites import extract_emails, is_role_address, normalize_domain

PARSER_TIMEOUT_SECONDS = 20 * 60
# parser-2gis живёт в отдельном окружении со старыми зависимостями: ключа API и паролей он не видит.
PASSED_ENV_KEYS = (
    "SYSTEMROOT", "WINDIR", "PATH", "PATHEXT", "COMSPEC", "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "USERNAME",
)

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


def build_search_url(city: str, query: str) -> str:
    """Ссылка на выдачу 2ГИС по городу и запросу."""
    if city not in CITIES:
        raise ValueError(f"Неизвестный город {city!r}")
    if not query.strip():
        raise ValueError("Пустой запрос")
    return f"https://2gis.kz/{city}/search/{quote(query.strip())}"


def parser_env(tmp_dir: Path) -> dict[str, str]:
    """Окружение для parser-2gis: только системные переменные, временные файлы Chrome в папке проекта."""
    env = {key: os.environ[key] for key in PASSED_ENV_KEYS if key in os.environ}
    env["TEMP"] = env["TMP"] = str(tmp_dir)
    env["PYTHONUTF8"] = "1"
    return env


def run_parser(search_url: str, output_path: Path, max_records: int, parser_bin: str) -> Path:
    """Выгрузить одну ссылку 2ГИС в JSON через CLI parser-2gis."""
    if max_records < 1:
        raise ValueError("max_records должен быть больше нуля")
    binary = Path(parser_bin)
    if not binary.is_absolute():
        binary = PROJECT_ROOT / binary
    if not binary.exists():
        raise ParserError(f"Не найден parser-2gis: {binary}. Установите окружение .venv-2gis (docs/SETUP.md).")
    tmp_dir = PROJECT_ROOT / "data" / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(binary), "-i", search_url, "-o", str(output_path), "-f", "json",
        "--parser.max-records", str(max_records),
    ]
    try:
        result = subprocess.run(
            command, env=parser_env(tmp_dir), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=PARSER_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise ParserError(f"parser-2gis не уложился в {PARSER_TIMEOUT_SECONDS} с") from exc
    if result.returncode != 0 or not output_path.exists():
        tail = (result.stderr or result.stdout).strip()[-500:]
        raise ParserError(f"parser-2gis завершился с кодом {result.returncode}: {tail}")
    return output_path


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


def _is_duplicate(conn: psycopg.Connection, card: CompanyCard) -> bool:
    return conn.execute(
        "SELECT EXISTS (SELECT 1 FROM companies WHERE (source = '2gis' AND source_id = %s)"
        " OR website_domain = %s OR (cardinality(%s::text[]) > 0 AND phones && %s::text[]))",
        (card.source_id, card.website_domain, list(card.phones), list(card.phones)),
    ).fetchone()[0]


def _insert(conn: psycopg.Connection, card: CompanyCard, run_id: int | None) -> int | None:
    with conn.transaction():
        row = conn.execute(
            "INSERT INTO companies (name, city, rubric, address, phones, website, website_domain, source,"
            " source_id, source_url, branches_count, raw, run_id)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s, '2gis', %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING id",
            (card.name, card.city, card.rubric, card.address, list(card.phones), card.website, card.website_domain,
             card.source_id, card.source_url, card.branches_count, Jsonb(card.raw), run_id),
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
                   limit: int | None = None) -> LoadResult:
    """Загрузить выгрузку в companies со статусом new. Дубли по 2ГИС id, сайту и телефону пропускаются."""
    cards = [card for item in read_export(export_path) if (card := parse_item(item))]
    new_ids: list[int] = []
    duplicates = 0
    for card in cards:
        if limit is not None and len(new_ids) >= limit:
            break
        company_id = None if _is_duplicate(conn, card) else _insert(conn, card, run_id)
        if company_id is None:
            duplicates += 1
        else:
            new_ids.append(company_id)
    return LoadResult(found=len(cards), new_ids=tuple(new_ids), duplicates=duplicates)
