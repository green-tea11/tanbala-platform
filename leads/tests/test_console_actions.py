"""Действия API консоли: те же функции, что у кнопок старого интерфейса (web/actions.py), с проверками и триггерами
базы. Без сети, без Claude API, без SMTP: поиск и тестовая отправка подменены.
"""

import base64
import logging

import pytest
from console_support import (
    POST,
    PREFIX,
    TEST_TO,
    USER,
    FakeSender,
    FakeStartRun,
    console_db,  # noqa: F401  фикстура
    full_company,
    get,
    make_client,
    ok,
    post,
    problem,
    seed_company,
    seed_contact,
    seed_draft,
    seed_run,
)

from tanbala_leads import contact_policy, pipeline
from tanbala_leads.settings import SettingsError
from tanbala_leads.steps import approve as approve_step
from tanbala_leads.steps import send as send_step

pytestmark = pytest.mark.db

WHATSAPP_MESSAGE = "Компания пришла из WhatsApp: письмо ей одобрить нельзя"


def client_for(console_db, **options):
    _, connect, _ = console_db
    return make_client(connect, **options)


def draft_row(conn, draft_id):
    return conn.execute("SELECT d.review_status, d.approved_by, c.status FROM drafts d JOIN companies c"
                        " ON c.id = d.company_id WHERE d.id = %s", (draft_id,)).fetchone()


# ---------- одобрить, отклонить ----------


def test_approve_writes_console_user_and_company_status(console_db, caplog):
    conn, _, opened = console_db
    caplog.set_level(logging.INFO, logger="tanbala_leads")
    _, _, draft_id = full_company(conn)

    response = post(client_for(console_db), f"/drafts/{draft_id}/approve")

    assert ok(response) == {"result": "approved"}
    assert draft_row(conn, draft_id) == ("approved", USER, "approved")
    lines = [r.getMessage() for r in caplog.records if r.name == "tanbala_leads.web.console"]
    assert lines == [f"Консоль: approve, письмо {draft_id}, пользователь {USER}: ok"]
    assert "Инвентаризация" not in caplog.text and "@" not in lines[0]
    assert all(c.closed for c in opened)


def test_approve_and_reject_refusals(console_db):
    conn, _, _ = console_db
    company_id, _, draft_id = full_company(conn)
    client = client_for(console_db)

    assert problem(post(client, "/drafts/999999/approve"), 404, "not_found") == "Письмо не найдено."
    assert problem(post(client, "/drafts/9223372036854775808/approve"), 404, "not_found")
    contact_policy.block_company(conn, company_id)
    assert problem(post(client, f"/drafts/{draft_id}/approve"), 409, "conflict") == (
        "Компания в списке «не писать»: письмо нельзя одобрить.")
    assert ok(post(client, f"/drafts/{draft_id}/reject")) == {"result": "rejected"}
    assert draft_row(conn, draft_id) == ("rejected", None, "verified")
    for action in ("approve", "reject"):
        assert problem(post(client, f"/drafts/{draft_id}/{action}"), 409, "conflict") == (
            "Письмо уже отклонено. Новый черновик напишет следующий запуск.")


def test_console_does_not_reapprove_but_old_button_still_can(console_db):
    """Повтор из консоли не перезаписывает, кто одобрил; старая форма ведёт себя как раньше."""
    conn, connect, _ = console_db
    _, _, draft_id = full_company(conn)
    client = client_for(console_db)

    assert ok(post(client, f"/drafts/{draft_id}/approve")) == {"result": "approved"}
    again = post(client, f"/drafts/{draft_id}/approve", headers={"X-Console-User": "other"})

    assert problem(again, 409, "conflict") == "Письмо уже одобрено."
    assert draft_row(conn, draft_id) == ("approved", USER, "approved")
    page = make_client(connect).post(f"/drafts/{draft_id}/approve", data={"csrf_token": "csrf"},
                                     follow_redirects=False)
    assert page.status_code == 303 and draft_row(conn, draft_id)[1] == "владелец"


def test_sent_draft_cannot_be_rejected(console_db):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    conn.execute("UPDATE drafts SET review_status = 'approved', approved_by = 'x', approved_at = now(),"
                 " sent_at = now() WHERE id = %s", (draft_id,))

    assert problem(post(client_for(console_db), f"/drafts/{draft_id}/reject"), 409, "conflict") == (
        "Письмо уже отправлено или отклонено.")


def test_whatsapp_trigger_gives_clear_409_in_console_and_old_text_in_html(console_db):
    """Триггер drafts_forbid_whatsapp: консоль говорит, почему; старый интерфейс отвечает как раньше."""
    conn, connect, _ = console_db
    company_id, _, draft_id = full_company(conn)
    conn.execute("UPDATE companies SET requested_via = 'whatsapp' WHERE id = %s", (company_id,))

    assert problem(post(client_for(console_db), f"/drafts/{draft_id}/approve"), 409, "conflict") == WHATSAPP_MESSAGE
    page = make_client(connect).post(f"/drafts/{draft_id}/approve", data={"csrf_token": "csrf"})
    assert page.status_code == 409 and "У компании уже есть другое активное письмо." in page.text
    assert draft_row(conn, draft_id)[0] == "pending"


def test_same_rules_as_html_buttons(console_db):
    """Старая кнопка и API дают тот же исход: «не писать» и отклонённое письмо одинаково запрещены."""
    conn, connect, _ = console_db
    html = make_client(connect)
    blocked_company, _, blocked_draft = full_company(conn, "ТОО «Закрыта»")
    contact_policy.block_company(conn, blocked_company)
    _, _, rejected_draft = full_company(conn, "ТОО «Отклонена»")
    conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (rejected_draft,))
    client = client_for(console_db)

    for draft_id in (blocked_draft, rejected_draft):
        page = html.post(f"/drafts/{draft_id}/approve", data={"csrf_token": "csrf"})
        api = post(client, f"/drafts/{draft_id}/approve")
        assert page.status_code == api.status_code == 409
        assert api.json()["message"] in page.text


# ---------- изменить ----------


def test_edit_reruns_checks_and_drops_approval(console_db, monkeypatch):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    conn.execute("UPDATE drafts SET review_status = 'approved', approved_by = 'x', approved_at = now()"
                 " WHERE id = %s", (draft_id,))
    seen = []

    def fake_checks(subject, body):
        seen.append((subject, body))
        return [{"name": "dashes", "passed": False, "details": ["тире"]}, {"name": "style", "passed": True,
                                                                           "details": []}]

    monkeypatch.setattr(approve_step, "check_results_json", fake_checks)

    response = post(client_for(console_db), f"/drafts/{draft_id}/edit",
                    {"subject": "  Новая   тема ", "body": "Здравствуйте!\r\n\r\nНовый текст.\r\n"})

    assert ok(response) == {"result": "saved", "checksTotal": 2, "checksFailed": 1}
    assert seen == [("Новая тема", "Здравствуйте!\n\nНовый текст.")]
    assert conn.execute("SELECT subject, review_status, approved_by FROM drafts WHERE id = %s",
                        (draft_id,)).fetchone() == ("Новая тема", "pending", None)


def test_edit_of_longest_cyrillic_letter_is_saved(console_db, monkeypatch):
    """10 000 символов кириллицы — больше 16 КБ в UTF-8: у правки свой предел 32 КБ."""
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    monkeypatch.setattr(approve_step, "check_results_json", lambda subject, body: [])
    body = "Здравствуйте!\n" + "я" * (10_000 - len("Здравствуйте!\n"))

    response = post(client_for(console_db), f"/drafts/{draft_id}/edit", {"subject": "т" * 200, "body": body})

    assert ok(response) == {"result": "saved", "checksTotal": 0, "checksFailed": 0}
    assert conn.execute("SELECT length(body) FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0] == 10_000


@pytest.mark.parametrize(("subject", "body", "message"), [
    ("   ", "Текст", "Тема и текст письма не должны быть пустыми."),
    ("Тема", "\n\n", "Тема и текст письма не должны быть пустыми."),
    ("я" * 201, "Текст", "Тема до 200 символов, текст до 10 000 символов."),
])
def test_bad_edit_is_422_without_checks(console_db, monkeypatch, subject, body, message):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    monkeypatch.setattr(approve_step, "check_results_json", lambda s, b: pytest.fail("проверки не нужны"))

    response = post(client_for(console_db), f"/drafts/{draft_id}/edit", {"subject": subject, "body": body})

    assert problem(response, 422, "refused") == message
    assert conn.execute("SELECT subject FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0] == "Инвентаризация за часы"


def test_edit_of_rejected_or_missing_letter(console_db, monkeypatch):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (draft_id,))
    monkeypatch.setattr(approve_step, "check_results_json", lambda s, b: [])
    client = client_for(console_db)

    assert problem(post(client, f"/drafts/{draft_id}/edit", {"subject": "Т", "body": "Т"}), 409, "conflict")
    assert problem(post(client, "/drafts/999999/edit", {"subject": "Т", "body": "Т"}), 404, "not_found")


# ---------- тестовая отправка ----------


def test_send_test_goes_only_to_owner(console_db):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    sender = FakeSender()

    data = ok(post(client_for(console_db, send_test=sender, test_address=TEST_TO), f"/drafts/{draft_id}/send-test"))

    assert data["result"] == "sent" and data["sentTo"] == TEST_TO and data["at"].endswith("+00:00")
    assert sender.calls == [draft_id]
    assert conn.execute("SELECT review_status, sent_at FROM drafts WHERE id = %s", (draft_id,)).fetchone() == (
        "pending", None)
    assert conn.execute("SELECT count(*) FROM contact_history").fetchone()[0] == 0


@pytest.mark.parametrize(("error", "status", "code"), [
    (send_step.SendLimitReached("Дневной лимит тестовых отправок 30 исчерпан"), 429, "test_limit"),
    (send_step.SendBlocked("DRY_RUN_TO должен быть bogdansm2000@gmail.com, сейчас «x@y.kz»"), 409, "conflict"),
    (send_step.SendFailed("Почтовый сервер не принял письмо (SMTP: SMTPAuthenticationError)"), 502, "send_failed"),
    (SettingsError("Не задана переменная SMTP_PASSWORD. Заполните её в .env"), 503, "not_configured"),
    (SettingsError("SMTP_PORT должен быть числом, например 465. Исправьте его в .env."), 503, "not_configured"),
])
def test_send_test_errors(console_db, error, status, code):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)

    response = post(client_for(console_db, send_test=FakeSender(error), test_address=TEST_TO),
                    f"/drafts/{draft_id}/send-test")

    message = problem(response, status, code)
    if code == "not_configured":
        assert "SMTP_HOST" in message and str(error) not in response.text
    else:
        assert message == str(error)


def test_other_send_error_is_500_without_text(console_db):
    """Не ошибка настроек (например, перевод строки в теме): 500 internal, а не «проверьте SMTP»."""
    conn, connect, _ = console_db
    _, _, draft_id = full_company(conn)
    client = make_client(connect, send_test=FakeSender(ValueError("Header values may not contain linefeed")),
                         test_address=TEST_TO, raise_server_exceptions=False)

    response = post(client, f"/drafts/{draft_id}/send-test")

    assert problem(response, 500, "internal") and "linefeed" not in response.text


def test_html_keeps_409_for_test_limit(console_db):
    conn, connect, _ = console_db
    _, _, draft_id = full_company(conn)
    sender = FakeSender(send_step.SendLimitReached("Дневной лимит тестовых отправок 30 исчерпан"))

    page = make_client(connect, send_test=sender, test_address=TEST_TO).post(f"/drafts/{draft_id}/send-test",
                                                                             data={"csrf_token": "csrf"})

    assert page.status_code == 409 and "Дневной лимит тестовых отправок 30 исчерпан" in page.text


def test_send_test_refused_when_off_rejected_or_missing(console_db):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    sender = FakeSender()

    assert problem(post(client_for(console_db), f"/drafts/{draft_id}/send-test"), 409, "conflict") == (
        "Тестовая отправка выключена: DRY_RUN_TO не настроен.")
    stranger = client_for(console_db, send_test=sender, test_address="boss@company.kz")
    assert problem(post(stranger, f"/drafts/{draft_id}/send-test"), 409, "conflict")
    conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (draft_id,))
    client = client_for(console_db, send_test=sender, test_address=TEST_TO)
    assert problem(post(client, f"/drafts/{draft_id}/send-test"), 409, "conflict") == (
        "Отклонённое письмо не отправляется даже в тест.")
    assert problem(post(client, "/drafts/999999/send-test"), 404, "not_found")
    assert sender.calls == []


# ---------- компании ----------


def test_block_company_like_the_button(console_db):
    conn, _, _ = console_db
    company_id, _, draft_id = full_company(conn)
    conn.execute("UPDATE companies SET website_domain = 'step.example.kz' WHERE id = %s", (company_id,))
    client = client_for(console_db)

    assert ok(post(client, f"/companies/{company_id}/block")) == {"result": "blocked"}
    assert ok(post(client, f"/companies/{company_id}/block")) == {"result": "blocked"}  # повтор безопасен
    targets = conn.execute("SELECT company_id, domain, email, reason, note FROM do_not_contact ORDER BY id").fetchall()
    assert targets == [(company_id, None, None, "manual", "кнопка «Больше не писать»"),
                       (None, "step.example.kz", None, "manual", "кнопка «Больше не писать»"),
                       (None, None, f"info@c{company_id}.example.kz", "manual", "кнопка «Больше не писать»")]
    assert ok(get(client, f"/letters/{draft_id}"))["approveBlocked"] is True
    assert problem(post(client, "/companies/999999/block"), 404, "not_found") == "Компания не найдена."


def test_clear_whatsapp_marks(console_db, caplog):
    conn, _, _ = console_db
    caplog.set_level(logging.INFO, logger="tanbala_leads")
    company_id = seed_company(conn, "ТОО «Рахат»", status="qualified", requested_via="whatsapp")
    conn.execute("UPDATE companies SET whatsapp_contacted_at = now() WHERE id = %s", (company_id,))
    contacted_only = seed_company(conn, "ТОО «Писал»", status="new")
    conn.execute("UPDATE companies SET whatsapp_contacted_at = now() WHERE id = %s", (contacted_only,))
    client = client_for(console_db)

    assert ok(post(client, f"/companies/{company_id}/whatsapp-clear")) == {"result": "cleared",
                                                                         "wasRequestedVia": "whatsapp"}
    assert ok(post(client, f"/companies/{contacted_only}/whatsapp-clear")) == {"result": "cleared",
                                                                             "wasRequestedVia": None}
    assert conn.execute("SELECT count(*) FROM companies WHERE requested_via IS NOT NULL"
                        " OR whatsapp_contacted_at IS NOT NULL").fetchone()[0] == 0
    assert f"Консоль: whatsapp_clear, компания {company_id}, пользователь {USER}: ok" in caplog.text
    assert problem(post(client, "/companies/999999/whatsapp-clear"), 404, "not_found")


# ---------- поиск ----------


def test_start_search_202_with_run_id(console_db):
    start_run = FakeStartRun(result=42)

    response = post(client_for(console_db, start_run=start_run), "/runs",
                    {"query": "  оборотная тара ", "city": "almaty", "count": 5})

    assert (response.status_code, response.json()) == (202, {"runId": 42})
    assert start_run.calls == [("almaty", "оборотная тара", 5)]


def test_start_search_conflict_names_active_run(console_db):
    conn, _, _ = console_db
    active = seed_run(conn, status="running", stage="collect")
    start_run = FakeStartRun(error=pipeline.RunAlreadyActive("Уже идёт другой запуск, дождитесь его окончания"))

    response = post(client_for(console_db, start_run=start_run), "/runs", {"query": "склад", "city": "almaty",
                                                                           "count": 5})

    assert problem(response, 409, "conflict") == f"Идёт запуск №{active}. Новый можно начать, когда он закончится."
    assert response.json()["activeRunId"] == active


@pytest.mark.parametrize(("body", "status", "code", "text"), [
    ({"query": "склад", "city": "almaty", "count": "5"}, 400, "bad_request", "Число компаний должно быть от 1 до 20"),
    ({"query": "склад", "city": "almaty", "count": True}, 400, "bad_request", "Число компаний должно быть от 1 до 20"),
    ({"query": "склад", "city": "almaty"}, 400, "bad_request", "Число компаний должно быть от 1 до 20"),
    ({"query": "склад", "city": "almaty", "count": 21}, 400, "bad_request", "от 1 до 20"),
    ({"query": "склад", "city": "moscow", "count": 5}, 400, "bad_request", "Неизвестный город"),
    ({"query": " , ", "city": "almaty", "count": 5}, 400, "bad_request", "Напишите, что искать"),
    ({"query": "склад, тара, обувь, мебель", "city": "almaty", "count": 20}, 400, "bad_request", "не больше 60"),
])
def test_start_search_uses_real_create_run_checks(console_db, monkeypatch, body, status, code, text):
    """Настоящий pipeline.create_run во временной схеме, без потока: те же проверки, что у кнопки."""
    conn, connect, _ = console_db

    def start_run(city, query, count):
        with connect() as run_conn:
            return pipeline.create_run(run_conn, city, query, count, daily_budget_usd=1.0)

    response = post(make_client(connect, start_run=start_run), "/runs", body)

    assert text in problem(response, status, code)
    assert conn.execute("SELECT count(*) FROM runs").fetchone()[0] == 0


def test_start_search_budget_exhausted_is_429(console_db):
    conn, connect, _ = console_db
    conn.execute("INSERT INTO llm_calls (task, model, input_tokens, output_tokens) VALUES"
                 " ('qualify', 'claude-haiku-5-5', 20000000, 0)")

    def start_run(city, query, count):
        with connect() as run_conn:
            return pipeline.create_run(run_conn, city, query, count, daily_budget_usd=1.0)

    response = post(make_client(connect, start_run=start_run), "/runs", {"query": "склад", "city": "almaty",
                                                                         "count": 5})

    assert "Дневной лимит расходов на API $1.00 исчерпан" in problem(response, 429, "budget_exhausted")
    html = make_client(connect, start_run=start_run).post(
        "/runs", data={"csrf_token": "csrf", "city": "almaty", "query": "склад", "max_companies": "5"})
    assert html.status_code == 400  # старый интерфейс: как раньше


def test_start_search_conflict_with_real_unique_index(console_db):
    conn, connect, _ = console_db

    def start_run(city, query, count):
        with connect() as run_conn:
            return pipeline.create_run(run_conn, city, query, count)

    client = make_client(connect, start_run=start_run)
    first = post(client, "/runs", {"query": "склад", "city": "almaty", "count": 1})
    second = post(client, "/runs", {"query": "тара", "city": "almaty", "count": 1})

    assert first.status_code == 202
    assert problem(second, 409, "conflict").startswith(f"Идёт запуск №{first.json()['runId']}.")


# ---------- кому писали ----------


def test_import_written_text_and_refused_file(console_db):
    conn, _, _ = console_db
    company_id, _, _ = full_company(conn)
    client = client_for(console_db)

    written = ok(post(client, "/history/import", {"kind": "written",
                                                  "text": f"info@c{company_id}.example.kz\nold@client.kz\nне адрес"}))
    assert written == {"added": 2, "existing": 0, "invalid": ["не адрес"], "invalidMore": 0}
    again = ok(post(client, "/history/import", {"kind": "written", "text": "old@client.kz"}))
    assert (again["added"], again["existing"]) == (0, 1)

    csv = "email;имя\n\"spam@x.kz\";Спам\nbad.example.kz;домен\ngmail.com;бесплатная\n".encode()
    refused = ok(post(client, "/history/import", {"kind": "refused", "fileBase64": base64.b64encode(csv).decode()}))
    assert refused == {"added": 2, "existing": 0, "invalid": ["gmail.com"], "invalidMore": 0}
    assert conn.execute("SELECT email, domain, reason FROM do_not_contact ORDER BY id").fetchall() == [
        ("spam@x.kz", None, "refused"), (None, "x.kz", "refused"), (None, "bad.example.kz", "refused")]
    both = ok(post(client, "/history/import", {"kind": "refused", "text": "a.example.kz",
                                               "fileBase64": base64.b64encode(b"b.example.kz").decode()}))
    assert both["added"] == 2


def test_import_shows_twenty_invalid_lines_and_the_rest_as_count(console_db):
    lines = "\n".join(f"строка без адреса {index} " + "я" * 120 for index in range(25))

    data = ok(post(client_for(console_db), "/history/import", {"kind": "written", "text": lines}))

    assert (data["added"], len(data["invalid"]), data["invalidMore"]) == (0, 20, 5)
    assert all(len(item) <= 100 for item in data["invalid"])


@pytest.mark.parametrize(("body", "text"), [
    ({"kind": "refused", "fileBase64": base64.b64encode("тара.kz".encode("cp1251")).decode()}, "не в кодировке UTF-8"),
    ({"kind": "refused", "fileBase64": base64.b64encode(b"a.kz\n" * 220_000).decode()}, "Файл больше 1 МБ"),
    ({"kind": "refused", "text": "  \n"}, "Список пуст"),
    ({"kind": "refused"}, "Список пуст"),
    ({"kind": "all", "text": "a.kz"}, "Неизвестный список."),
    ({"kind": "written", "text": "\n".join(f"u{i}@x.kz" for i in range(20_001))}, "Слишком много строк"),
])
def test_import_refusals(console_db, body, text):
    conn, _, _ = console_db

    assert text in problem(post(client_for(console_db), "/history/import", body), 400, "bad_request")
    assert conn.execute("SELECT count(*) FROM do_not_contact").fetchone()[0] == 0


def test_actions_log_one_line_without_texts_or_addresses(console_db, caplog):
    conn, _, _ = console_db
    caplog.set_level(logging.INFO, logger="tanbala_leads")
    _, _, draft_id = full_company(conn)
    client = client_for(console_db)

    post(client, "/history/import", {"kind": "refused", "text": "secret-client@rahat.kz"})
    post(client, f"/drafts/{draft_id}/approve", headers={"X-Console-User": "boss"})

    lines = [r.getMessage() for r in caplog.records if r.name == "tanbala_leads.web.console"]
    assert lines == [f"Консоль: import, список refused, пользователь {USER}: ok, добавлено 1, уже были 0,"
                     " не распознано 0",
                     f"Консоль: approve, письмо {draft_id}, пользователь boss: ok"]
    assert "rahat" not in caplog.text


def test_user_header_is_checked_on_every_action(console_db):
    conn, _, _ = console_db
    _, _, draft_id = full_company(conn)
    client = client_for(console_db)

    response = client.post(PREFIX + f"/drafts/{draft_id}/approve", headers={**POST, "X-Console-User": "Boss"},
                           json={})

    assert problem(response, 400, "bad_request")
    assert draft_row(conn, draft_id)[0] == "pending"


def test_new_draft_after_rejected_one_can_be_approved(console_db):
    """Ядро не изменилось: после отклонённого письма новое письмо той же компании одобряется."""
    conn, _, _ = console_db
    company_id, contact_id, draft_id = full_company(conn)
    conn.execute("UPDATE drafts SET review_status = 'rejected' WHERE id = %s", (draft_id,))
    second = seed_draft(conn, company_id, seed_contact(conn, company_id, "second@c.example.kz"))

    assert ok(post(client_for(console_db), f"/drafts/{second}/approve")) == {"result": "approved"}
    assert draft_row(conn, second) == ("approved", USER, "approved")
