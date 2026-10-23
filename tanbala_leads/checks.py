"""Проверки письма кодом, без API. Правила из knowledge/tanbala-agent.md, разделы 8, 11, 12."""

from dataclasses import dataclass


@dataclass(frozen=True)
class CheckResult:
    name: str
    passed: bool
    details: tuple[str, ...] = ()


def check_dashes(body: str) -> CheckResult:
    """Нет тире в тексте письма.

    TODO: искать «—», «–» и дефис между пробелами.
    """
    raise NotImplementedError


def check_prices(text: str) -> CheckResult:
    """Нет цен, вилок цен, «от … тенге», расчётов экономии.

    TODO: regex на суммы, валюты и «тенге».
    """
    raise NotImplementedError


def check_stop_words(subject: str, body: str) -> CheckResult:
    """Нет запрещённых слов: акции, скидки, «бесплатно», срочность, «гарантируем», «официальный дилер».

    TODO: список из раздела 11 и требований к теме из раздела 8.
    """
    raise NotImplementedError


def check_links(body: str) -> CheckResult:
    """Из ссылок только WhatsApp. Ссылки на сайт запрещены.

    TODO: найти все URL и домены, разрешить только WhatsApp.
    """
    raise NotImplementedError


def check_length(body: str) -> CheckResult:
    """Первое письмо: 5–8 предложений.

    TODO: считать предложения без приветствия и подписи.
    """
    raise NotImplementedError


def check_signature(body: str) -> CheckResult:
    """Подпись по шаблону: имя, «Tanbala, направление ТОО «VenMart»», WhatsApp.

    TODO: сверять с шаблоном из раздела 8.
    """
    raise NotImplementedError


def check_notes(body: str) -> CheckResult:
    """Заметки проверяющему `[Проверить: …]` только в начале черновика, незаполненных `[имя]`, `[номер]` нет.

    TODO: разобрать квадратные скобки.
    """
    raise NotImplementedError


def check_jargon(body: str) -> CheckResult:
    """Нет жаргона: EPC, UHF, инлей, TID, энкодер.

    TODO: список из раздела 12, без учёта регистра.
    """
    raise NotImplementedError


def run_all(subject: str, body: str) -> list[CheckResult]:
    """Прогнать все проверки и вернуть результаты.

    TODO: вызвать все check_* по порядку.
    """
    raise NotImplementedError
