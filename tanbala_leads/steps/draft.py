"""Шаг 5. Черновик первого письма (задача first_email). Результат: drafts, статус drafted."""


def choose_contact(conn, company_id: int) -> int | None:
    """Выбрать адрес для письма с учётом истории и списка «не писать».

    TODO: contact_policy.can_contact, приоритет проверенным адресам.
    """
    raise NotImplementedError


def draft_first_email(conn, company_id: int) -> int:
    """Написать черновик по причине из qualifications. Вернуть id черновика.

    TODO: только факты из карточки 2ГИС и сайта, правила документа о Tanbala.
    """
    raise NotImplementedError
