"""Шаг 7. Одобрение человеком. Результат: drafts.approved_by, статус approved."""


def approve(conn, draft_id: int, approved_by: str) -> None:
    """Одобрить черновик.

    TODO: записать кто и когда одобрил.
    """
    raise NotImplementedError


def reject(conn, draft_id: int, reviewer: str) -> None:
    """Отклонить черновик.

    TODO: компания не уходит дальше.
    """
    raise NotImplementedError
