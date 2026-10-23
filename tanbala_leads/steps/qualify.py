"""Шаг 3. Подходит ли компании RFID (задача qualify). Результат: qualifications, статус qualified или rejected."""


def build_input(company: dict) -> str:
    """Собрать вход для модели: карточка 2ГИС и текст сайта.

    TODO: только факты из карточки и сайта.
    """
    raise NotImplementedError


def parse_answer(text: str) -> dict:
    """Разобрать JSON ответа: fit, score, reason, segment.

    TODO: проверить поля и диапазон score 0–100.
    """
    raise NotImplementedError


def qualify_company(conn, company_id: int) -> dict:
    """Квалифицировать одну компанию и записать результат.

    TODO: rejected компании дальше не идут.
    """
    raise NotImplementedError
