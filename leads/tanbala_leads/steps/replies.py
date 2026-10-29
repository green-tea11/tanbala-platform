"""Ответы клиентов: разбор (задача classify_reply) и черновик ответа (задача reply). Статус replied."""


def classify_reply(text: str) -> str:
    """Определить тип ответа: интерес, вопрос, отказ, не по адресу, жалоба.

    TODO: сначала правила без AI, модель только если правила не решили.
    """
    raise NotImplementedError


def handle_reply(conn, company_id: int, text: str) -> int | None:
    """Обработать ответ. Вернуть id черновика ответа или None.

    TODO: отказ и жалоба: в do_not_contact; не по адресу: один вопрос, кому писать.
    """
    raise NotImplementedError
