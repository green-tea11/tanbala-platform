"""Разбор того, что прислал бот (домен, телефон, название), и чистка текстов перед отдачей наружу. Только код, без AI."""

import re
import unicodedata
from difflib import SequenceMatcher
from urllib.parse import urlsplit

from tanbala_leads.contact_policy import FREE_MAIL_DOMAINS, PUBLIC_SUFFIXES
from tanbala_leads.sites import AT_RE, DOMAIN_RE, DOT_RE, EMAIL_RE

MAX_DOMAIN_CHARS = 253
MAX_PHONE_CHARS = 32
MAX_NAME_CHARS = 200
MAX_CITY_CHARS = 100
PHONE_DIGITS = 11
# Совпадение по целым словам (name_match): короче четырёх букв не ищем, «ао», «ип» и подобное шумят.
MIN_WORD_MATCH_CHARS = 4
WORD_PREFIX_SIMILARITY = 0.95
WORD_INSIDE_SIMILARITY = 0.8
LEGAL_FORMS = frozenset("тоо ип ао зао оао пао ооо llp llc ltd jsc inc".split())
QUOTES_RE = re.compile(r"[«»\"'“”„‘’`]")
NOT_WORD_RE = re.compile(r"[^\w]+")
# Телефон в тексте: цифры с пробелами, скобками, дефисами, точками и косой чертой. Прячем, только если цифр 10–15.
PHONE_IN_TEXT_RE = re.compile(r"\+?\d[\d\s().\-/]{8,}\d")
HIDDEN = "[скрыто]"


class BadInput(ValueError):
    """Значение от бота не разобрать: ответ 400 bad_request."""


def _checked(value: str, limit: int) -> str:
    text = value.strip()
    if len(text) > limit:
        raise BadInput(f"длиннее {limit} символов")
    if "\x00" in text:  # Postgres не хранит NUL: без проверки ответ был бы 503, а не 400
        raise BadInput("символ NUL")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as exc:  # одиночный суррогат из JSON (\ud800): иначе 500
        raise BadInput("не UTF-8") from exc
    return text


def registrable_domain(host: str) -> str | None:
    """sklad.kz из a.b.sklad.kz; sklad.com.kz из a.sklad.com.kz. None, если это сама зона (com.kz)."""
    labels = host.split(".")
    size = 3 if len(labels) >= 3 and ".".join(labels[-2:]) in PUBLIC_SUFFIXES else 2
    if len(labels) < size:
        return None
    domain = ".".join(labels[-size:])
    return None if domain in PUBLIC_SUFFIXES else domain


def parse_domain(value: str) -> str | None:
    """Домен компании из домена, ссылки или адреса почты. None: общая почта (gmail.com, mail.ru), по ней
    компанию не узнать. Неразборчивое значение: BadInput.
    """
    text = _checked(value, MAX_DOMAIN_CHARS).lower()
    if "://" not in text:
        # Адрес почты: домен после @. В ссылке @ бывает в пути (/contact@x.com), там хост берёт urlsplit.
        text = "http://" + text.rsplit("@", 1)[-1]
    try:
        host = urlsplit(text).hostname or ""
        host = host.rstrip(".").encode("idna").decode("ascii")
    except (ValueError, UnicodeError) as exc:
        raise BadInput("неверный домен") from exc
    host = host.removeprefix("www.")
    domain = registrable_domain(host) if DOMAIN_RE.match(host) else None
    if domain is None:
        raise BadInput("неверный домен")
    return None if domain in FREE_MAIL_DOMAINS else domain


def normalize_phone(value: str) -> str:
    """Телефон к виду 7XXXXXXXXXX: +7 (701) 123-45-67, 8 701 1234567 и 7011234567 дают 77011234567."""
    digits = re.sub(r"\D", "", _checked(value, MAX_PHONE_CHARS))
    if len(digits) == PHONE_DIGITS and digits.startswith("8"):
        digits = "7" + digits[1:]
    elif len(digits) == PHONE_DIGITS - 1:
        digits = "7" + digits
    if len(digits) != PHONE_DIGITS or not digits.startswith("7"):
        raise BadInput("неверный телефон")
    return digits


def normalize_name(value: str) -> str:
    """Название для сравнения: «ТОО "Платформа-А"» и «Платформа-А, склад» дают «платформа а»."""
    text = value.lower().replace("ё", "е").split(",", 1)[0]
    words = NOT_WORD_RE.sub(" ", QUOTES_RE.sub(" ", text)).split()
    return " ".join(word for word in words if word not in LEGAL_FORMS)


def parse_name(value: str) -> str:
    """Название от бота: нормализованное, непустое."""
    name = normalize_name(_checked(value, MAX_NAME_CHARS))
    if not name:
        raise BadInput("пустое название")
    return name


def parse_alias(value: str) -> str | None:
    """Другое название компании от бота (поле aliases): проверки как у name, но пустое после нормализации
    («», «ТОО») не ошибка, а None: такой вариант просто отбрасывается.
    """
    return normalize_name(_checked(value, MAX_NAME_CHARS)) or None


def name_similarity(left: str, right: str) -> float:
    """Похожесть нормализованных названий 0..1: по строке и по словам в любом порядке."""
    if not left or not right:
        return 0.0
    if left == right:
        return 1.0
    as_text = SequenceMatcher(None, left, right).ratio()
    as_words = SequenceMatcher(None, " ".join(sorted(left.split())), " ".join(sorted(right.split()))).ratio()
    return max(as_text, as_words)


def _word_match(query: str, name: str) -> float:
    """Слова запроса целиком в названии: в начале WORD_PREFIX_SIMILARITY, дальше WORD_INSIDE_SIMILARITY, иначе 0."""
    query_words, name_words = query.split(), name.split()
    if len("".join(query_words)) < MIN_WORD_MATCH_CHARS or len(query_words) >= len(name_words):
        return 0.0
    size = len(query_words)
    if name_words[:size] == query_words:
        return WORD_PREFIX_SIMILARITY
    if any(name_words[start:start + size] == query_words for start in range(1, len(name_words) - size + 1)):
        return WORD_INSIDE_SIMILARITY
    return 0.0


def name_match(query: str, name: str) -> float:
    """Насколько название компании name подходит к запросу бота query (оба нормализованы), 0..1.

    Похожесть строк (name_similarity) или короткое имя бренда целыми словами (живой тест 31.10.2026: клиент написал
    «kusto», в базе «Kusto Logistics Management»): название начинается со слов запроса — 0.95, слова стоят дальше
    («Mks Kusto Logistics») — 0.8. Ровно 1.0 только у одинаковых названий: «та же компания» (find_known) не меняется.
    """
    return max(name_similarity(query, name), _word_match(query, name))


def _visible(char: str) -> str:
    category = unicodedata.category(char)
    if category == "Cc":
        return " "
    return "" if category.startswith("C") else char


def clean_text(value: str | None, limit: int) -> str | None:
    """Недоверенный текст наружу: без управляющих и невидимых символов, пробелы схлопнуты, не длиннее limit."""
    if value is None:
        return None
    # Управляющие (переводы строк, ESC) становятся пробелом; невидимые (нулевой ширины, смена направления) убираются.
    visible = "".join(_visible(char) for char in value)
    text = " ".join(visible.split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text or None


def _hide_phone(match: re.Match) -> str:
    digits = sum(char.isdigit() for char in match.group())
    return HIDDEN if 10 <= digits <= 15 else match.group()


def hide_contacts(value: str | None) -> str | None:
    """Убрать из текста адреса почты (и ivan [at] sklad [dot] kz) и телефоны: бот не получает контакты людей."""
    if value is None:
        return None
    unmasked = DOT_RE.sub(".", AT_RE.sub("@", value))
    return PHONE_IN_TEXT_RE.sub(_hide_phone, EMAIL_RE.sub(HIDDEN, unmasked))
