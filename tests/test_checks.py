"""Тесты проверок письма кодом (tanbala_leads/checks.py). Правила: knowledge/tanbala-agent.md."""

import pytest

from tanbala_leads import checks
from tanbala_leads.checks import (
    check_dashes,
    check_jargon,
    check_length,
    check_links,
    check_notes,
    check_prices,
    check_signature,
    check_stop_words,
    check_style,
    run_all,
)

SIGNATURE = "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238"
SUBJECT = "Учёт склада без ручного пересчёта"

# Нейтральные предложения: 6 штук, без запрещённого
NEUTRAL = (
    "Меня зовут Арман, я из Tanbala.",
    "Мы ставим учёт вещей на RFID-метках под ключ.",
    "Ридер видит сотни меток за секунду.",
    "Всё попадает в 1С.",
    "Подбор оборудования берём на себя.",
    "Напишите нам в WhatsApp.",
)


def make_body(*sentences: str, notes: str = "", signature: str = SIGNATURE) -> str:
    """Собрать черновик: [заметки], приветствие, абзац, подпись."""
    head = f"{notes}\n" if notes else ""
    return f"{head}Здравствуйте!\n\n{' '.join(sentences)}\n\n{signature}"


GOOD_BODY = make_body(*NEUTRAL)

# Три примера из раздела 8 документа: [имя] -> Арман, [номер] -> +77479597238, [подпись] -> подпись
EXAMPLE_LETTERS = {
    "warehouse": (
        "Учёт склада без ручного пересчёта",
        "Здравствуйте!\n\n"
        "Меня зовут Арман, я из Tanbala. Мы ставим учёт вещей на RFID-метках под ключ.\n\n"
        "На каждую коробку клеится метка. Ридер видит сотни меток за секунду, даже сквозь картон, "
        "и всё сразу попадает в 1С. Пересчёт идёт обходом со сканером, а отгрузку видно целиком, "
        "не вскрывая коробки.\n\n"
        "Всё делаем сами: подбираем и ставим оборудование, проводим тесты, связываем с вашей 1С "
        "и обучаем сотрудников.\n\n"
        "Если пересчёт у вас занимает много времени или товар теряется, напишите нам в WhatsApp: "
        "+77479597238. Расскажите в двух словах о задаче, и мы подскажем, как её решить.\n\n"
        + SIGNATURE,
    ),
    "office": (
        "Где сейчас каждый ноутбук и стол",
        "Здравствуйте!\n\n"
        "Меня зовут Арман, я из Tanbala. Мы помогаем компаниям вести учёт имущества на RFID-метках.\n\n"
        "На каждую вещь клеится небольшая метка: на стол, ноутбук, монитор, сейф. "
        "Инвентаризация идёт обходом со сканером. Прошли по этажу, и список сверен с 1С.\n\n"
        "Подбор оборудования, установку, связь с 1С и обучение ваших сотрудников берём на себя.\n\n"
        "Если инвентаризация у вас занимает дни, напишите нам в WhatsApp: +77479597238. "
        "Расскажите, что хотите учитывать, и мы подскажем, с чего начать.\n\n" + SIGNATURE,
    ),
    "tools": (
        "Инструмент, который не теряется между сменами",
        "Здравствуйте!\n\n"
        "Меня зовут Арман, я из Tanbala. Мы ставим учёт вещей на RFID-метках под ключ.\n\n"
        "На каждый инструмент и комплект спецодежды клеится метка. Обход со сканером показывает, "
        "что на месте, а чего нет, и всё записывается в 1С.\n\n"
        "Всё делаем сами: оборудование, тесты, связь с 1С и обучение сотрудников.\n\n"
        "Если инструмент у вас теряется, напишите нам в WhatsApp: +77479597238. "
        "Расскажите, что хотите учитывать, и мы подскажем, как это устроить.\n\n" + SIGNATURE,
    ),
}


def details_text(result) -> str:
    return " ".join(result.details)


# --- приёмка: примеры владельца проходят все проверки ---


@pytest.mark.parametrize("key", list(EXAMPLE_LETTERS))
def test_example_letter_passes_every_check(key):
    # Arrange
    subject, body = EXAMPLE_LETTERS[key]
    # Act
    results = run_all(subject, body)
    # Assert
    failed = {r.name: r.details for r in results if not r.passed}
    assert failed == {}


def test_run_all_returns_all_named_checks():
    # Arrange / Act
    results = run_all(SUBJECT, GOOD_BODY)
    # Assert
    assert [r.name for r in results] == [
        "dashes", "prices", "stop_words", "links", "length",
        "signature", "notes", "jargon", "style",
    ]
    assert all(r.passed and r.details == () for r in results)


def test_run_all_flags_several_problems_in_bad_draft():
    # Arrange
    body = make_body(
        "Меня зовут [имя] — я из Tanbala.", "Скидка 20%.", "Заходите на tanbala.kz.",
        signature="[имя]\nTanbala\nWhatsApp: [номер]",
    )
    # Act
    failed = {r.name for r in run_all("АКЦИЯ", body) if not r.passed}
    # Assert
    assert {"dashes", "prices", "stop_words", "links", "length", "signature", "notes", "style"} <= failed


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
        "Телефон: +7 747 959 72 38.",
    ],
)
def test_dashes_pass_on_hyphenated_words_and_phone(sentence):
    assert check_dashes(make_body(sentence, *NEUTRAL)).passed


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


@pytest.mark.parametrize("count", [0, 1, 4, 9, 12])
def test_length_fails_outside_5_to_8(count):
    # Arrange / Act
    result = check_length(make_body(*sentences(count)))
    # Assert
    assert not result.passed
    assert str(count) in details_text(result)


@pytest.mark.parametrize("count", [5, 6, 7, 8])
def test_length_passes_for_5_to_8(count):
    assert check_length(make_body(*sentences(count))).passed


def test_length_does_not_count_greeting_notes_and_signature():
    # Arrange: 4 предложения + приветствие + заметка + подпись = было бы больше 5, но честных 4
    body = make_body(*sentences(4), notes="[Проверить: имя уточнить.]")
    # Act / Assert
    assert not check_length(body).passed
    assert check_length(make_body(*sentences(5), notes="[Проверить: имя уточнить.]")).passed


def test_length_counts_questions_and_exclamations():
    # Arrange
    body = make_body("Что у вас теряется? Мы поможем! Ставим учёт. Тесты проводим. Обучаем людей.")
    # Act / Assert
    assert check_length(body).passed


def test_length_does_not_split_on_decimals_numbers_and_lowercase():
    # Arrange: 5 предложений, внутри «1.5», «20 метров.» с продолжением и «и т.д.»
    body = make_body(
        "Метка живёт 1.5 года.", "Читаем до 20 метров.", "Склад, офис и т.д. тоже подходят.",
        "Всё в 1С.", "Пишите в WhatsApp: +77479597238.",
    )
    # Act / Assert
    assert check_length(body).passed


# --- подпись ---


@pytest.mark.parametrize(
    "signature",
    [
        "[имя]\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238",
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: [номер]",
        "[подпись]",
        "\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238",
        "Арман\nTanbala\nWhatsApp: +77479597238",
        "Арман\nTanbala, направление ТОО VenMart\nWhatsApp: +77479597238",
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: 7479597238",
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +7747959723",
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +774795972381",
        "Арман\nTanbala, направление ТОО «VenMart»",
        "Арман\nWhatsApp: +77479597238\nTanbala, направление ТОО «VenMart»",
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
        "Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: +7 747 959 72 38",
        "Арман Серикбаев\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238\n",
        "Арман\n\nTanbala, направление ТОО «VenMart»\nWhatsApp: +77479597238",
    ],
)
def test_signature_passes_on_valid_variants(signature):
    assert check_signature(make_body(*NEUTRAL, signature=signature)).passed


def test_signature_fails_on_empty_body():
    assert not check_signature("").passed


# --- заметки и скобки ---


@pytest.mark.parametrize(
    "body",
    [
        make_body("Меня зовут [имя].", *NEUTRAL),
        make_body("Пишите: [номер].", *NEUTRAL),
        make_body(*NEUTRAL, signature="[подпись]"),
        make_body("Мы работаем с [название компании].", *NEUTRAL),
        make_body("[Проверить: сомневаюсь]", *NEUTRAL),
        make_body(*NEUTRAL, signature="Арман\nTanbala, направление ТОО «VenMart»\nWhatsApp: [номер]"),
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
