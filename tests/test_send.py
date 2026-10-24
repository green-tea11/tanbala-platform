import pytest

from tanbala_leads import db
from tanbala_leads.settings import load_settings
from tanbala_leads.steps import send

psycopg = pytest.importorskip("psycopg")

TEST_ADDRESS = "bogdansm2000@gmail.com"
BODY = (
    "[Проверить: нет данных о складе]\n"
    "Здравствуйте!\n\nМеня зовут Арман, я из Tanbala.\n\n"
    "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238"
)


def settings(**overrides):
    values = {"SMTP_HOST": "venmart.kz", "SMTP_PORT": "465", "SMTP_USER": "tanbala@venmart.kz",
              "SMTP_PASSWORD": "secret", "AGENT_NAME": "Арман", "AGENT_EMAIL": "tanbala@venmart.kz",
              "DRY_RUN_TO": TEST_ADDRESS}
    values.update(overrides)
    return load_settings(values)


class FakeSMTP:
    """Как smtplib.SMTP_SSL: запоминает вход и отправленное."""

    sent: list = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def login(self, user, password):
        self.user = user

    def send_message(self, message, from_addr=None, to_addrs=None):
        FakeSMTP.sent.append((message, from_addr, to_addrs))
        return {}


@pytest.fixture(autouse=True)
def clean_fake():
    FakeSMTP.sent = []


# Только тестовый адрес

def test_allowed_recipients_are_hardcoded():
    assert send.TEST_RECIPIENTS == frozenset({TEST_ADDRESS})


@pytest.mark.parametrize("recipients", [["info@pel.kz"], [TEST_ADDRESS, "info@pel.kz"], [], ["BOGDANSM2000@gmail.com "]])
def test_any_other_recipient_is_blocked(recipients):
    if recipients == ["BOGDANSM2000@gmail.com "]:
        send.assert_test_only(recipients)  # тот же адрес в другом регистре и с пробелом разрешён
        return
    with pytest.raises(send.SendBlocked):
        send.assert_test_only(recipients)


def test_test_address_from_settings_must_be_the_hardcoded_one():
    with pytest.raises(send.SendBlocked):
        send.test_recipient(settings(DRY_RUN_TO="info@pel.kz"))
    with pytest.raises(send.SendBlocked):
        send.test_recipient(settings(DRY_RUN_TO=""))
    assert send.test_recipient(settings()) == TEST_ADDRESS


def test_live_sending_is_not_possible():
    with pytest.raises(send.SendBlocked):
        send.send_draft(None, 1)


# Письмо

def test_notes_never_go_out():
    assert send.strip_reviewer_notes(BODY).startswith("Здравствуйте!")


def test_test_message_goes_only_to_test_address_and_mentions_real_one():
    message = send.build_test_message(subject="Учёт склада", body=BODY, real_to="info@pel.kz",
                                      test_to=TEST_ADDRESS, from_addr="tanbala@venmart.kz", from_name="Арман")

    assert message["To"] == TEST_ADDRESS
    assert message["Cc"] is None and message["Bcc"] is None
    assert message["Subject"] == "[ТЕСТ] Учёт склада"
    text = message.get_content()
    assert "info@pel.kz" in text and "не отправлялось" in text
    assert "[Проверить" not in text
    assert "info@pel.kz" not in str(message["To"])


# Отправка из базы

@pytest.fixture
def draft_id(db_conn):
    db.migrate(db_conn)
    company_id = db_conn.execute("INSERT INTO companies (name, status) VALUES ('ТОО', 'drafted') RETURNING id").fetchone()[0]
    contact_id = db_conn.execute("INSERT INTO contacts (company_id, email) VALUES (%s, 'info@pel.kz') RETURNING id",
                                 (company_id,)).fetchone()[0]
    return db_conn.execute("INSERT INTO drafts (company_id, contact_id, subject, body) VALUES (%s, %s, 'Учёт склада', %s)"
                           " RETURNING id", (company_id, contact_id, BODY)).fetchone()[0]


@pytest.mark.db
def test_send_test_uses_envelope_with_test_address_only(db_conn, draft_id):
    result = send.send_test(db_conn, draft_id, settings(), smtp_factory=FakeSMTP)

    message, from_addr, to_addrs = FakeSMTP.sent[0]
    assert to_addrs == [TEST_ADDRESS] and from_addr == "tanbala@venmart.kz"
    assert result.sent_to == TEST_ADDRESS and result.real_to == "info@pel.kz"


@pytest.mark.db
def test_test_send_is_logged_but_not_counted_as_real_contact(db_conn, draft_id):
    send.send_test(db_conn, draft_id, settings(), smtp_factory=FakeSMTP)

    assert db_conn.execute("SELECT sent_to, real_to, status FROM test_sends").fetchone() == (TEST_ADDRESS, "info@pel.kz", "sent")
    assert db_conn.execute("SELECT count(*) FROM contact_history").fetchone()[0] == 0
    assert db_conn.execute("SELECT sent_at FROM drafts").fetchone()[0] is None


@pytest.mark.db
def test_database_refuses_any_other_test_address(db_conn, draft_id):
    with pytest.raises(psycopg.errors.CheckViolation):
        db_conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status) VALUES (%s, 'info@pel.kz', 'info@pel.kz', 'sent')",
                        (draft_id,))


@pytest.mark.db
def test_smtp_failure_is_logged_and_reported(db_conn, draft_id):
    class BrokenSMTP(FakeSMTP):
        def login(self, user, password):
            raise send.smtplib.SMTPAuthenticationError(535, b"bad password")

    with pytest.raises(send.SendFailed, match="SMTP"):
        send.send_test(db_conn, draft_id, settings(), smtp_factory=BrokenSMTP)

    status, error = db_conn.execute("SELECT status, error FROM test_sends").fetchone()
    assert status == "failed" and "secret" not in error


@pytest.mark.db
def test_rejected_draft_is_not_sent(db_conn, draft_id):
    db_conn.execute("UPDATE drafts SET review_status = 'rejected'")

    with pytest.raises(send.SendBlocked):
        send.send_test(db_conn, draft_id, settings(), smtp_factory=FakeSMTP)
    assert FakeSMTP.sent == []


@pytest.mark.db
def test_daily_test_send_limit(db_conn, draft_id, monkeypatch):
    monkeypatch.setattr(send, "MAX_TEST_SENDS_PER_DAY", 1)
    send.send_test(db_conn, draft_id, settings(), smtp_factory=FakeSMTP)

    with pytest.raises(send.SendBlocked, match="лимит"):
        send.send_test(db_conn, draft_id, settings(), smtp_factory=FakeSMTP)
