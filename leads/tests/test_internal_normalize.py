"""Разбор входа WhatsApp-бота и чистка текстов: без базы и без сети."""

import pytest

from tanbala_leads.internal import normalize as norm


@pytest.mark.parametrize(("raw", "domain"), [
    ("sklad.kz", "sklad.kz"),
    ("WWW.Sklad.KZ", "sklad.kz"),
    ("https://www.shop.sklad.kz/about?x=1", "sklad.kz"),
    ("ivan.petrov@almaty.sklad.kz", "sklad.kz"),
    ("a.sklad.com.kz", "sklad.com.kz"),
    ("sklad.com.kz", "sklad.com.kz"),
    ("http://sklad.kz:8080/", "sklad.kz"),
    ("склад.қаз", "склад.қаз".encode("idna").decode("ascii")),
])
def test_domain_is_reduced_to_registrable_domain(raw, domain):
    assert norm.parse_domain(raw) == domain


@pytest.mark.parametrize("raw", ["gmail.com", "ivan@mail.ru", "user@yandex.kz", "https://www.icloud.com", "bk.ru"])
def test_free_mail_domain_is_accepted_but_ignored(raw):
    assert norm.parse_domain(raw) is None


@pytest.mark.parametrize("raw", ["com.kz", "kz", "localhost", "не домен", "http://", "a" * 254, "sklad..kz"])
def test_bad_domain_is_refused(raw):
    with pytest.raises(norm.BadInput):
        norm.parse_domain(raw)


@pytest.mark.parametrize("raw", ["+7 (701) 123-45-67", "8 701 123 45 67", "87011234567", "77011234567",
                                 "7011234567", "+7-701-1234567"])
def test_phone_formats_give_one_number(raw):
    assert norm.normalize_phone(raw) == "77011234567"


@pytest.mark.parametrize("raw", ["12345", "+1 202 555 0100 22", "9011234567 12", "телефон", "7" * 40])
def test_bad_phone_is_refused(raw):
    with pytest.raises(norm.BadInput):
        norm.normalize_phone(raw)


@pytest.mark.parametrize(("raw", "name"), [
    ('ТОО «Платформа-А»', "платформа а"),
    ("Платформа-А, склад", "платформа а"),
    ('TOO "Platforma-A" LLP', "too platforma a"),
    ("  ИП   Ёлкин  ", "елкин"),
    ("АО “Казахтелеком”", "казахтелеком"),
    ("Partner Express Logistic, офис", "partner express logistic"),
])
def test_name_is_normalized(raw, name):
    assert norm.normalize_name(raw) == name


def test_empty_or_long_name_is_refused():
    for raw in ("", "  ", "ТОО", "«»", ", склад", "я" * 201):
        with pytest.raises(norm.BadInput):
            norm.parse_name(raw)


def test_alias_empty_after_normalization_is_dropped_not_refused():
    assert [norm.parse_alias(raw) for raw in ("", "  ", "ТОО", "«»", ", банк")] == [None] * 5
    assert norm.parse_alias(" ТОО «Т-Банк» ") == "т банк"


@pytest.mark.parametrize("raw", ["я" * 201, "Т\x00Банк", "\ud800"])
def test_long_or_broken_alias_is_refused_like_name(raw):
    with pytest.raises(norm.BadInput):
        norm.parse_alias(raw)


def test_similarity_ignores_word_order_and_ranks_typos():
    assert norm.name_similarity("платформа а", "платформа а") == 1.0
    assert norm.name_similarity("express logistic partner", "partner express logistic") == 1.0
    assert norm.name_similarity("платформа а", "платфорама а") > 0.8
    assert norm.name_similarity("платформа а", "аксенгер") < 0.5
    assert norm.name_similarity("", "аксенгер") == 0.0


def test_short_brand_matches_by_whole_words_but_never_as_the_same_name():
    # Живой тест 31.10.2026: клиент написал «kusto», в базе «Kusto Logistics Management, компания».
    assert norm.name_match("kusto", "kusto logistics management") == norm.WORD_PREFIX_SIMILARITY
    assert norm.name_match("kusto logistics", "kusto logistics management") == norm.WORD_PREFIX_SIMILARITY
    assert norm.name_match("kusto", "mks kusto logistics") < 0.7  # слово в середине не в счёт
    assert norm.name_match("dhl", "dhl international kazakhstan") == norm.WORD_PREFIX_SIMILARITY
    assert norm.name_match("kusto", "kustom logistics") < 0.7  # не целое слово
    assert norm.name_match("kusto", "logistics kustoo") < 0.7
    assert norm.name_match("ас", "ас логистик") < 0.7  # короче трёх букв по словам не ищем
    assert norm.name_match("kusto logistics management", "kusto") < 0.7  # название короче запроса
    assert norm.name_match("платформа а", "платформа а") == 1.0
    assert norm.name_match("kusto", "kusto") == 1.0
    assert norm.name_match("", "kusto logistics") == 0.0


def test_clean_text_removes_control_and_invisible_characters_and_cuts():
    raw = "Склад\x00 ​А‮Б\tВ\n\nГ\x1b[31m"
    assert norm.clean_text(raw, 100) == "Склад АБ В Г [31m"
    assert norm.clean_text("а" * 50, 10) == "а" * 9 + "…"
    assert norm.clean_text(None, 10) is None
    assert norm.clean_text("​​", 10) is None


def test_contacts_are_hidden_but_numbers_stay():
    text = "Пишите ivan@sklad.kz или звоните +7 (727) 355-10-20, склад 11 400 м², с 2008 года."
    assert norm.hide_contacts(text) == "Пишите [скрыто] или звоните [скрыто], склад 11 400 м², с 2008 года."


def test_at_sign_in_url_path_does_not_change_host():
    assert norm.parse_domain("https://sklad.kz/contact@x.com") == "sklad.kz"
    assert norm.parse_domain("https://ivan@sklad.kz/") == "sklad.kz"


def test_masked_emails_and_dotted_phones_are_hidden():
    text = "ivan [at] sklad [dot] kz, тел. 701.123.45.67 и 727/355-10-20, площадь 11.400 м², 27.10.2026"
    assert norm.hide_contacts(text) == "[скрыто], тел. [скрыто] и [скрыто], площадь 11.400 м², 27.10.2026"
