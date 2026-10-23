"""Шаг 8. Отправка одобренных писем. Сейчас только --dry-run на тестовый адрес."""


def strip_reviewer_notes(body: str) -> str:
    """Убрать заметки `[Проверить: …]`, они клиенту не уходят.

    TODO: удалить квадратные скобки в начале черновика.
    """
    raise NotImplementedError


def send_draft(conn, draft_id: int, *, dry_run: bool = True, test_address: str | None = None) -> None:
    """Отправить одобренный черновик и записать в contact_history.

    TODO: порядок: строка out в contact_history и коммит, потом SMTP, потом drafts.sent_at.
    Тогда сбой после SMTP не приведёт к повторному письму. При ошибке SMTP строку истории убрать.
    Реальная отправка запрещена, пока не разрешит владелец.
    """
    raise NotImplementedError
