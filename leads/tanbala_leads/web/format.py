"""Форматирование для страниц: деньги, числа, даты, ссылки, письмо и заметки. Без базы и без FastAPI."""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal
from typing import Any
from urllib.parse import urlencode, urlsplit

from tanbala_leads.llm import call_cost_usd
from tanbala_leads.web.labels import (
    CHECK_LABELS,
    COMPANY_FORMS,
    ESTIMATE_CACHE_WRITE_TOKENS,
    ESTIMATE_CALLS_PER_COMPANY,
    ESTIMATE_MODEL,
    IMPORT_HEADERS,
    INDUSTRY_FORMS,
    MAX_ID_DIGITS,
    PAIN_SOURCES,
    TOKEN_FORMS,
    UP_TO_COMPANY_FORMS,
)

NBSP = " "
TOKEN_KINDS = ("input", "output", "cache_read", "cache_write")
# Заметка проверяющему: целая строка «[Проверить: …]» или «[Ответить лично: …]», как в checks.py.
_NOTE_LINE = re.compile(r"^\[(Проверить|Ответить лично):\s*([^\]]*)\]\s*$")
# Ошибки шагов хранятся текстом исключения; перед показом прячем то, что похоже на ключи и пароли.
_SECRET_PATTERNS = (
    re.compile(r"sk-ant-[A-Za-z0-9_-]+"),
    re.compile(r"\b(?:postgres(?:ql)?|mysql|redis|amqp)://\S+", re.IGNORECASE),
    re.compile(r"\b(?:api[_-]?key|x-api-key|secret|password|passwd|token|authorization)\b\s*[=:]\s*\S+",
               re.IGNORECASE),
)
_HOST_RE = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}(:\d+)?$", re.IGNORECASE)
_LIKE_SPECIAL = str.maketrans({"\\": "\\\\", "%": "\\%", "_": "\\_"})


# ---------- расходы ----------


@dataclass(frozen=True)
class Cost:
    """Токены и примерная цена. unpriced_tokens: токены моделей без цены в llm.MODEL_PRICES_USD_PER_MTOK."""

    tokens: int = 0
    usd: float = 0.0
    unpriced_tokens: int = 0

    @property
    def priced(self) -> bool:
        return self.unpriced_tokens == 0


def cost_from_rows(rows: Iterable[dict[str, Any]]) -> Cost:
    """Сложить строки вида {model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens}."""
    tokens, usd, unpriced = 0, 0.0, 0
    for row in rows:
        counts = {f"{kind}_tokens": int(row.get(f"{kind}_tokens") or 0) for kind in TOKEN_KINDS}
        row_tokens = sum(counts.values())
        price = call_cost_usd(row["model"], **counts)
        tokens += row_tokens
        if price is None:
            unpriced += row_tokens
        else:
            usd += price
    return Cost(tokens=tokens, usd=usd, unpriced_tokens=unpriced)


def format_usd(value: float) -> str:
    """$0,0123 для копеечных сумм, $12,34 от доллара."""
    if value <= 0:
        return "$0"
    if value < 0.0001:
        return "< $0,0001"
    text = f"{value:,.4f}" if value < 1 else f"{value:,.2f}"
    return "$" + text.replace(",", NBSP).replace(".", ",")


def format_cost(cost: Cost) -> str:
    if cost.tokens == 0:
        return "$0"
    if cost.priced:
        return f"≈ {format_usd(cost.usd)}"
    unpriced = f"{fmt_int(cost.unpriced_tokens)} {plural(cost.unpriced_tokens, TOKEN_FORMS)} без цены"
    return f"≈ {format_usd(cost.usd)} + {unpriced}" if cost.usd > 0 else unpriced


def format_approx_usd(value: float) -> str:
    """Оценка с одной значащей цифрой: $0,003, $0,02, $0,07."""
    if value <= 0:
        return "$0"
    number = Decimal(str(value))
    rounded = number.quantize(Decimal(1).scaleb(number.adjusted()), rounding=ROUND_HALF_UP).normalize()
    return "$" + format(rounded, "f").replace(".", ",")


def estimate_per_company_usd() -> float:
    """Примерная цена одной компании: квалификация, черновик и повтор черновика, документ из кэша."""
    return sum(call_cost_usd(ESTIMATE_MODEL, inp, out, cache_read, 0) or 0.0
               for inp, out, cache_read in ESTIMATE_CALLS_PER_COMPANY)


def estimate_first_run_usd() -> float:
    """Доплата первого запуска за 5 минут: запись документа о Tanbala в кэш."""
    return call_cost_usd(ESTIMATE_MODEL, 0, 0, 0, ESTIMATE_CACHE_WRITE_TOKENS) or 0.0


def industries(text: str) -> list[str]:
    """Отрасли из поля поиска так же, как их режет pipeline.split_queries, но без проверок лимитов."""
    found: list[str] = []
    for part in re.split(r"[,;\n]+", text or ""):
        query = " ".join(part.split())
        if query and query.casefold() not in {known.casefold() for known in found}:
            found.append(query)
    return found


def toggle_industry(text: str, industry: str) -> str:
    """Кнопка-подсказка: добавить отрасль в список через запятую или убрать, если она уже есть."""
    current = industries(text)
    kept = [query for query in current if query.casefold() != industry.casefold()]
    return ", ".join(kept if len(kept) < len(current) else [*current, industry])


def format_run_estimate(count: int, per_industry: int) -> str:
    """«3 отрасли × 5 = до 15 компаний · примерно $0,05»: компании плюс запись документа в кэш."""
    if count < 1 or per_industry < 1:
        return ""
    total = count * per_industry
    usd = format_approx_usd(total * estimate_per_company_usd() + estimate_first_run_usd())
    return (f"{count} {plural(count, INDUSTRY_FORMS)} × {per_industry} = до {total}"
            f" {plural(total, UP_TO_COMPANY_FORMS)} · примерно {usd}")


def format_estimate(companies: int) -> str:
    """«За 5 компаний около $0,02» для строки под кнопкой: компании плюс запись в кэш."""
    usd = format_approx_usd(companies * estimate_per_company_usd() + estimate_first_run_usd())
    return f"За {companies} {plural(companies, COMPANY_FORMS)} около {usd}"


# ---------- числа, даты, ссылки ----------


def plural(number: int, forms: tuple[str, str, str]) -> str:
    """Русская форма слова для числа: 1 токен, 2 токена, 5 токенов."""
    n = abs(number) % 100
    if 11 <= n <= 14:
        return forms[2]
    if n % 10 == 1:
        return forms[0]
    if 2 <= n % 10 <= 4:
        return forms[1]
    return forms[2]


def fmt_int(value: int | None) -> str:
    return "—" if value is None else f"{value:,}".replace(",", NBSP)


def fmt_dt(value: datetime | None, now: datetime | None = None) -> str:
    """Время по часам компьютера: «сегодня, 14:05», «вчера, 09:10», «21.10, 18:00»."""
    if value is None:
        return "—"
    local = value.astimezone()
    today = (now or datetime.now().astimezone()).date()
    clock = local.strftime("%H:%M")
    if local.date() == today:
        return f"сегодня, {clock}"
    if local.date() == today - timedelta(days=1):
        return f"вчера, {clock}"
    if local.year == today.year:
        return f"{local:%d.%m}, {clock}"
    return f"{local:%d.%m.%Y}, {clock}"


def fmt_date(value: datetime | None) -> str:
    """Дата по часам компьютера: «28.10.2026»."""
    return value.astimezone().strftime("%d.%m.%Y") if value else "—"


def safe_href(value: str | None) -> str | None:
    """Ссылка для href только http(s). javascript:, data: и прочее с чужих сайтов не пропускаем."""
    if not value:
        return None
    text = value.strip()
    if any(ch.isspace() or ord(ch) < 32 for ch in text):
        return None
    if "://" not in text and _HOST_RE.match(text.split("/", 1)[0]):
        text = "https://" + text
    try:
        parts = urlsplit(text)
    except ValueError:
        return None
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return None
    return text


def display_url(value: str) -> str:
    text = re.sub(r"^https?://", "", value.strip(), flags=re.IGNORECASE)
    return text[4:].rstrip("/") if text.lower().startswith("www.") else text.rstrip("/")


def tel_href(phone: str) -> str | None:
    digits = re.sub(r"[^\d+]", "", phone)
    return f"tel:{digits}" if sum(ch.isdigit() for ch in digits) >= 5 else None


def parse_id(value: str | None) -> int | None:
    text = (value or "").strip()
    # isascii: isdigit() пропускает «²» и «٣», а int() на них падает.
    return int(text) if text.isascii() and text.isdigit() and len(text) <= MAX_ID_DIGITS else None


def redact(text: str | None) -> str | None:
    if not text:
        return text
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub("[скрыто]", text)
    return text


def escape_like(text: str) -> str:
    return text.translate(_LIKE_SPECIAL)


def _url(path: str, params: dict[str, Any]) -> str:
    query = urlencode({key: value for key, value in params.items() if value not in (None, "")})
    return path + (f"?{query}" if query else "")


def companies_url(run_id: int | None = None, status: str | None = None, q: str | None = None,
                  page: int | None = None, query: str | None = None) -> str:
    """Список компаний с фильтрами: запуск, статус, отрасль (query, точное совпадение), текст и страница."""
    return _url("/companies", {"run": run_id, "status": status, "query": query, "q": q,
                                "page": page if page and page > 1 else None})


def letters_url(draft_id: int | None = None, *, status: str | None = None, run_id: int | None = None,
                done: str | None = None, edit: bool = False) -> str:
    """Адрес в очереди писем. У выбранного письма якорь #letter: на телефоне сразу к тексту."""
    path = f"/letters/{draft_id}" if draft_id is not None else "/letters"
    url = _url(path, {"status": status, "run": run_id, "done": done, "edit": 1 if edit else None})
    return url + "#letter" if draft_id is not None else url


# ---------- письмо ----------


def parse_checks(raw: Any) -> list[dict[str, Any]]:
    """drafts.check_result → список проверок. Чужую форму не роняем, а пропускаем."""
    if not isinstance(raw, list):
        return []
    checks = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "")
        details = item.get("details") or []
        if not isinstance(details, list):
            details = [details]
        checks.append({
            "name": name,
            "label": CHECK_LABELS.get(name, name or "Проверка"),
            "passed": item.get("passed") is True,
            "details": [str(detail) for detail in details],
        })
    return checks


def parse_pains(raw: Any) -> list[dict[str, Any]]:
    """qualifications.pains → боли для страницы. Подтверждённые цитатой первыми; чужую форму пропускаем."""
    if not isinstance(raw, list):
        return []
    pains = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("pain"), str) or not item["pain"].strip():
            continue
        source = item.get("source")
        evidence = item.get("evidence")
        pains.append({
            "label": item["pain"].strip(),
            "evidence": evidence.strip() if isinstance(evidence, str) else "",
            "source_label": PAIN_SOURCES.get(source, str(source) if source else "источник не указан"),
            "verified": item.get("verified") is True,
        })
    return sorted(pains, key=lambda pain: not pain["verified"])


def prepare_import_text(text: str) -> str:
    """Список для импорта: каждый адрес или домен из строки, а не только первый.

    Строки режутся по пробелам, запятым, точкам с запятой и табуляции. Остаются только кусочки с @ или
    точкой: так из CSV «email;название» берутся адреса, а названия и заголовки отбрасываются.
    """
    items = []
    for line in text.splitlines():
        tokens = [token.strip("\"'<>()[]").removeprefix("mailto:").strip() for token in re.split(r"[\s,;]+", line)]
        found = [token for token in tokens if token and token.lower() not in IMPORT_HEADERS and ("@" in token or "." in token)]
        if found:
            items.extend(found)
        elif all(token.lower() in IMPORT_HEADERS for token in tokens if token):
            continue  # строка заголовка CSV или пустая
        elif line.strip():
            # Ни одного адреса в строке: целиком, чтобы владелец увидел её в «не распознано».
            items.append(line.strip())
    return "\n".join(items)


def decode_upload(data: bytes) -> str | None:
    """Файл списка в UTF-8 (с BOM или без). Другая кодировка: None."""
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def split_letter(body: str) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    """Заметки проверяющему в начале черновика отдельно, текст клиенту отдельно.

    Как в checks.py: заметки только в начале. Заметка посреди письма уйдёт клиенту, поэтому остаётся
    в тексте и подсвечивается; проверка «notes» её тоже не пропустит.
    """
    lines = body.splitlines()
    notes = []
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        match = _NOTE_LINE.match(stripped)
        if stripped and not match:
            break
        if match:
            notes.append({"kind": match.group(1), "text": match.group(2).strip()})
        index += 1
    text_lines = [{"text": line, "note": bool(_NOTE_LINE.match(line.strip()))} for line in lines[index:]]
    while text_lines and not text_lines[-1]["text"].strip():
        text_lines.pop()
    return notes, text_lines
