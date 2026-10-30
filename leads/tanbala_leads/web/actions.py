"""Действия кнопок почты: одобрить, отклонить, изменить, тест письма, «Больше не писать», «Снять отметку WhatsApp»,
запуск поиска и импорт «Кому писали».

Одни и те же функции зовут старый интерфейс (формы в web/app.py) и API консоли (JSON в web/console.py). Правила здесь,
в ядре (steps/approve.py, steps/send.py, contact_policy.py, pipeline.py) и в триггерах базы. Отказ — ActionError:
HTTP-статус и код для API консоли и понятный текст. Где старый интерфейс отвечал иначе, у ошибки свои page_status и
page_message: его поведение не меняется.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import psycopg

from tanbala_leads import contact_policy, pipeline
from tanbala_leads.internal import brief
from tanbala_leads.steps import approve as approve_step
from tanbala_leads.steps import send as send_step
from tanbala_leads.web import queries as q
from tanbala_leads.web import views
from tanbala_leads.web.format import decode_upload, prepare_import_text
from tanbala_leads.web.labels import (
    BLOCKED_MESSAGE,
    IMPORT_INVALID_SHOWN,
    IMPORT_KINDS,
    MAX_UPLOAD_BYTES,
    REJECTED_TEST_TEXT,
    TEST_OFF_TEXT,
)

LETTER_NOT_FOUND = "Письмо не найдено."
COMPANY_NOT_FOUND = "Компания не найдена."
REJECTED_MESSAGE = "Письмо уже отклонено. Новый черновик напишет следующий запуск."
NOT_PENDING_MESSAGE = "Письмо уже отправлено или отклонено."
ACTIVE_DRAFT_MESSAGE = "У компании уже есть другое активное письмо."
# Триггер drafts_forbid_whatsapp: старый интерфейс показывал вместо этого ACTIVE_DRAFT_MESSAGE.
WHATSAPP_DRAFT_MESSAGE = "Компания пришла из WhatsApp: письмо ей одобрить нельзя"
BLOCK_NOTE = "кнопка «Больше не писать»"
UNKNOWN_LIST_MESSAGE = "Неизвестный список."
EMPTY_LIST_MESSAGE = "Список пуст: вставьте адреса или выберите файл."
FILE_TOO_BIG_MESSAGE = "Файл больше 1 МБ. Разделите список на части."
FILE_NOT_UTF8_MESSAGE = "Файл не в кодировке UTF-8. Сохраните его как UTF-8 и загрузите снова."


class ActionError(Exception):
    """Действие не выполнено. status и code — для API консоли, message — текст для человека.

    page_status и page_message — что показывает старый интерфейс, если у него было иначе (по умолчанию то же).
    """

    def __init__(self, status: int, code: str, message: str, *, page_status: int | None = None,
                 page_message: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.page_status = page_status or status
        self.page_message = page_message or message


class EditRefused(ActionError):
    """Правка письма не прошла проверку. Тема и текст после чистки: форма откроется снова с ними."""

    def __init__(self, message: str, subject: str, body: str):
        super().__init__(422, "refused", message, page_status=400)
        self.subject = subject
        self.body = body


@dataclass(frozen=True)
class ImportSummary:
    added: int
    skipped: int  # уже были, в том числе из «не писать»
    invalid: tuple[str, ...]  # первые IMPORT_INVALID_SHOWN нераспознанных строк, каждая до 100 символов
    invalid_more: int


# ---------- письма ----------


def draft_ref(conn: psycopg.Connection, draft_id: int) -> dict[str, Any]:
    """Письмо для одобрения, отклонения или правки. Нет: 404. Отклонённое не возвращается: 409."""
    ref = q.fetch_draft_ref(conn, draft_id)
    if ref is None:
        raise ActionError(404, "not_found", LETTER_NOT_FOUND)
    # Кнопки отклонённого письма скрыты; старая вкладка или повтор запроса не должны его вернуть.
    if ref["review_status"] == "rejected":
        raise ActionError(409, "conflict", REJECTED_MESSAGE)
    return ref


def _from_whatsapp(conn: psycopg.Connection, company_id: int) -> bool:
    row = conn.execute("SELECT requested_via IS NOT NULL FROM companies WHERE id = %s", (company_id,)).fetchone()
    return bool(row and row[0])


def _decide(conn: psycopg.Connection, ref: dict[str, Any], action: Callable[[], Any]) -> Any:
    """Решение по письму в ядре. Письмо успели отправить или отклонить: 409. Ограничение базы: 409."""
    try:
        return action()
    except approve_step.DraftNotFound as exc:
        raise ActionError(409, "conflict", NOT_PENDING_MESSAGE) from exc
    except psycopg.errors.IntegrityError as exc:
        # CheckViolation у компании из WhatsApp — триггер drafts_forbid_whatsapp: письмо ей не одобрить.
        whatsapp = isinstance(exc, psycopg.errors.CheckViolation) and _from_whatsapp(conn, ref["company_id"])
        message = WHATSAPP_DRAFT_MESSAGE if whatsapp else ACTIVE_DRAFT_MESSAGE
        raise ActionError(409, "conflict", message, page_message=ACTIVE_DRAFT_MESSAGE) from exc


def approve(conn: psycopg.Connection, ref: dict[str, Any], approved_by: str) -> None:
    """«Одобрить». Компания в «не писать» (сама, домен или адрес получателя): 409. Отправки компании нет."""
    # Кнопка у такой компании выключена; сервер не полагается на то, что её не нажали.
    if ref["blocked"]:
        raise ActionError(409, "conflict", BLOCKED_MESSAGE)
    _decide(conn, ref, lambda: approve_step.approve(conn, ref["id"], approved_by))


def reject(conn: psycopg.Connection, ref: dict[str, Any], reviewer: str) -> None:
    """«Отклонить»: компания возвращается к статусу «Почта проверена»."""
    _decide(conn, ref, lambda: approve_step.reject(conn, ref["id"], reviewer))


def edit(conn: psycopg.Connection, ref: dict[str, Any], subject: str, body: str) -> list[dict]:
    """«Изменить»: тема и текст, проверки кодом заново, одобрение снимается. Вернуть новые проверки."""
    subject, body, error = views.validate_draft_edit(subject, body)
    if error:
        raise EditRefused(error, subject, body)
    return _decide(conn, ref, lambda: approve_step.update_draft(conn, ref["id"], subject, body))


def draft_for_test_send(conn: psycopg.Connection, draft_id: int) -> dict[str, Any]:
    """Письмо для тестовой отправки. Нет: 404 (отклонённое проверяет send_test)."""
    ref = q.fetch_draft_ref(conn, draft_id)
    if ref is None:
        raise ActionError(404, "not_found", LETTER_NOT_FOUND)
    return ref


def send_test(conn: psycopg.Connection, ref: dict[str, Any], *, test_to: str | None,
              sender: Callable[[psycopg.Connection, int], send_step.TestSendResult] | None
              ) -> send_step.TestSendResult:
    """«Отправить тест»: письмо уходит только на адрес владельца, компании ничего не отправляется.

    Ошибки настроек SMTP (SettingsError, ValueError) не ловятся здесь: старый интерфейс их не ловил,
    API консоли отвечает на них 503.
    """
    if test_to is None or sender is None:
        raise ActionError(409, "conflict", TEST_OFF_TEXT + ".")
    if ref["review_status"] == "rejected":
        raise ActionError(409, "conflict", REJECTED_TEST_TEXT)
    try:
        return sender(conn, ref["id"])
    except send_step.SendLimitReached as exc:
        raise ActionError(429, "test_limit", str(exc), page_status=409) from exc
    except send_step.SendBlocked as exc:
        raise ActionError(409, "conflict", str(exc)) from exc
    except send_step.SendFailed as exc:
        raise ActionError(502, "send_failed", str(exc)) from exc


# ---------- компании ----------


def _company(conn: psycopg.Connection, company_id: int) -> dict[str, Any]:
    company = q.fetch_company(conn, company_id)
    if company is None:
        raise ActionError(404, "not_found", COMPANY_NOT_FOUND)
    return company


def block_company(conn: psycopg.Connection, company_id: int) -> None:
    """«Больше не писать»: компания, её корпоративный домен и все её адреса в do_not_contact. Повтор безопасен."""
    _company(conn, company_id)
    contact_policy.block_company(conn, company_id, note=BLOCK_NOTE)


def clear_whatsapp(conn: psycopg.Connection, company_id: int) -> str | None:
    """«Снять отметку WhatsApp»: бот перепутал компанию. Снимаются обе пометки. Вернуть прежний requested_via."""
    company = _company(conn, company_id)
    brief.clear_whatsapp_marks(conn, company_id)
    return company["requested_via"]


# ---------- поиск ----------


def start_search(start_run: Callable[[str, str, int], int], city: str, query: str, count: int | None) -> int:
    """«Найти компании»: проверки и запуск в фоне (pipeline.create_run). Вернуть id запуска.

    Уже идёт запуск: 409. Дневной бюджет исчерпан: 429 (старый интерфейс: 400). Неверные поля: 400.
    """
    try:
        if count is None:
            raise ValueError(f"Число компаний должно быть от 1 до {pipeline.MAX_COMPANIES_LIMIT}")
        return start_run(city, query.strip(), count)
    except pipeline.RunAlreadyActive as exc:
        raise ActionError(409, "conflict", str(exc)) from exc
    except pipeline.BudgetExceeded as exc:
        raise ActionError(429, "budget_exhausted", str(exc), page_status=400) from exc
    except ValueError as exc:
        raise ActionError(400, "bad_request", str(exc)) from exc


# ---------- кому писали ----------


def import_refused(kind: str) -> bool:
    """Какой список: «Уже писали раньше» (False) или «Не писать» (True). Другой: 400."""
    if kind not in IMPORT_KINDS:
        raise ActionError(400, "bad_request", UNKNOWN_LIST_MESSAGE)
    return IMPORT_KINDS[kind]


def decode_list_file(data: bytes) -> str:
    """Текст файла списка: до 1 МБ, UTF-8 (с BOM или без). Иначе 400 с понятной причиной."""
    if len(data) > MAX_UPLOAD_BYTES:
        raise ActionError(400, "bad_request", FILE_TOO_BIG_MESSAGE)
    text = decode_upload(data)
    if text is None:
        raise ActionError(400, "bad_request", FILE_NOT_UTF8_MESSAGE)
    return text


def import_list(conn: psycopg.Connection, refused: bool, text: str) -> ImportSummary:
    """Импорт списка одной транзакцией: адреса (и домены у «Не писать») по строке. Пусто или слишком много: 400."""
    items = prepare_import_text(text)
    if not items:
        raise ActionError(400, "bad_request", EMPTY_LIST_MESSAGE)
    try:
        outcome = contact_policy.import_contacts(conn, items, refused=refused)
    except ValueError as exc:
        raise ActionError(400, "bad_request", str(exc)) from exc
    return ImportSummary(added=outcome.added, skipped=outcome.skipped,
                         invalid=outcome.invalid[:IMPORT_INVALID_SHOWN],
                         invalid_more=max(0, len(outcome.invalid) - IMPORT_INVALID_SHOWN))
