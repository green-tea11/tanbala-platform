"""Кому можно писать: история писем и список «не писать». Раздел 13 документа о Tanbala."""


def can_contact(conn, company_id: int, email: str) -> bool:
    """Можно ли отправить первое письмо этой компании на этот адрес.

    TODO: нет записи в contact_history ни по компании, ни по адресу;
    нет записи в do_not_contact по адресу, домену или компании.
    """
    raise NotImplementedError


def record_message(conn, *, company_id: int | None, email: str, direction: str, draft_id: int | None = None) -> None:
    """Записать письмо в contact_history.

    TODO: direction: out или in.
    """
    raise NotImplementedError


def block(conn, *, reason: str, email: str | None = None, domain: str | None = None, company_id: int | None = None) -> None:
    """Добавить адрес, домен или компанию в do_not_contact.

    TODO: причины: отказ, жалоба, ручная блокировка.
    """
    raise NotImplementedError
