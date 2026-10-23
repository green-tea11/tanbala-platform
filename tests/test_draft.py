import json
from types import SimpleNamespace

import pytest

from tanbala_leads import db
from tanbala_leads.settings import load_settings
from tanbala_leads.steps import draft

SETTINGS = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+77479597238"})

CLEAN_BODY = (
    "Здравствуйте!\n\n"
    "Меня зовут Арман, я из Tanbala. Мы ставим учёт вещей на RFID-метках под ключ.\n\n"
    "На каждый контейнер клеится метка. Ридер видит сотни меток за секунду, и всё сразу попадает в 1С. "
    "Пересчёт идёт обходом со сканером.\n\n"
    "Всё делаем сами: подбираем оборудование, проводим тесты, связываем с вашей 1С и обучаем сотрудников.\n\n"
    "Если пересчёт у вас занимает много времени, напишите нам в WhatsApp: +77479597238. "
    "Расскажите в двух словах о задаче."
)
CLEAN = {"subject": "Учёт склада без ручного пересчёта", "body": CLEAN_BODY, "notes": []}
WITH_DASH = {**CLEAN, "body": CLEAN_BODY.replace("под ключ.", "под ключ — быстро."), "notes": ["Проверить склад"]}


def fake_client(*answers: dict):
    queue = list(answers)
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        usage = SimpleNamespace(input_tokens=900, output_tokens=400, cache_read_input_tokens=9000,
                                cache_creation_input_tokens=0)
        text = json.dumps(queue.pop(0), ensure_ascii=False)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason="end_turn",
                               usage=usage, model="claude-haiku-5-5")

    return SimpleNamespace(messages=SimpleNamespace(create=create), calls=calls)


def test_signature_comes_from_settings():
    assert draft.build_signature(SETTINGS) == "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238"


def test_compose_puts_notes_on_top_and_signature_at_bottom():
    body = draft.compose_body({**CLEAN, "notes": ["нет данных о складе ]"]}, "Подпись")

    assert body.startswith("[Проверить: нет данных о складе )]\n")
    assert body.endswith("\n\nПодпись")


@pytest.fixture
def company(db_conn):
    db.migrate(db_conn)
    company_id = db_conn.execute(
        "INSERT INTO companies (name, rubric, status) VALUES ('Asklad', 'Складское хранение', 'verified') RETURNING id"
    ).fetchone()[0]
    db_conn.execute(
        "INSERT INTO qualifications (company_id, fit, score, reason, segment, model)"
        " VALUES (%s, 'yes', 80, 'Склад в трёх филиалах', 'Склад, логистика, дистрибуция', 'm')", (company_id,)
    )
    return company_id


def add_contact(conn, company_id, email, result, source="2gis"):
    conn.execute("INSERT INTO contacts (company_id, email, verify_result, source_page) VALUES (%s, %s, %s, %s)",
                 (company_id, email, result, source))


@pytest.mark.db
def test_choose_contact_prefers_safe_and_skips_invalid(db_conn, company):
    add_contact(db_conn, company, "bad@pel.kz", "invalid")
    add_contact(db_conn, company, "info@pel.kz", "unknown")
    add_contact(db_conn, company, "sales@pel.kz", "safe", source="https://pel.kz/contacts")

    assert draft.choose_contact(db_conn, company)[1] == "sales@pel.kz"


@pytest.mark.db
def test_choose_contact_respects_do_not_contact(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    db_conn.execute("INSERT INTO do_not_contact (domain, reason) VALUES ('pel.kz', 'refused')")

    assert draft.choose_contact(db_conn, company) is None


@pytest.mark.db
def test_clean_draft_is_saved_with_passing_checks(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(CLEAN)

    draft_id = draft.draft_first_email(db_conn, company, client=client, owner_doc="Документ", settings=SETTINGS)

    subject, body, checks = db_conn.execute("SELECT subject, body, check_result FROM drafts WHERE id = %s",
                                            (draft_id,)).fetchone()
    assert subject == CLEAN["subject"]
    assert body.endswith("WhatsApp: +77479597238")
    assert all(item["passed"] for item in checks)
    assert len(client.calls) == 1
    assert db_conn.execute("SELECT status FROM companies").fetchone()[0] == "drafted"


@pytest.mark.db
def test_failed_checks_get_one_retry_with_problems(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(WITH_DASH, CLEAN)

    draft_id = draft.draft_first_email(db_conn, company, client=client, owner_doc="Документ", settings=SETTINGS)

    assert len(client.calls) == 2
    assert "тире" in client.calls[1]["messages"][0]["content"]
    body = db_conn.execute("SELECT body FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0]
    assert "—" not in body


@pytest.mark.db
def test_existing_draft_is_not_written_again(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    first = draft.draft_first_email(db_conn, company, client=fake_client(CLEAN), owner_doc="Д", settings=SETTINGS)
    client = fake_client(CLEAN)

    second = draft.draft_first_email(db_conn, company, client=client, owner_doc="Д", settings=SETTINGS)

    assert second == first
    assert client.calls == []


@pytest.mark.db
def test_no_usable_contact_is_an_error(db_conn, company):
    add_contact(db_conn, company, "bad@pel.kz", "invalid")

    with pytest.raises(draft.NoUsableContact):
        draft.draft_first_email(db_conn, company, client=fake_client(CLEAN), owner_doc="Д", settings=SETTINGS)
