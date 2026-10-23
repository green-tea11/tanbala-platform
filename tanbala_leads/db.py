"""Схема PostgreSQL и миграции."""


def connect():
    """Открыть соединение с Postgres по строке из настроек.

    TODO: psycopg.connect(DATABASE_URL).
    """
    raise NotImplementedError


def migrate(conn) -> list[int]:
    """Применить недостающие миграции. Вернуть номера применённых.

    TODO: таблицы companies, contacts, qualifications, drafts, contact_history, do_not_contact.
    """
    raise NotImplementedError
