"""Шаг 4. Проверка почт через Reacher. Результат: contacts.verify_result, статус verified."""


def check_email(email: str) -> dict:
    """Проверить один адрес через Reacher и вернуть ответ.

    TODO: POST в Reacher, паузы между проверками.
    """
    raise NotImplementedError


def verify_company(conn, company_id: int) -> int:
    """Проверить все почты компании. Вернуть число пригодных.

    TODO: catch-all помечать как «не проверено».
    """
    raise NotImplementedError
