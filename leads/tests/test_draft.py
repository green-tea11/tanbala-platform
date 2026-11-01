import json
from types import SimpleNamespace

import pytest

from tanbala_leads import checks, db
from tanbala_leads.settings import SettingsError, load_settings
from tanbala_leads.steps import draft

SETTINGS = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+77479597238"})

# Письмо по образцу владельца 01.11.2026: без тире, двоеточий и точек с запятой, номер группами через пробел.
CLEAN_BODY = (
    "Здравствуйте!\n\n"
    "Меня зовут Арман, я представляю Tanbala. Мы внедряем складской учёт на основе RFID-меток под ключ, "
    "от подбора оборудования до интеграции с 1С и обучения сотрудников.\n\n"
    "Если пересчёт контейнеров занимает несколько дней, RFID помогает ускорить его и упростить контроль.\n\n"
    "Как это работает? На каждый контейнер наносится метка. Ручной считыватель распознаёт много меток "
    "одновременно. Сотрудник проходит вдоль площадки, и система сверяет данные с учётом в 1С.\n\n"
    "Мы берём на себя весь процесс. Подбираем оборудование, тестируем его на вашем складе, настраиваем обмен "
    "данными с 1С и обучаем команду.\n\n"
    "Напишите нам в WhatsApp по номеру +7 747 959 72 38. Расскажите, что вы храните и как сейчас считаете "
    "остатки, и мы предложим решение под ваши задачи."
)
CLEAN = {"subject": "Учёт склада без ручного пересчёта", "body": CLEAN_BODY, "notes": []}
WITH_DASH = {**CLEAN, "body": CLEAN_BODY.replace("под ключ,", "под ключ —"), "notes": ["Проверить склад"]}
WITH_COLON = {**CLEAN, "body": CLEAN_BODY.replace("в WhatsApp по номеру", "в WhatsApp:")}
OLD_FORMAT = {**CLEAN, "body": CLEAN_BODY + "\n\nАрман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238"}


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


def test_signature_is_sign_off_and_name_from_settings():
    assert draft.build_signature(SETTINGS) == "С уважением,\nАрман"
    other = load_settings({"AGENT_NAME": "Айгерим", "AGENT_WHATSAPP": "+77001234567"})
    assert draft.build_signature(other) == "С уважением,\nАйгерим"


def test_signature_has_no_company_line_or_number_and_passes_check():
    signature = draft.build_signature(SETTINGS)

    assert "VenMart" not in signature and "WhatsApp" not in signature and "747" not in signature
    assert checks.check_signature(f"Здравствуйте!\n\nТекст письма.\n\n{signature}").passed


@pytest.mark.parametrize("number", ["+77479597238", "8 747 959 72 38", "+7 (747) 959-72-38"])
def test_letter_number_is_grouped_with_spaces(number):
    settings = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": number})

    assert draft.letter_whatsapp(settings) == "+7 747 959 72 38"


@pytest.mark.parametrize("number", ["", "+7 747 959", "+1 202 555 0100"])
def test_bad_letter_number_is_a_settings_error(number):
    settings = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": number})

    with pytest.raises(SettingsError, match="AGENT_WHATSAPP"):
        draft.letter_whatsapp(settings)


def test_instructions_follow_owner_format():
    text = draft.INSTRUCTIONS.format(name="Арман", whatsapp="+7 747 959 72 38")

    for part in ("«Здравствуйте!»", "«Меня зовут Арман, я представляю Tanbala.»", "«Как это работает?»",
                 "«Мы берём на себя весь процесс.»", "«Напишите нам в WhatsApp по номеру +7 747 959 72 38.»",
                 "«С уважением,»", "двоеточия и точки с запятой", "8–13"):
        assert part in text
    assert "двоеточие)" not in text and "я из Tanbala" not in text


def test_instructions_ask_for_stationary_antennas():
    # Просьба владельца 02.11.2026: в письме сказать, что приход и уход учитываются сами, антеннами на входе и выходе.
    text = draft.INSTRUCTIONS.format(name="Арман", whatsapp="+7 747 959 72 38")

    assert "стационарные антенны на входе и выходе" in text
    assert "что пришло на склад и что ушло" in text


def test_compose_puts_notes_on_top_and_signature_at_bottom():
    body = draft.compose_body({**CLEAN, "notes": ["нет данных о складе ]"]}, "Подпись")

    assert body.startswith("[Проверить: нет данных о складе )]\n")
    assert body.endswith("\n\nПодпись")


def test_multiline_note_stays_on_one_line_and_out_of_letter():
    answer = {**CLEAN, "notes": ["склад свой\nили арендный: уточнить"]}

    body = draft.compose_body(answer, draft.build_signature(SETTINGS))

    assert body.startswith("[Проверить: склад свой или арендный: уточнить]\nЗдравствуйте!")
    assert all(result.passed for result in checks.run_all(CLEAN["subject"], body, whatsapp="+77479597238"))


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
    assert body == CLEAN_BODY + "\n\nС уважением,\nАрман"
    assert all(item["passed"] for item in checks)
    assert {item["name"] for item in checks} >= {"dashes", "colons", "semicolons", "signature", "contacts"}
    assert len(client.calls) == 1
    assert db_conn.execute("SELECT status FROM companies").fetchone()[0] == "drafted"


@pytest.mark.db
def test_prompt_gives_name_and_number_with_spaces(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(CLEAN)

    draft.draft_first_email(db_conn, company, client=client, owner_doc="Документ", settings=SETTINGS)

    instructions = client.calls[0]["system"][-1]["text"]
    assert "«Меня зовут Арман, я представляю Tanbala.»" in instructions
    assert "по номеру +7 747 959 72 38" in instructions and "+77479597238" not in instructions


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
def test_colon_in_draft_gets_retry_and_is_fixed(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(WITH_COLON, CLEAN)

    draft_id = draft.draft_first_email(db_conn, company, client=client, owner_doc="Документ", settings=SETTINGS)

    problems = client.calls[1]["messages"][0]["content"].split("<problems>", 1)[1]
    assert "colons" in problems and "двоеточие" in problems and "WhatsApp: +7 747" in problems
    body, results = db_conn.execute("SELECT body, check_result FROM drafts WHERE id = %s", (draft_id,)).fetchone()
    assert "WhatsApp:" not in body and all(item["passed"] for item in results)


@pytest.mark.db
def test_old_signature_from_model_fails_checks_and_is_kept_if_retry_is_no_better(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(OLD_FORMAT, OLD_FORMAT)

    draft_id = draft.draft_first_email(db_conn, company, client=client, owner_doc="Документ", settings=SETTINGS)

    assert len(client.calls) == 2
    problems = client.calls[1]["messages"][0]["content"].split("<problems>", 1)[1]
    assert "signature" in problems and "colons" in problems and "contacts" in problems
    results = db_conn.execute("SELECT check_result FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0]
    assert {item["name"] for item in results if not item["passed"]} == {"colons", "signature", "contacts"}


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


@pytest.mark.db
def test_failed_retry_keeps_first_paid_draft(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(WITH_DASH, {"subject": "", "body": "", "notes": []})

    draft_id = draft.draft_first_email(db_conn, company, client=client, owner_doc="Д", settings=SETTINGS)

    body = db_conn.execute("SELECT body FROM drafts WHERE id = %s", (draft_id,)).fetchone()[0]
    assert "—" in body


@pytest.mark.db
def test_missing_signature_settings_stop_before_paid_call(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(CLEAN)

    with pytest.raises(Exception, match="AGENT_NAME"):
        draft.draft_first_email(db_conn, company, client=client, owner_doc="Д", settings=load_settings({}))
    assert client.calls == []


@pytest.mark.db
def test_bad_whatsapp_number_stops_before_paid_call(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    client = fake_client(CLEAN)
    settings = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+7 747 959"})

    with pytest.raises(SettingsError, match="AGENT_WHATSAPP"):
        draft.draft_first_email(db_conn, company, client=client, owner_doc="Д", settings=settings)
    assert client.calls == []


@pytest.mark.db
def test_letter_is_built_around_verified_pain_only(db_conn, company):
    add_contact(db_conn, company, "info@pel.kz", "safe")
    db_conn.execute(
        "UPDATE qualifications SET pains = %s",
        ('[{"pain": "Инвентаризация занимает дни и отрывает людей", "evidence": "инвентаризация раз в квартал",'
         ' "source": "site", "verified": true},'
         ' {"pain": "Вещи теряются, никто не знает, где они", "evidence": "выдумка модели",'
         ' "source": "site", "verified": false}]',),
    )
    client = fake_client(CLEAN)

    draft.draft_first_email(db_conn, company, client=client, owner_doc="Д", settings=SETTINGS)

    content = client.calls[0]["messages"][0]["content"]
    assert "Инвентаризация занимает дни" in content and "инвентаризация раз в квартал" in content
    assert "Вещи теряются" not in content and "выдумка модели" not in content


def test_letter_is_built_around_two_pains_even_if_three_are_verified():
    """Квалификация хранит до трёх болей для справки WhatsApp-бота, письмо по-прежнему строится вокруг двух."""
    pains = [{"pain": f"Боль {number}", "evidence": f"цитата номер {number}", "source": "site", "verified": True}
             for number in (1, 2, 3)]

    block = draft.qualification_block({"segment": "Склад, логистика, дистрибуция", "reason": "Склад.", "pains": pains})

    assert "Главная боль: Боль 1" in block and "Ещё боль: Боль 2" in block
    assert "Боль 3" not in block and "цитата номер 3" not in block
