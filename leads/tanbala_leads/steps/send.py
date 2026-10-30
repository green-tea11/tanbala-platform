"""Шаг 8. Отправка писем. Сейчас только ТЕСТОВЫЙ режим: письмо уходит владельцу, а не компании.

Защита в несколько слоёв, чтобы во время тестов ничего не ушло на чужие адреса:
1. TEST_RECIPIENTS зашит в коде: другой адрес из .env отправку не разрешит.
2. assert_test_only проверяет и заголовки письма, и фактический список доставки прямо перед SMTP.
3. Таблица test_sends в базе принимает только этот адрес (db.py, миграция 5).
4. Боевой отправки нет: send_draft всегда отказывает.
5. Адрес компании в получатели не попадает вообще, только в пометку в тексте.
"""

import smtplib
import ssl
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

import psycopg
from psycopg.rows import dict_row

from tanbala_leads.settings import Settings, SettingsError

# Единственный адрес, куда сейчас можно отправлять. Расширять только по решению владельца.
TEST_RECIPIENTS = frozenset({"bogdansm2000@gmail.com"})
MAX_TEST_SENDS_PER_DAY = 30
SMTP_TIMEOUT_SECONDS = 30
NOTE_PREFIXES = ("[Проверить:", "[Ответить лично:")

TODAY_SENDS_SQL = """
SELECT count(*) FROM test_sends
WHERE status = 'sent'
  AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty'
"""


class SendBlocked(RuntimeError):
    """Отправка запрещена правилами тестового режима."""


class SendLimitReached(SendBlocked):
    """Дневной лимит тестовых отправок исчерпан (для API консоли это 429, а не 409)."""


class SendFailed(RuntimeError):
    """Почтовый сервер не принял письмо."""


@dataclass(frozen=True)
class TestSendResult:
    sent_to: str
    real_to: str
    message_id: str


def _clean(address: str) -> str:
    return address.strip().lower()


def assert_test_only(recipients: list[str]) -> None:
    """Последний рубеж: каждый получатель должен быть тестовым адресом, и список не пуст."""
    if not recipients:
        raise SendBlocked("Нет получателя")
    foreign = [address for address in recipients if _clean(address) not in TEST_RECIPIENTS]
    if foreign:
        raise SendBlocked(f"Отправка на {', '.join(foreign)} запрещена: в тестовом режиме только "
                          f"{', '.join(sorted(TEST_RECIPIENTS))}")


def test_recipient(settings: Settings) -> str:
    """Тестовый адрес из DRY_RUN_TO, но только если он есть в TEST_RECIPIENTS."""
    address = _clean(settings.dry_run_to)
    if address not in TEST_RECIPIENTS:
        raise SendBlocked(f"DRY_RUN_TO должен быть {', '.join(sorted(TEST_RECIPIENTS))}, сейчас «{address or 'пусто'}»")
    return address


def strip_reviewer_notes(body: str) -> str:
    """Убрать заметки проверяющему в начале черновика: клиенту они не уходят."""
    lines = body.splitlines()
    while lines and (not lines[0].strip() or lines[0].strip().startswith(NOTE_PREFIXES)):
        lines.pop(0)
    return "\n".join(lines)


def build_test_message(*, subject: str, body: str, real_to: str, test_to: str, from_addr: str,
                       from_name: str) -> EmailMessage:
    """Письмо для теста: только тестовый получатель, [ТЕСТ] в теме, сверху пометка, кому ушло бы в бою."""
    assert_test_only([test_to])
    message = EmailMessage()
    message["Subject"] = f"[ТЕСТ] {subject}"
    message["From"] = formataddr((f"{from_name}, Tanbala", from_addr))
    message["To"] = test_to
    message["Message-ID"] = make_msgid(domain=from_addr.rsplit("@", 1)[-1])
    notice = (f"Тестовая отправка Tanbala. В рабочем режиме письмо ушло бы на: {real_to}.\n"
              f"Компании это письмо не отправлялось.\n" + "-" * 40 + "\n\n")
    message.set_content(notice + strip_reviewer_notes(body))
    return message


def _smtp_port(settings: Settings) -> int:
    """SMTP_PORT числом. Не число — ошибка настроек, как и пустая переменная."""
    value = settings.require("smtp_port")
    if not (value.isascii() and value.isdigit()):
        raise SettingsError("SMTP_PORT должен быть числом, например 465. Исправьте его в .env.")
    return int(value)


def _envelope(message: EmailMessage) -> list[str]:
    return [address for header in ("To", "Cc", "Bcc") for address in message.get_all(header, [])]


def send_test(conn: psycopg.Connection, draft_id: int, settings: Settings,
              smtp_factory=smtplib.SMTP_SSL) -> TestSendResult:
    """Отправить черновик на тестовый адрес. Компании ничего не уходит, история писем не меняется."""
    to_addr = test_recipient(settings)
    with conn.cursor(row_factory=dict_row) as cursor:
        draft = cursor.execute(
            "SELECT d.subject, d.body, d.review_status, c.email FROM drafts d JOIN contacts c ON c.id = d.contact_id"
            " WHERE d.id = %s", (draft_id,),
        ).fetchone()
    if draft is None:
        raise SendBlocked("Черновик не найден")
    if draft["review_status"] == "rejected":
        raise SendBlocked("Отклонённое письмо не отправляется даже в тест")
    if conn.execute(TODAY_SENDS_SQL).fetchone()[0] >= MAX_TEST_SENDS_PER_DAY:
        raise SendLimitReached(f"Дневной лимит тестовых отправок {MAX_TEST_SENDS_PER_DAY} исчерпан")

    from_addr = settings.require("agent_email")
    message = build_test_message(subject=draft["subject"], body=draft["body"], real_to=draft["email"],
                                 test_to=to_addr, from_addr=from_addr, from_name=settings.require("agent_name"))
    envelope = [to_addr]
    assert_test_only(envelope)
    assert_test_only(_envelope(message))
    try:
        with smtp_factory(settings.require("smtp_host"), _smtp_port(settings),
                          timeout=SMTP_TIMEOUT_SECONDS, context=ssl.create_default_context()) as smtp:
            smtp.login(settings.require("smtp_user"), settings.require("smtp_password"))
            smtp.send_message(message, from_addr=from_addr, to_addrs=envelope)
    except (smtplib.SMTPException, OSError) as exc:
        error = f"SMTP: {type(exc).__name__}"
        conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, error) VALUES (%s, %s, %s, 'failed', %s)",
                     (draft_id, to_addr, draft["email"], error))
        raise SendFailed(f"Почтовый сервер не принял письмо ({error})") from exc
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, message_id) VALUES (%s, %s, %s, 'sent', %s)",
                 (draft_id, to_addr, draft["email"], message["Message-ID"]))
    return TestSendResult(sent_to=to_addr, real_to=draft["email"], message_id=message["Message-ID"])


def send_draft(conn, draft_id: int, **_kwargs) -> None:
    """Боевая отправка компании. Выключена: владелец разрешил только тестовый режим."""
    raise SendBlocked("Отправка компаниям выключена. Сейчас доступен только тест на "
                      f"{', '.join(sorted(TEST_RECIPIENTS))}")
