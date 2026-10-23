"""Проверки письма кодом, без API. Правила из knowledge/tanbala-agent.md, разделы 8, 11, 12."""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    details: tuple[str, ...] = ()


MIN_SENTENCES = 5
MAX_SENTENCES = 8
MAX_NAME_LENGTH = 40
CONTEXT_CHARS = 25
COMPANY_LINE = "Tanbala, направление ТОО «VenMart»"
ALLOWED_LINK_HOSTS = frozenset({"wa.me", "api.whatsapp.com"})
ALLOWED_CAPS = frozenset({"RFID", "ТОО", "БИН", "ИИН"})

_FLAGS = re.IGNORECASE
_NOTE_LINE = re.compile(r"^\[(?:Проверить|Ответить лично):[^\]]*\]\s*$")
_GREETING = re.compile(
    r"^(?:здравствуйте|добрый день|добрый вечер|доброе утро)\b[^.!?]{0,40}[!.,]?$", _FLAGS
)
_PHONE_LINE = re.compile(r"^WhatsApp: \+7(?: ?\d){10}$")
_SENTENCE_END = re.compile(r"(?<=[.!?…])\s+(?=[«\"(]?[А-ЯЁA-Z0-9])")


def _norm(text: str) -> str:
    """Нижний регистр и ё -> е, чтобы словари не зависели от написания."""
    return text.lower().replace("ё", "е")


def _compile(patterns: list[str]) -> list[re.Pattern[str]]:
    return [re.compile(p, _FLAGS) for p in patterns]


def _snippet(text: str, match: re.Match[str]) -> str:
    """Найденный фрагмент с небольшим контекстом, в одну строку."""
    start = max(0, match.start() - CONTEXT_CHARS)
    end = min(len(text), match.end() + CONTEXT_CHARS)
    return " ".join(text[start:end].split())


def _scan(text: str, patterns: list[re.Pattern[str]], reason: str, prefix: str = "") -> list[str]:
    """По каждому шаблону все совпадения -> «причина: «фрагмент»»."""
    found = []
    for pattern in patterns:
        for match in pattern.finditer(text):
            found.append(f"{prefix}{reason}: «{match.group(0).strip()}» в «…{_snippet(text, match)}…»")
    return found


def _result(name: str, problems: list[str]) -> CheckResult:
    return CheckResult(name, not problems, tuple(problems))


def _split_notes(body: str) -> tuple[list[str], list[str]]:
    """Отделить заметки проверяющему в начале черновика от остального письма."""
    lines = body.splitlines()
    index = 0
    while index < len(lines) and (not lines[index].strip() or _NOTE_LINE.match(lines[index].strip())):
        index += 1
    return lines[:index], lines[index:]


def _client_text(body: str) -> str:
    """Текст письма без заметок проверяющему: клиенту они не уходят."""
    return "\n".join(_split_notes(body)[1])


def _with_subject(subject: str, body: str) -> str:
    return f"{subject}\n{_client_text(body)}"


def _signature_start(lines: list[str]) -> int:
    """Индекс первой строки подписи (имя над строкой «Tanbala, ...»), иначе len(lines)."""
    for index in range(len(lines) - 1, -1, -1):
        if lines[index].strip().startswith("Tanbala,"):
            while index > 0 and not lines[index - 1].strip():
                index -= 1
            return max(index - 1, 0)
    return len(lines)


def _main_text(body: str) -> str:
    """Тело письма без заметок, приветствия и подписи."""
    lines = _split_notes(body)[1]
    lines = lines[: _signature_start(lines)]
    non_empty = [i for i, line in enumerate(lines) if line.strip()]
    if non_empty and _GREETING.match(lines[non_empty[0]].strip()):
        lines = lines[non_empty[0] + 1 :]
    return " ".join(" ".join(lines).split())


# --- тире ---

_DASH_PATTERNS = [
    re.compile(r"[—–―−‒]"),
    re.compile(r"(?:(?<=\s)|^)[-‐‑](?=\s|$)", re.MULTILINE),
]


def check_dashes(body: str) -> CheckResult:
    """Нет тире в тексте письма: «—», «–» и дефис между пробелами. Дефис в слове можно."""
    text = _client_text(body)
    return _result("dashes", _scan(text, _DASH_PATTERNS, "тире"))


# --- цены ---

_CURRENCY = r"(?:тенге|тг(?![а-я])|тнг(?![а-я])|₸|руб(?![а-я])|рубл\w*|\$|€|usd|kzt|долл\w*|евро)"
_PRICE_PATTERNS = _compile(
    [
        rf"\d[\d\s.,]*{_CURRENCY}",
        r"(?<![а-я])тенге(?![а-я])|₸|\$|€",
        r"\d+(?:[.,]\d+)?\s*(?:%|процент\w*)",
        r"сэконом\w*|экономи[яию]\s+\d",
        r"(?<![а-я])(?:цена|цены|цену|стоимость|стоит|стоят)(?![а-я])[^.!?\n]{0,30}\d",
    ]
)


def check_prices(text: str) -> CheckResult:
    """Нет цен, вилок цен, «от … тенге», ₸, тг/тнг, «руб», $, «сэкономите N», процентов экономии."""
    return _result("prices", _scan(_client_text(text), _PRICE_PATTERNS, "цена"))


# --- стоп-слова ---

_STOP_PATTERNS = _compile(
    [
        r"(?<![а-я])акци(?:я|и|ю|ей|ями|ях|й)(?![а-я])",
        r"(?<![а-я])скидк\w*",
        r"(?<![а-я])бесплатн\w*",
        r"(?<![а-я])пробн\w+\s+период\w*",
        r"(?<![а-я])только\s+(?:сейчас|сегодня)",
        r"(?<![а-я])успей\w*",
        r"(?<![а-я])срочн\w*|осталось\s+мало",
        r"(?<![а-я])выгодн\w*",
        r"(?<![а-я])спецпредложени\w*|(?<![а-я])специальн\w+\s+предложени\w*",
        r"(?<![а-я])бонус\w*",
        r"(?<![а-я])подар\w*",
        r"(?<![а-я])гарантир\w*",
        r"100\s*%",
        r"(?<![а-я])официальн\w+\s+дилер\w*",
        r"(?<![а-я])люб\w+\s+1\s*[сc](?![а-яa-z])",
        r"(?<![а-я])никогда\s+не\s+потеря\w*",
        r"(?<![а-я])образц\w*",
        r"(?<![а-я])тестов\w+\s+комплект\w*",
        r"(?<![а-я])в\s+\d+(?:[.,]\d+)?\s+раз(?![а-я])",
        r"(?<![а-я])по\s+всему\s+казахстан\w*|по\s+всей\s+стране",
        r"(?<![а-я])за\s+\d+(?:\s*[-‐‑–—]\s*\d+)?\s*(?:дн|недел|месяц|час|минут)\w*",
        r"(?<![а-я])без\s+оплат\w*",
        r"(?<![а-я])сроки?\s+(?:внедрени|поставк)\w*",
        r"(?<![а-я])в\s+наличии|наличи[ея]\s+на\s+склад\w*",
        r"(?<![а-я])(?:ответим|свяжемся|позвоним|перезвоним)[^.!?\n]{0,20}(?:сегодня|час|минут)",
        r"(?<![а-я])оставь\w*\s+(?:\w+\s+){0,3}штрихкод\w*",
    ]
)


def check_stop_words(subject: str, body: str) -> CheckResult:
    """Нет запрещённых слов раздела 11 (акции, скидки, «бесплатно», срочность и т.д.) в теме и в письме."""
    problems = _scan(_norm(subject), _STOP_PATTERNS, "стоп-слово", "тема, ")
    problems += _scan(_norm(_client_text(body)), _STOP_PATTERNS, "стоп-слово")
    return _result("stop_words", problems)


# --- ссылки ---

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_LINK = re.compile(
    r"(?:https?://|www\.)\S+|(?<![\w@.-])[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,}|рф)(?![\w])(?:/\S*)?",
    _FLAGS,
)
_LINK_TAIL = ".,;:!?)»\"'"


def _link_host(link: str) -> str:
    host = re.sub(r"^https?://", "", link.rstrip(_LINK_TAIL).lower())
    host = re.split(r"[/?#]", host, maxsplit=1)[0]
    return host.removeprefix("www.")


def check_links(body: str) -> CheckResult:
    """Из ссылок только WhatsApp (wa.me, api.whatsapp.com). Сайты и домены запрещены, почта не ссылка."""
    text = _EMAIL.sub(" ", _client_text(body))
    problems = [
        f"ссылка не WhatsApp: «{m.group(0).rstrip(_LINK_TAIL)}»"
        for m in _LINK.finditer(text)
        if _link_host(m.group(0)) not in ALLOWED_LINK_HOSTS
    ]
    return _result("links", problems)


# --- длина ---


def _count_sentences(text: str) -> int:
    return len([part for part in _SENTENCE_END.split(text) if part.strip()])


def check_length(body: str) -> CheckResult:
    """Первое письмо: 5–8 предложений без приветствия, заметок и подписи."""
    count = _count_sentences(_main_text(body))
    if MIN_SENTENCES <= count <= MAX_SENTENCES:
        return CheckResult("length", True)
    return CheckResult(
        "length", False, (f"предложений: {count}, нужно {MIN_SENTENCES}–{MAX_SENTENCES}",)
    )


# --- подпись ---


def _name_problem(name: str) -> str | None:
    if not name:
        return "нет строки с именем"
    if "[" in name or "]" in name:
        return f"в подписи заглушка: «{name}»"
    if len(name) > MAX_NAME_LENGTH or re.search(r"\d|[.!?:]$", name):
        return f"строка имени похожа не на имя: «{name}»"
    return None


def check_signature(body: str) -> CheckResult:
    """Подпись: имя, «Tanbala, направление ТОО «VenMart»», «WhatsApp: +7 и 10 цифр» (последние 3 строки)."""
    lines = [line.strip() for line in body.splitlines() if line.strip()]
    if len(lines) < 3:
        return CheckResult("signature", False, ("нет подписи из трёх строк",))
    name, company, phone = lines[-3:]
    problems = []
    if (problem := _name_problem(name)) is not None:
        problems.append(problem)
    if company != COMPANY_LINE:
        problems.append(f"вторая строка подписи должна быть «{COMPANY_LINE}», а не «{company}»")
    if not _PHONE_LINE.match(phone):
        problems.append(f"третья строка должна быть «WhatsApp: +7…» (10 цифр), а не «{phone}»")
    return _result("signature", problems)


# --- заметки и скобки ---

_BRACKET = re.compile(r"\[[^\]\n]*\]|[\[\]]")


def check_notes(body: str) -> CheckResult:
    """Заметки `[Проверить: …]`/`[Ответить лично: …]` только до приветствия, других скобок нет."""
    text = _client_text(body)
    problems = [
        f"квадратные скобки вне заметки в начале: «{m.group(0)}»" for m in _BRACKET.finditer(text)
    ]
    return _result("notes", problems)


# --- жаргон ---

_JARGON_PATTERNS = _compile(
    [
        r"(?<![\w])(?:epc|uhf|tid|dbm|gen\s?2)(?![\w])",
        r"(?<![\w])инл[еэ]\w*",
        r"(?<![\w])энкодер\w*",
        r"(?<![\w])(?:мгц|ггц|кгц|мвт|мегагерц\w*)(?![\w])",
        r"(?<![\w])(?:zebra|impinj|chainway|silion|invengo|honeywell)(?![\w])",
        r"(?<![\w])частот\w*",
    ]
)


def check_jargon(body: str) -> CheckResult:
    """Нет жаргона (EPC, UHF, инлей, TID, энкодер) и моделей, брендов, частот из раздела 11."""
    return _result("jargon", _scan(_client_text(body), _JARGON_PATTERNS, "жаргон"))


# --- стиль ---

_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⭐⭕️‍]")
_STYLE_PATTERNS = [
    (_EMOJI, "смайлик"),
    (re.compile(r"!{2,}"), "несколько «!» подряд"),
    (
        re.compile(
            r"(?<![\w])(?:нейросет\w*|чат-?бот\w*|бот(?:ом|а|ы|у)?|chatgpt|gpt|llm|claude"
            r"|искусственн\w+\s+интеллект\w*"
            r"|программ\w*\s+(?:написал|подготовил|сгенерировал|составил)\w*"
            r"|(?:написан|подготовлен|сгенерирован|составлен|создан)\w*\s+(?:\w+\s+){0,2}?(?:программ|ии|ai)\w*"
            r"|автоматическ\w+\s+(?:письм|сообщ)\w*)(?![\w])",
            _FLAGS,
        ),
        "упоминание, что письмо пишет программа",
    ),
    (re.compile(r"(?<![\w])(?:ИИ|AI)(?![\w])"), "упоминание, что письмо пишет программа"),
]
_CAPS = re.compile(r"(?<![\w])[A-ZА-ЯЁ]{4,}(?![\w])")


def check_style(subject: str, body: str) -> CheckResult:
    """Без смайликов, нескольких «!» подряд, капслока (4+ буквы, кроме RFID/ТОО) и упоминаний программы/ИИ."""
    text = _with_subject(subject, body)
    problems = []
    for pattern, reason in _STYLE_PATTERNS:
        problems += _scan(text, [pattern], reason)
    problems += [
        f"капслок: «{m.group(0)}»"
        for m in _CAPS.finditer(text)
        if m.group(0) not in ALLOWED_CAPS
    ]
    return _result("style", problems)


def run_all(subject: str, body: str) -> list[CheckResult]:
    """Прогнать все проверки (тема учитывается там, где у правил есть требования к теме)."""
    with_subject = _with_subject(subject, body)
    notes = check_notes(body)
    subject_brackets = check_notes(subject)
    if not subject_brackets.passed:
        notes = CheckResult(
            "notes", False, notes.details + tuple(f"тема, {d}" for d in subject_brackets.details)
        )
    return [
        check_dashes(with_subject),
        check_prices(with_subject),
        check_stop_words(subject, body),
        check_links(with_subject),
        check_length(body),
        check_signature(body),
        notes,
        check_jargon(with_subject),
        check_style(subject, body),
    ]
