"""Тесты проверок письма кодом (tanbala_leads/checks.py). Правила: knowledge/tanbala-agent.md."""

import re
from pathlib import Path

import pytest

from tanbala_leads import checks
from tanbala_leads.checks import (
    check_colons,
    check_contacts,
    check_dashes,
    check_jargon,
    check_length,
    check_links,
    check_notes,
    check_prices,
    check_semicolons,
    check_signature,
    check_stop_words,
    check_style,
    format_whatsapp,
    run_all,
)

KNOWLEDGE = Path(__file__).resolve().parents[1] / "knowledge" / "tanbala-agent.md"
SIGNATURE = "С уважением,\nАрман"
SUBJECT = "Учёт склада без ручного пересчёта"
OWN_WHATSAPP = "+77479597238"
SPACED_WHATSAPP = "+7 747 959 72 38"

# Нейтральные предложения по образцу владельца: 8 штук (меньше нельзя), без запрещённого
NEUTRAL = (
    "Меня зовут Арман, я представляю Tanbala.",
    "Мы внедряем учёт вещей на основе RFID-меток под ключ.",
    "Если инвентаризация занимает дни, RFID помогает ускорить пересчёт.",
    "Как это работает?",
    "Ридер видит сотни меток за секунду.",
    "Мы берём на себя весь процесс.",
    "Всё попадает в 1С.",
    f"Напишите нам в WhatsApp по номеру {SPACED_WHATSAPP}.",
)


def make_body(*sentences: str, notes: str = "", signature: str = SIGNATURE) -> str:
    """Собрать черновик: [заметки], приветствие, абзац, подпись."""
    head = f"{notes}\n" if notes else ""
    return f"{head}Здравствуйте!\n\n{' '.join(sentences)}\n\n{signature}"


GOOD_BODY = make_body(*NEUTRAL)

# Образец владельца 01.11.2026 как он прислан: с тире, двоеточием и строкой о VenMart.
OWNER_SAMPLE = (
    "Здравствуйте!\n\n"
    "Меня зовут Арман, я представляю Tanbala — направление ТОО «VenMart». Мы внедряем складской учёт на основе "
    "RFID-меток под ключ: от подбора оборудования до интеграции с 1С и обучения сотрудников.\n\n"
    "Если остатки в 1С не совпадают с фактическими, а инвентаризация занимает несколько дней, RFID помогает "
    "ускорить пересчёт и упростить контроль товаров.\n\n"
    "Как это работает? На товары, коробки или паллеты наносятся электронные метки. Ручной считыватель распознаёт "
    "множество меток одновременно — без необходимости сканировать каждую отдельно. Сотрудник проходит вдоль полок, "
    "система фиксирует товары и сверяет полученные данные с учётом в 1С.\n\n"
    "Мы берём на себя весь процесс: подбираем оборудование, тестируем его на вашем складе, настраиваем обмен "
    "данными с 1С и обучаем команду.\n\n"
    "Напишите нам в WhatsApp: +7 747 959 72 38. Расскажите, какие товары вы храните и как сейчас проводите "
    "инвентаризацию, — мы предложим решение под ваши задачи.\n\n"
    "С уважением,\nАрман"
)


def document_examples() -> dict[str, tuple[str, str]]:
    """Примеры писем раздела 8 документа: [имя] -> Арман, [номер] -> номер с пробелами, [подпись] -> подпись."""
    text = KNOWLEDGE.read_text(encoding="utf-8")
    examples = {}
    for title, block in re.findall(r"^### (Пример \d+: .+)\n\n((?:>.*\n)+)", text, re.MULTILINE):
        lines = [line.removeprefix(">").removeprefix(" ") for line in block.splitlines()]
        subject = lines[0].removeprefix("**Тема:** ")
        body = "\n".join(lines[1:]).strip()
        body = body.replace("[имя]", "Арман").replace("[номер]", SPACED_WHATSAPP).replace("[подпись]", SIGNATURE)
        examples[title] = (subject, body)
    return examples


EXAMPLE_LETTERS = document_examples()


def details_text(result) -> str:
    return " ".join(result.details)


def failed_checks(subject: str, body: str) -> dict[str, tuple[str, ...]]:
    return {r.name: r.details for r in run_all(subject, body, whatsapp=OWN_WHATSAPP) if not r.passed}


# --- приёмка: примеры владельца проходят все проверки ---


def test_document_has_three_examples_in_owner_format():
    assert len(EXAMPLE_LETTERS) == 3
    for subject, body in EXAMPLE_LETTERS.values():
        assert subject and body.startswith("Здравствуйте!\n\nМеня зовут Арман, я представляю Tanbala.")
        assert "Как это работает?" in body and "Мы берём на себя весь процесс." in body
        assert f"Напишите нам в WhatsApp по номеру {SPACED_WHATSAPP}." in body
        assert body.endswith("\n\nС уважением,\nАрман")


@pytest.mark.parametrize("key", list(EXAMPLE_LETTERS))
def test_example_letter_passes_every_check(key):
    # Arrange
    subject, body = EXAMPLE_LETTERS[key]
    # Act / Assert
    assert failed_checks(subject, body) == {}


def test_whatsapp_copy_of_document_has_same_text():
    """Бот читает свою копию документа: текст тот же, у нас окончания строк CRLF, у бота LF."""
    copy = KNOWLEDGE.parents[2] / "whatsapp" / "knowledge" / "tanbala-agent.md"
    if not copy.exists():
        pytest.skip("папки whatsapp рядом нет")
    assert KNOWLEDGE.read_bytes().replace(b"\r\n", b"\n") == copy.read_bytes()


def test_document_signature_is_sign_off_and_name_only():
    text = KNOWLEDGE.read_text(encoding="utf-8")
    signature = text.split("### Подпись\n\n```\n", 1)[1].split("\n```", 1)[0]
    assert signature == "С уважением,\n[имя]"


def test_owner_sample_as_sent_fails_on_dash_colon_and_venmart():
    # Arrange / Act
    failed = failed_checks(SUBJECT, OWNER_SAMPLE)
    # Assert
    assert set(failed) == {"dashes", "colons", "signature"}
    assert "VenMart" in " ".join(failed["signature"])


def test_owner_sample_without_dash_colon_and_venmart_passes_every_check():
    # Arrange: правки владельца 01.11.2026
    body = (OWNER_SAMPLE.replace(" — направление ТОО «VenMart»", "")
            .replace("под ключ:", "под ключ,").replace("одновременно —", "одновременно,")
            .replace("весь процесс: подбираем", "весь процесс. Подбираем")
            .replace("в WhatsApp:", "в WhatsApp по номеру").replace("инвентаризацию, —", "инвентаризацию, и"))
    # Act / Assert
    assert failed_checks(SUBJECT, body) == {}


def test_run_all_returns_all_named_checks():
    # Arrange / Act
    results = run_all(SUBJECT, GOOD_BODY)
    # Assert
    assert [r.name for r in results] == [
        "dashes", "colons", "semicolons", "prices", "stop_words", "links", "length",
        "signature", "notes", "jargon", "style",
    ]
    assert all(r.passed and r.details == () for r in results)


def test_good_body_passes_with_our_number_too():
    assert failed_checks(SUBJECT, GOOD_BODY) == {}


def test_run_all_flags_several_problems_in_bad_draft():
    # Arrange
    body = make_body(
        "Меня зовут [имя] — я из Tanbala.", "Скидка 20%.", "Заходите на tanbala.kz.", "Пишем так; коротко.",
        signature="[имя]\nTanbala\nWhatsApp: [номер]",
    )
    # Act
    failed = {r.name for r in run_all("АКЦИЯ", body) if not r.passed}
    # Assert
    assert {"dashes", "colons", "semicolons", "prices", "stop_words", "links", "length", "signature", "notes",
            "style"} <= failed


def test_run_all_checks_subject_for_dashes_and_links():
    # Arrange / Act
    by_name = {r.name: r for r in run_all("Учёт — без пересчёта tanbala.kz", GOOD_BODY)}
    # Assert
    assert not by_name["dashes"].passed
    assert not by_name["links"].passed


def test_run_all_flags_brackets_in_subject():
    # Arrange / Act
    by_name = {r.name: r for r in run_all("Учёт для [название компании]", GOOD_BODY)}
    # Assert
    assert not by_name["notes"].passed
    assert "[название компании]" in details_text(by_name["notes"])


# --- тире ---


@pytest.mark.parametrize(
    "sentence",
    [
        "Склад — это порядок.",
        "Склад – это порядок.",
        "Склад - это порядок.",
        "Метки ― это знак.",
        "Список:\n- коробки\n- паллеты",
    ],
)
def test_dashes_fail_on_dash_characters(sentence):
    # Arrange
    body = make_body(sentence, *NEUTRAL)
    # Act
    result = check_dashes(body)
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "sentence",
    [
        "Пишем по-русски и по-деловому.",
        "Клеим RFID-метки на коробки.",
        "Кто-нибудь из сотрудников пройдёт со сканером.",
        "Из-за ручного пересчёта склад стоит.",
        "Телефон: +7 747 959 72 38.",
    ],
)
def test_dashes_pass_on_hyphenated_words_and_phone(sentence):
    assert check_dashes(make_body(sentence, *NEUTRAL)).passed


# --- двоеточия и точки с запятой ---


@pytest.mark.parametrize(
    "sentence",
    [
        "Напишите нам в WhatsApp: +7 747 959 72 38.",
        "Мы делаем так: ставим метки.",
        "Учитываем всё: коробки, паллеты, тару.",
        "Позвоните после 10:00.",
        "Работаем с 1С:Предприятие.",
    ],
)
def test_colons_fail_in_letter_text(sentence):
    # Arrange / Act
    result = check_colons(make_body(sentence, *NEUTRAL))
    # Assert
    assert not result.passed
    assert "двоеточие: «:»" in details_text(result)


@pytest.mark.parametrize(
    "sentence",
    [
        "Как это работает?",
        "Пишите https://wa.me/77479597238.",
        "Время 10.00 подходит.",
    ],
)
def test_colons_pass_on_question_and_link_scheme(sentence):
    assert check_colons(make_body(sentence, *NEUTRAL)).passed


def test_colons_ignore_reviewer_notes_at_top():
    assert check_colons(make_body(*NEUTRAL, notes="[Проверить: склад свой или арендный]")).passed


def test_old_signature_with_whatsapp_colon_fails_colons():
    body = make_body(*NEUTRAL, signature=f"Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: {OWN_WHATSAPP}")
    assert not check_colons(body).passed


@pytest.mark.parametrize("sentence", ["Ставим метки; обучаем людей.", "Учитываем коробки; паллеты; тару."])
def test_semicolons_fail_in_letter_text(sentence):
    # Arrange / Act
    result = check_semicolons(make_body(sentence, *NEUTRAL))
    # Assert
    assert not result.passed
    assert "точка с запятой: «;»" in details_text(result)


def test_semicolons_ignore_reviewer_notes_at_top():
    assert check_semicolons(make_body(*NEUTRAL, notes="[Проверить: склад; филиалы]")).passed


@pytest.mark.parametrize("subject, name", [("Учёт склада: без пересчёта", "colons"),
                                           ("Учёт склада; без пересчёта", "semicolons")])
def test_run_all_checks_subject_for_colons_and_semicolons(subject, name):
    by_name = {r.name: r for r in run_all(subject, GOOD_BODY)}
    assert not by_name[name].passed


def test_dashes_ignore_reviewer_notes_at_top():
    # Arrange
    body = make_body(*NEUTRAL, notes="[Проверить: клиент — ИП, уточнить]")
    # Act / Assert
    assert check_dashes(body).passed


def test_dashes_details_show_fragment():
    # Arrange / Act
    result = check_dashes(make_body("Склад — это порядок.", *NEUTRAL))
    # Assert
    assert "—" in details_text(result)


# --- цены ---


@pytest.mark.parametrize(
    "text",
    [
        "Это стоит 5000 тенге.",
        "Цена от 10 000 тг за штуку.",
        "Выйдет 100 000 тнг.",
        "Метка 50 руб.",
        "Выйдет 120 рублей.",
        "Всего $100.",
        "Всего 5000₸.",
        "Это дешевле на 30 %.",
        "Вы сэкономите 20% бюджета.",
        "Вы сэкономите миллион.",
        "Стоимость 3000 за метку.",
        "Вилка цен: 5-10 тысяч тенге.",
    ],
)
def test_prices_fail_on_price_phrases(text):
    # Arrange / Act
    result = check_prices(make_body(text, *NEUTRAL))
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "text",
    [
        "Пишите: +77479597238.",
        "Пишите: +7 747 959 72 38.",
        "Всё записывается в 1С.",
        "Дальность до 20 метров.",
        "Клеим метки на рубашки и ремни.",
        "У вас 10 000 коробок на складе.",
        "Цена зависит от задачи.",
        "Стоимость считает специалист.",
        "Ридер видит сотни меток за секунду.",
    ],
)
def test_prices_pass_on_phone_1c_and_meters(text):
    assert check_prices(make_body(text, *NEUTRAL)).passed


def test_prices_checks_plain_text_argument():
    assert not check_prices("Метка стоит 300 тенге").passed
    assert check_prices("").passed


# --- стоп-слова ---


@pytest.mark.parametrize(
    "text",
    [
        "У нас действует акция.",
        "Есть скидки для новых клиентов.",
        "Дадим скидку на метки.",
        "Консультация бесплатная.",
        "Дадим бесплатную консультацию.",
        "Есть пробный период.",
        "Предложение действует только сегодня.",
        "Успейте написать.",
        "Это выгодно.",
        "Это спецпредложение.",
        "Получите бонус.",
        "Дарим подарок.",
        "Гарантируем результат.",
        "Чтение на 100 %.",
        "Чтение на 100%.",
        "Мы официальный дилер.",
        "Работает с любой 1С.",
        "Вы никогда не потеряете вещи.",
        "Вышлем образцы.",
        "Привезём тестовый комплект.",
        "Считаем в 8 раз быстрее.",
        "Работаем по всему Казахстану.",
        "Внедрим за 3 дня.",
        "Инвентаризация проходит за 3-4 часа.",
        "Покажем на одном ряду стеллажей без оплаты.",
        "Пилот без оплаты.",
        "Метки есть в наличии на складе.",
        "Оставьте штрихкод рядом с меткой.",
    ],
)
def test_stop_words_fail_in_body(text):
    # Arrange / Act
    result = check_stop_words(SUBJECT, make_body(text, *NEUTRAL))
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "subject",
    ["Акция на учёт склада", "Только сегодня: учёт склада", "Выгодный учёт", "Бесплатно считаем склад"],
)
def test_stop_words_fail_in_subject(subject):
    # Arrange / Act
    result = check_stop_words(subject, GOOD_BODY)
    # Assert
    assert not result.passed
    assert "тема" in details_text(result).lower()


@pytest.mark.parametrize(
    "subject, text",
    [
        ("Что внутри коробок, не вскрывая их", "Подбор оборудования берём на себя."),
        ("Инвентаризация обходом со сканером", "Мы проводим тесты."),
        ("Учёт склада", "Акционеры обычно не пишут нам."),
        ("Учёт склада", "Образование сотрудников не важно, мы обучаем."),
        ("Учёт склада", "Склад, офис, магазин, цех, архив."),
        ("Учёт склада", "Скидочная карта тут ни при чём, это пример слова."),
    ],
)
def test_stop_words_pass_on_clean_text(subject, text):
    # "Скидочная" не форма слова «скидка», поэтому не должна ловиться
    assert check_stop_words(subject, make_body(text, *NEUTRAL)).passed


def test_stop_words_case_insensitive():
    assert not check_stop_words(SUBJECT, make_body("СКИДКИ и Бесплатно.", *NEUTRAL)).passed


# --- ссылки ---


@pytest.mark.parametrize(
    "text",
    [
        "Смотрите https://tanbala.kz.",
        "Смотрите http://venmart.kz/rfid.",
        "Смотрите tanbala.kz.",
        "Смотрите www.venmart.kz.",
        "Смотрите venmart.kz/page.",
        "Смотрите https://example.com/wa.me.",
        "Смотрите http://wa.me.evil.com/1.",
        "Смотрите tanbala.рф.",
    ],
)
def test_links_fail_on_non_whatsapp(text):
    # Arrange / Act
    result = check_links(make_body(text, *NEUTRAL))
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "text",
    [
        "Пишите https://wa.me/77479597238.",
        "Пишите wa.me/77479597238.",
        "Пишите https://api.whatsapp.com/send?phone=77479597238.",
        "Пишите на info@tanbala.kz.",
        "Пишите в WhatsApp: +77479597238.",
        "Метки версии 1.5 подходят.",
        "Склад.Офис.",
    ],
)
def test_links_pass_on_whatsapp_email_and_plain_text(text):
    assert check_links(make_body(text, *NEUTRAL)).passed


# --- длина ---


def sentences(count: int) -> tuple[str, ...]:
    return tuple(f"Это предложение номер {n}." for n in range(1, count + 1))


@pytest.mark.parametrize("count", [0, 1, 5, 7, 13, 20])
def test_length_fails_outside_8_to_12(count):
    # Arrange / Act
    result = check_length(make_body(*sentences(count)))
    # Assert
    assert not result.passed
    assert f"предложений: {count}," in details_text(result)


@pytest.mark.parametrize("count", [8, 9, 10, 11, 12])
def test_length_passes_for_8_to_12(count):
    assert check_length(make_body(*sentences(count))).passed


def test_length_does_not_count_greeting_notes_and_signature():
    # Arrange: 7 предложений + приветствие + заметка + подпись = было бы больше 8, но честных 7
    body = make_body(*sentences(7), notes="[Проверить: имя уточнить.]")
    # Act / Assert
    assert not check_length(body).passed
    assert check_length(make_body(*sentences(8), notes="[Проверить: имя уточнить.]")).passed


def test_length_does_not_count_sign_off_and_name():
    # Arrange: без подписи 12 предложений; «С уважением, Арман» тринадцатым не считается
    body = make_body(*sentences(12), signature="С уважением,\nАрман Серикбаев")
    # Act / Assert
    assert check_length(body).passed


def test_length_counts_questions_and_exclamations():
    # Arrange
    body = make_body("Что у вас теряется? Мы поможем! Ставим учёт. Тесты проводим. Обучаем людей. "
                     "Как это работает? Метки на вещах. Всё в 1С.")
    # Act / Assert
    assert check_length(body).passed


def test_length_does_not_split_on_decimals_numbers_and_lowercase():
    # Arrange: 8 предложений, внутри «1.5», «20 метров.» с продолжением, «и т.д.» и номер с пробелами
    body = make_body(
        "Метка живёт 1.5 года.", "Читаем до 20 метров.", "Склад, офис и т.д. тоже подходят.",
        "Всё в 1С.", "Обучаем команду.", "Как это работает?", "Метки на вещах.",
        f"Пишите в WhatsApp по номеру {SPACED_WHATSAPP}.",
    )
    # Act / Assert
    assert check_length(body).passed


# --- подпись ---


@pytest.mark.parametrize(
    "signature",
    [
        "С уважением,\n[имя]",
        "[подпись]",
        "Арман",
        "С уважением,",
        "С уважением\nАрман",
        "С уважением, Арман",
        "С уважением,\nАрман.",
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238",
        "С уважением,\nАрман\nWhatsApp: +7 747 959 72 38",
        "С уважением,\nАрман\nTanbala, направление ТОО «VenMart»",
        "С уважением,\nАрман, Tanbala, направление ТОО «VenMart»",
    ],
)
def test_signature_fails_on_bad_signature(signature):
    # Arrange / Act
    result = check_signature(make_body(*NEUTRAL, signature=signature))
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "signature",
    [
        SIGNATURE,
        "С уважением,\nАрман Серикбаев\n",
        "С уважением,\n\nАрман",
    ],
)
def test_signature_passes_on_valid_variants(signature):
    assert check_signature(make_body(*NEUTRAL, signature=signature)).passed


def test_signature_fails_on_empty_body():
    assert not check_signature("").passed


def test_signature_ignores_reviewer_notes_at_top():
    assert check_signature(make_body(*NEUTRAL, notes="[Проверить: склад свой или арендный]")).passed


def test_venmart_anywhere_in_letter_fails_signature():
    # Arrange
    body = make_body("Я представляю Tanbala, направление ТОО «VenMart».", *NEUTRAL)
    # Act
    result = check_signature(body)
    # Assert
    assert not result.passed
    assert "VenMart" in details_text(result)


def test_cyrillic_venmart_fails_signature():
    assert not check_signature(make_body("Мы направление ТОО «ВенМарт».", *NEUTRAL)).passed


def test_paragraph_starting_with_s_uvazheniem_is_not_a_sign_off():
    # Arrange: «С уважением к вашему времени…» это текст письма, а не подпись
    body = make_body(*NEUTRAL).replace("Здравствуйте!\n\n", "Здравствуйте!\n\nС уважением к вашему времени, коротко.\n")
    # Act / Assert
    assert check_signature(body).passed
    assert check_length(body).passed and "С уважением к вашему" in checks._main_text(body)


def test_second_sign_off_in_letter_fails_signature():
    # Arrange: модель сама подписалась, и программа добавила подпись ещё раз
    body = GOOD_BODY.replace(SIGNATURE, f"{SIGNATURE}\n\n{SIGNATURE}")
    # Act
    result = check_signature(body)
    # Assert
    assert not result.passed
    assert "больше одного раза" in details_text(result)


# --- заметки и скобки ---


@pytest.mark.parametrize(
    "body",
    [
        make_body("Меня зовут [имя].", *NEUTRAL),
        make_body("Пишите: [номер].", *NEUTRAL),
        make_body(*NEUTRAL, signature="[подпись]"),
        make_body("Мы работаем с [название компании].", *NEUTRAL),
        make_body("[Проверить: сомневаюсь]", *NEUTRAL),
        make_body(*NEUTRAL, signature="С уважением,\n[имя]"),
        make_body(*NEUTRAL, notes="[Заметка: что-то]"),
        make_body(*NEUTRAL, notes="[Проверить: не закрыта"),
        make_body("Закрывающая скобка ] одна.", *NEUTRAL),
    ],
)
def test_notes_fail_on_stray_brackets_and_misplaced_notes(body):
    # Arrange / Act
    result = check_notes(body)
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize(
    "notes",
    [
        "",
        "[Проверить: сомневаюсь в отрасли]",
        "[Ответить лично: спрашивают, кто пишет]",
        "[Проверить: отрасль неясна]\n[Ответить лично: просят цену]",
    ],
)
def test_notes_pass_on_notes_at_top_only(notes):
    assert check_notes(make_body(*NEUTRAL, notes=notes)).passed


def test_notes_details_show_offending_fragment():
    # Arrange / Act
    result = check_notes(make_body("Меня зовут [имя].", *NEUTRAL))
    # Assert
    assert "[имя]" in details_text(result)


# --- жаргон ---


@pytest.mark.parametrize(
    "word",
    ["EPC", "epc", "UHF", "Инлей", "инлэй", "инлеи", "TID", "энкодер", "Энкодеры", "МГц", "мВт",
     "ГГц", "Zebra", "Impinj", "Chainway", "SILION", "частоты"],
)
def test_jargon_fails_on_forbidden_terms(word):
    # Arrange / Act
    result = check_jargon(make_body(f"Это про {word} и всё.", *NEUTRAL))
    # Assert
    assert not result.passed
    assert word.lower() in details_text(result).lower()


@pytest.mark.parametrize(
    "text",
    [
        "Ridery и Tidy тут просто слова.",
        "Ридер видит метки, антенна стоит на воротах.",
        "Клеим RFID-метки.",
        "Код epcot не при чём.",
        "Ручной сканер нужен для обхода.",
        "Настольный прибор записывает номер в метку.",
    ],
)
def test_jargon_passes_on_plain_words(text):
    assert check_jargon(make_body(text, *NEUTRAL)).passed


# --- стиль ---


@pytest.mark.parametrize(
    "text",
    [
        "Отлично 👍",
        "Супер ✅",
        "Привет 😀.",
        "Отлично!!",
        "Отлично!!!",
        "СРОЧНО напишите нам.",
        "ЛУЧШИЙ учёт.",
        "UNIQUE offer.",
        "Это письмо написано программой.",
        "Это пишет бот.",
        "Письмо сгенерировано нейросетью.",
        "Письмо подготовил ИИ.",
        "Текст создан искусственным интеллектом.",
    ],
)
def test_style_fails_on_emoji_shouting_and_ai_mentions(text):
    # Arrange / Act
    result = check_style(SUBJECT, make_body(text, *NEUTRAL))
    # Assert
    assert not result.passed
    assert result.details


@pytest.mark.parametrize("subject", ["Учёт склада 🚀", "УЧЁТ склада", "Учёт склада!!"])
def test_style_fails_on_bad_subject(subject):
    assert not check_style(subject, GOOD_BODY).passed


@pytest.mark.parametrize(
    "text",
    [
        "Мы ставим учёт на RFID-метках.",
        "Это направление ТОО «VenMart».",
        "Всё попадает в 1С.",
        "Вау! Это сработало.",
        "Что, если у вас теряется инструмент?!",
        "Пишите в WhatsApp.",
        "Мы делаем программу обучения для сотрудников.",
        "Обучаем сотрудников работать с ботинками и касками.",
    ],
)
def test_style_passes_on_abbreviations_and_calm_text(text):
    # "?!" и «программа обучения» не должны ловиться
    assert check_style(SUBJECT, make_body(text, *NEUTRAL)).passed


# --- форма результата ---


def test_check_result_is_frozen_dataclass():
    # Arrange
    result = checks.CheckResult("x", True)
    # Act / Assert
    assert result.details == ()
    with pytest.raises(AttributeError):
        result.passed = False  # type: ignore[misc]


# --- контакты: только наш номер WhatsApp, группами через пробел ---


@pytest.mark.parametrize(
    "text",
    [
        "Пишите в WhatsApp: +7 701 555 44 33.",
        "Звоните 8 (701) 555-44-33.",
        "Ссылка: https://wa.me/77015554433.",
    ],
)
def test_foreign_phone_or_whatsapp_fails(text):
    # Arrange: наш номер в призыве тоже есть (NEUTRAL)
    result = check_contacts(make_body(text, *NEUTRAL), OWN_WHATSAPP)
    # Assert
    assert not result.passed
    assert "чужой" in details_text(result)


@pytest.mark.parametrize(
    "text",
    [
        "Учёт идёт в 1С, ридер видит до 20 метров.",
        "Ссылка https://wa.me/77479597238 тоже наша.",
        f"Ещё раз номер {SPACED_WHATSAPP}.",
    ],
)
def test_own_number_passes(text):
    assert check_contacts(make_body(text, *NEUTRAL), OWN_WHATSAPP).passed


@pytest.mark.parametrize("whatsapp", [OWN_WHATSAPP, SPACED_WHATSAPP, "8 747 959-72-38"])
def test_own_number_from_settings_in_any_format_is_recognised(whatsapp):
    assert check_contacts(GOOD_BODY, whatsapp).passed


def test_own_number_with_non_breaking_spaces_passes():
    body = GOOD_BODY.replace(SPACED_WHATSAPP, SPACED_WHATSAPP.replace(" ", " "))
    assert " " in body
    assert check_contacts(body, OWN_WHATSAPP).passed


@pytest.mark.parametrize("written", ["+77479597238", "8 747 959 72 38", "+7 (747) 959-72-38", "+7 747 959 7238"])
def test_own_number_not_in_spaced_format_fails(written):
    # Arrange
    body = GOOD_BODY.replace(SPACED_WHATSAPP, written)
    # Act
    result = check_contacts(body, OWN_WHATSAPP)
    # Assert
    assert not result.passed
    assert f"пишем «{SPACED_WHATSAPP}»" in details_text(result)


@pytest.mark.parametrize(
    "call",
    ["Напишите нам в WhatsApp.", "Напишите нам https://wa.me/77479597238."],
)
def test_letter_without_our_written_number_fails(call):
    # Arrange
    body = GOOD_BODY.replace(f"Напишите нам в WhatsApp по номеру {SPACED_WHATSAPP}.", call)
    # Act
    result = check_contacts(body, OWN_WHATSAPP)
    # Assert
    assert not result.passed
    assert "нет нашего номера" in details_text(result)


@pytest.mark.parametrize(
    "phone",
    [OWN_WHATSAPP, SPACED_WHATSAPP, "87479597238", "+7 (747) 959-72-38", " +7-747-959-72-38 "],
)
def test_format_whatsapp_groups_digits_with_spaces(phone):
    assert format_whatsapp(phone) == SPACED_WHATSAPP


@pytest.mark.parametrize("phone", ["", "12345", "+1 202 555 0100", "+7747959723", "+774795972381"])
def test_format_whatsapp_rejects_non_kz_numbers(phone):
    with pytest.raises(ValueError):
        format_whatsapp(phone)


def test_run_all_checks_contacts_only_when_number_is_known():
    body = make_body("Пишите: +7 701 555 44 33.", *NEUTRAL)

    names_without = {result.name for result in run_all(SUBJECT, body)}
    with_number = {result.name: result.passed for result in run_all(SUBJECT, body, whatsapp=OWN_WHATSAPP)}

    assert "contacts" not in names_without
    assert with_number["contacts"] is False
