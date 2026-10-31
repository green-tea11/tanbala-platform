"""Тесты tanbala_leads.sites: без сети. DNS подменяется фейковым резолвером, crawl4ai фейковым обходчиком."""

import asyncio
import re
import socket
from types import SimpleNamespace

import pytest

from tanbala_leads import sites
from tanbala_leads.sites import (
    MAX_PAGE_TEXT_CHARS,
    MAX_SITE_TEXT_CHARS,
    PAGE_KINDS,
    SOCIAL_DOMAINS,
    PageText,
    SiteCrawl,
    crawl_site,
    extract_emails,
    is_public_url,
    is_role_address,
    normalize_domain,
    pick_pages,
)

# Проверки из схемы базы (tanbala_leads/db.py): домены host_name и email_address.
PG_DOMAIN = re.compile(r"^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z0-9]([a-z0-9-]*[a-z0-9])?$")
PG_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+[.][^@\s]+$")

PUBLIC_IP = "185.22.66.10"


def fake_resolver(table: dict[str, list[str]]):
    """Резолвер вместо socket.getaddrinfo: хост → список адресов, неизвестный хост → gaierror."""
    calls: list[str] = []

    def resolve(host, port, *args, **kwargs):
        calls.append(host)
        if host not in table:
            raise socket.gaierror(socket.EAI_NONAME, "not found")
        return [
            (socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0))
            for ip in table[host]
        ]

    resolve.calls = calls
    return resolve


def resolve_everything_public(host, port, *args, **kwargs):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (PUBLIC_IP, port or 0))]


# --- normalize_domain ---


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("http://www.Pel.kz/contacts?x=1", "pel.kz"),
        ("kontainer.kz/sales", "kontainer.kz"),
        ("https://shop.kontainer.kz:8443/catalog", "shop.kontainer.kz"),
        ("HTTPS://WWW.TECHNODOM.KZ.", "technodom.kz"),
        ("  www.astana-motors.kz  ", "astana-motors.kz"),
        ("//alser.kz/about", "alser.kz"),
        ("http://pel.kz./", "pel.kz"),
        ("pel.com.kz", "pel.com.kz"),
        ("http://тест.қаз/", "xn--e1aybc.xn--80ao21a"),
        ("кондитерская.kz", "xn--80ahdlidrhwki5n.kz"),
        ("https://www.Алматы.kz/о-нас", "xn--80aa6ae5a6c.kz"),
        ("www2.pel.kz", "www2.pel.kz"),
    ],
)
def test_normalize_domain(url, expected):
    domain = normalize_domain(url)

    assert domain == expected
    assert PG_DOMAIN.match(domain)
    assert not domain.startswith("www.")


@pytest.mark.parametrize(
    "url",
    [
        "",
        "   ",
        "http://",
        "pel",
        "localhost",
        "http://localhost:5432",
        "www.kz",
        "http://127.0.0.1/",
        "192.168.1.10:8080",
        "http://[::1]/",
        "http://1.2.3.999/",
        "ftp://pel.kz/",
        "mailto:info@pel.kz",
        "tel:+77272000000",
        "javascript:void(0)",
        "http://user@pel.kz/",
        "pel..kz",
        "-pel.kz",
        "pel_kz.kz",
        "http://[invalid/",
        "https://instagram.com/pel_kz",
        "https://www.instagram.com/pel_kz/",
        "m.facebook.com/pel",
        "https://wa.me/77011234567",
        "api.whatsapp.com/send?phone=77011234567",
        "https://t.me/pel_kz",
        "https://link.2gis.ru/1.2/ABCDEF",
        "2gis.kz/almaty/firm/70000001234567",
        "taplink.cc/pel",
        "linktr.ee/pel",
        "https://kaspi.kz/shop/info/merchant/123",
        "https://satu.kz/c123-pel.html",
        "https://almaty.hh.kz/employer/123",
        "https://youtu.be/abc",
    ],
)
def test_normalize_domain_rejects(url):
    assert normalize_domain(url) is None


def test_social_domains_are_lowercase_bare_domains():
    for domain in SOCIAL_DOMAINS:
        assert PG_DOMAIN.match(domain), domain
        assert not domain.startswith("www.")


# --- is_public_url ---


@pytest.mark.parametrize(
    ("url", "addresses"),
    [
        ("https://pel.kz/contacts", [PUBLIC_IP]),
        ("http://pel.kz:80/", [PUBLIC_IP]),
        ("https://pel.kz:443/", [PUBLIC_IP]),
        ("https://pel.kz/", [PUBLIC_IP, "2a00:1450:4001::1"]),
        ("HTTPS://PEL.KZ./", [PUBLIC_IP]),
    ],
)
def test_is_public_url_accepts_public(url, addresses):
    resolver = fake_resolver({"pel.kz": addresses})

    assert is_public_url(url, resolver=resolver)


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.10.0.5",
        "10.0.0.5",
        "172.16.3.4",
        "192.168.1.1",
        "169.254.169.254",
        "100.64.1.1",
        "0.0.0.0",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
        "198.18.0.1",
        "::1",
        "::",
        "fd12:3456::1",
        "fe80::1%12",
        "ff0e::1",
        "::ffff:127.0.0.1",
        "::ffff:10.0.0.1",
        "64:ff9b::7f00:1",
    ],
)
def test_is_public_url_rejects_non_global_address(address):
    resolver = fake_resolver({"pel.kz": [address]})

    assert not is_public_url("https://pel.kz/", resolver=resolver)


def test_is_public_url_rejects_mixed_public_and_private():
    resolver = fake_resolver({"pel.kz": [PUBLIC_IP, "127.0.0.1"]})

    assert not is_public_url("https://pel.kz/", resolver=resolver)


def test_is_public_url_rejects_unresolvable_and_empty():
    assert not is_public_url("https://nosuch.kz/", resolver=fake_resolver({}))
    assert not is_public_url("https://pel.kz/", resolver=fake_resolver({"pel.kz": []}))


@pytest.mark.parametrize(
    "url",
    [
        "",
        "pel.kz",
        "ftp://pel.kz/",
        "file:///C:/Windows/win.ini",
        "javascript:alert(1)",
        "http://localhost/",
        "http://LOCALHOST:8080/",
        "http://api.localhost/",
        "http://127.0.0.1/",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f.1/",
        "http://[::1]/",
        "http://10.0.0.1/",
        "http://185.22.66.10/",
        "https://pel.kz:8080/",
        "https://pel.kz:5432/",
        "http://pel.kz:abc/",
        "http://user:pass@pel.kz/",
        "http://pel.kz\\@127.0.0.1/",
        "http://pel/",
    ],
)
def test_is_public_url_rejects_by_shape_even_if_dns_is_public(url):
    assert not is_public_url(url, resolver=resolve_everything_public)


def test_is_public_url_resolves_punycode():
    resolver = fake_resolver({"xn--e1aybc.xn--80ao21a": [PUBLIC_IP]})

    assert is_public_url("https://тест.қаз/", resolver=resolver)
    assert resolver.calls == ["xn--e1aybc.xn--80ao21a"]


# --- extract_emails ---


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Почта: info@pel.kz, отдел продаж: Sales@Pel.KZ.", {"info@pel.kz", "sales@pel.kz"}),
        ("Пишите на info@pel.kz.", {"info@pel.kz"}),
        ("E-mail:office@astana-motors.kz Тел.: +7 727 300 00 00", {"office@astana-motors.kz"}),
        ("Бухгалтерия: 87017771234@mail.ru", {"87017771234@mail.ru"}),
        ("a.nurlanov@kontainer.kz;zakaz@kontainer.kz", {"a.nurlanov@kontainer.kz", "zakaz@kontainer.kz"}),
        ('<a href="mailto:office@astana-motors.kz">Написать</a>', {"office@astana-motors.kz"}),
        (
            '<a href="mailto:zakaz%40kontainer.kz?subject=%D0%97%D0%B0%D0%BA%D0%B0%D0%B7">Заказать</a>',
            {"zakaz@kontainer.kz"},
        ),
        ("<a href='MAILTO:Info@Pel.kz?subject=Вопрос&body=Здравствуйте'>", {"info@pel.kz"}),
        ("mailto:buh@pel.kz,hr@pel.kz?cc=director@pel.kz", {"buh@pel.kz", "hr@pel.kz", "director@pel.kz"}),
        ("[info@pel.kz](mailto:info@pel.kz)", {"info@pel.kz"}),
        ("info [at] pel [dot] kz", {"info@pel.kz"}),
        ("info(at)pel.kz", {"info@pel.kz"}),
        ("sales {AT} kontainer {DOT} kz", {"sales@kontainer.kz"}),
        ("info (собака) pel (точка) kz", {"info@pel.kz"}),
        ("info[@]pel.kz", {"info@pel.kz"}),
        ("info&#64;pel.kz", {"info@pel.kz"}),
        ("info&#x40;pel&#46;kz", {"info@pel.kz"}),
        ("<span>info&commat;pel.kz</span>", {"info@pel.kz"}),
        ('{"email":"info\\u0040pel.kz"}', {"info@pel.kz"}),
        ('"\\u003cinfo@pel.kz\\u003e"', {"info@pel.kz"}),
        ("почта: info@xn--80aa6ae5a6c.kz", {"info@xn--80aa6ae5a6c.kz"}),
    ],
)
def test_extract_emails(text, expected):
    assert extract_emails(text) == expected


@pytest.mark.parametrize(
    "text",
    [
        "",
        '<img src="/img/logo@2x.png">',
        "icon-cart@3x.webp bg@2x.jpg sprite@2x.svg",
        "style@1.0.css app@2.1.min.js",
        "react-dom@18.2.0 lodash@4.17.21",
        "user@example.com you@domain.com your@email.com name@test.com",
        "https://abc123def@o123456.ingest.sentry.io/42",
        "605a7baede844d278b89dc95ae0a9123@sentry-next.wixpress.com",
        "noreply@wixpress.com",
        "@media (max-width: 768px) {}",
        "Мы в Instagram: @pel.kz",
        "info@pel",
        "info@pel.k",
        "info@pel.123",
        "admin@server.local",
        "info..sales@pel.kz",
        "a" * 250 + "@pel.kz",
    ],
)
def test_extract_emails_drops_junk(text):
    assert extract_emails(text) == set()


# Подпись, прилипшая к адресу (на сервере сайт дал «e-mailinfo@erdaholding.com», ревью 01.11.2026)

@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("Телефон: +7 (727) 355-10-20E-mailinfo@erdaholding.com\nАдрес: г. Алматы, ул. Сатпаева 30",
         {"info@erdaholding.com"}),
        ("**Контакты**\n\nEmailsales@kontainer.kz | WhatsApp +7 701 000 00 00", {"sales@kontainer.kz"}),
        ("Отдел логистики Mailoffice@pel.kz", {"office@pel.kz"}),
        ("Пишите: E-MAILzakaz.almaty@sklad-servis.kz", {"zakaz.almaty@sklad-servis.kz"}),
        ("Директор: Нурланов А. E-maila.nurlanov@kontainer.kz", {"a.nurlanov@kontainer.kz"}),
        ("E-mailivanov@kontainer.kz", {"ivanov@kontainer.kz"}),
        ("Почтаinfo@erdaholding.com", {"info@erdaholding.com"}),
        ("Эл. почта:info@erdaholding.com", {"info@erdaholding.com"}),
        ("эл.почтаsales@erdaholding.com", {"sales@erdaholding.com"}),
        ("e‑mailinfo@pel.kz", {"info@pel.kz"}),  # неразрывный дефис: подпись «mail»
        # Тот же адрес есть на странице отдельно: склеенный вариант не нужен.
        ("Mailbuhgalter2@pel.kz, mailmaksat@pel.kz, maksat@pel.kz", {"buhgalter2@pel.kz", "maksat@pel.kz"}),
    ],
)
def test_extract_emails_strips_glued_label(text, expected):
    assert extract_emails(text) == expected


@pytest.mark.parametrize(
    "email",
    ["mailbox@pel.kz", "mailer@pel.kz", "email@pel.kz", "mail@pel.kz", "e-mail@pel.kz", "emailme@pel.kz",
     "mail.info@pel.kz", "email-1@pel.kz", "mailtech@pel.kz"],
)
def test_real_addresses_that_start_with_mail_are_kept(email):
    assert extract_emails(f"Почта: {email}") == {email}


def test_extract_emails_from_realistic_page_matches_db_check():
    page = """
    <footer>
      <p>ТОО «Пэл Казахстан», г. Алматы, пр. Абая 10</p>
      <p>Отдел продаж: <a href="mailto:Sales@Pel.kz">Sales@Pel.kz</a></p>
      <p>Бухгалтерия: buh [at] pel [dot] kz</p>
      <img src="/upload/logo@2x.png"><script src="https://cdn.kz/jquery@3.6.0.min.js"></script>
      <script>Sentry.init({dsn: "https://0a1b2c3d@o99.ingest.sentry.io/1"})</script>
    </footer>
    """

    emails = extract_emails(page)

    assert emails == {"sales@pel.kz", "buh@pel.kz"}
    for email in emails:
        assert email == email.lower()
        assert PG_EMAIL.match(email)
        assert len(email) <= 254


# --- is_role_address ---


@pytest.mark.parametrize(
    "email",
    [
        "info@pel.kz",
        "Sales@pel.kz",
        "office@astana-motors.kz",
        "admin@pel.kz",
        "support@pel.kz",
        "hello@pel.kz",
        "contact@pel.kz",
        "contacts@pel.kz",
        "mail@pel.kz",
        "zakaz@kontainer.kz",
        "order@pel.kz",
        "reception@pel.kz",
        "priem@pel.kz",
        "buh@pel.kz",
        "hr@pel.kz",
        "marketing@pel.kz",
        "info.almaty@pel.kz",
        "sales2@pel.kz",
        "sales_kz@pel.kz",
        "info+site@pel.kz",
        "no-reply@pel.kz",
    ],
)
def test_is_role_address(email):
    assert is_role_address(email)


@pytest.mark.parametrize(
    "email",
    [
        "a.nurlanov@pel.kz",
        "aigerim@kontainer.kz",
        "d.sadykov@astana-motors.kz",
        "87017771234@mail.ru",
        "ivan.info@pel.kz",
        "informatika@school.kz",
        "salesmanager@pel.kz",
        "not-an-email",
        "",
    ],
)
def test_is_not_role_address(email):
    assert not is_role_address(email)


# --- pick_pages: виды страниц ---

HOME_LINKS = [
    ("/", "Главная"),
    ("/news/2025", "Новости"),
    ("/catalog/nasosy", "Каталог"),
    ("/o-nas/", "О нас"),
    ("/kontakty", "Контакты"),
    ("https://www.pel.kz/rekvizity", "Реквизиты"),
    ("/sklady", "Наши склады"),
    ("/vakansii", "Вакансии"),
    ("https://instagram.com/pel_kz", "Instagram"),
    ("mailto:info@pel.kz", "info@pel.kz"),
    ("tel:+77272000000", "Позвонить"),
    ("javascript:void(0)", "Контакты"),
    ("/upload/price-kontakty.pdf", "Прайс и контакты"),
    ("/kontakty#map", "Карта проезда"),
    ("/#contacts", "Контакты"),
]


def test_page_kinds_are_in_reading_order_with_russian_labels():
    assert list(PAGE_KINDS) == ["home", "about", "services", "logistics", "vacancies", "contacts", "other"]
    assert PAGE_KINDS["home"] == "Главная"
    assert PAGE_KINDS["about"] == "О компании"
    assert PAGE_KINDS["services"] == "Услуги и продукция"
    assert PAGE_KINDS["logistics"] == "Склады, филиалы, доставка"
    assert PAGE_KINDS["vacancies"] == "Вакансии"
    assert PAGE_KINDS["contacts"] == "Контакты"


def test_pick_pages_one_per_kind_contacts_first():
    assert pick_pages("https://pel.kz/", HOME_LINKS) == [
        ("https://pel.kz/kontakty", "contacts"),
        ("https://pel.kz/o-nas/", "about"),
        ("https://pel.kz/catalog/nasosy", "services"),
        ("https://pel.kz/sklady", "logistics"),
        ("https://pel.kz/vakansii", "vacancies"),
    ]


def test_pick_pages_priority_does_not_depend_on_link_order():
    links = [("/vacancy", ""), ("/delivery", ""), ("/services", ""), ("/about", ""), ("/contacts", "")]

    assert [kind for _, kind in pick_pages("https://pel.kz", links)] == [
        "contacts", "about", "services", "logistics", "vacancies",
    ]


def test_pick_pages_limit_keeps_highest_priority():
    assert pick_pages("https://pel.kz/", HOME_LINKS, limit=2) == [
        ("https://pel.kz/kontakty", "contacts"),
        ("https://pel.kz/o-nas/", "about"),
    ]
    assert pick_pages("https://pel.kz/", HOME_LINKS, limit=0) == []
    assert len(pick_pages("https://pel.kz/", HOME_LINKS)) == 5


@pytest.mark.parametrize(
    ("href", "text", "kind"),
    [
        ("/page/12", "О компании", "about"),
        ("/ru/o-kompanii", "", "about"),
        ("/company", "Company", "about"),
        ("http://pel.kz/ru/about-us", "", "about"),
        ("/kz/biz-turaly", "Біз туралы", "about"),
        ("/uslugi", "", "services"),
        ("/ru/services/", "", "services"),
        ("/%D1%83%D1%81%D0%BB%D1%83%D0%B3%D0%B8", "", "services"),
        ("/produkciya", "Продукция", "services"),
        ("/products/racks", "", "services"),
        ("/katalog", "", "services"),
        ("/resheniya", "Решения", "services"),
        ("/solutions/rfid", "", "services"),
        ("/kz/kyzmetter", "Қызметтер", "services"),
        ("/sklad", "", "logistics"),
        ("/warehouse", "", "logistics"),
        ("/logistika", "", "logistics"),
        ("/dostavka-i-oplata", "Доставка и оплата", "logistics"),
        ("/delivery", "", "logistics"),
        ("/filialy", "Филиалы", "logistics"),
        ("/company/branches", "", "logistics"),
        ("/adresa-magazinov", "Адреса магазинов", "logistics"),
        ("/page/7", "Наши магазины", "logistics"),
        ("/obekty", "Наши объекты", "logistics"),
        ("/stores", "", "logistics"),
        ("/vakansii", "", "vacancies"),
        ("/karera", "Карьера", "vacancies"),
        ("/career", "", "vacancies"),
        ("/jobs", "", "vacancies"),
        ("/rabota-u-nas", "Работа у нас", "vacancies"),
        ("/company/vacancy", "", "vacancies"),
        ("/vakansii/kladovshchik-na-sklad", "", "vacancies"),
        ("/kz/bos-zhumys-oryndary", "Бос жұмыс орындары", "vacancies"),
        ("/kontakty", "", "contacts"),
        ("/%D0%BA%D0%BE%D0%BD%D1%82%D0%B0%D0%BA%D1%82%D1%8B", "", "contacts"),
        ("/kz/bailanys", "Байланыс", "contacts"),
        ("/index.php?route=information/contact", "", "contacts"),
        ("/rekvizity", "Реквизиты", "contacts"),
        ("https://almaty.pel.kz/contacts", "Филиал в Алматы", "contacts"),
    ],
)
def test_pick_pages_recognises_kind(href, text, kind):
    pages = pick_pages("https://pel.kz/", [(href, text)])

    assert [found for _, found in pages] == [kind]


@pytest.mark.parametrize(
    ("href", "text"),
    [
        ("/nasosy", "О насосах"),
        ("/news/2025", "Новости"),
        ("/blog/rfid-v-ritejle", "Блог"),
        ("https://notpel.kz/contacts", "Контакты"),
        ("https://pel.kz.evil.com/contacts", "Контакты"),
        ("https://instagram.com/pel_kz", "Контакты"),
        ("https://hh.kz/employer/123", "Вакансии"),
        ("/files/rekvizity.docx", "Реквизиты"),
        ("/img/sklad.jpg", "Склад"),
        ("mailto:info@pel.kz", "Контакты"),
        ("tel:+77272000000", "Контакты"),
        ("#contacts", "Контакты"),
        ("", "Контакты"),
    ],
)
def test_pick_pages_skips(href, text):
    assert pick_pages("https://pel.kz/", [(href, text)]) == []


def test_pick_pages_takes_section_not_deep_link():
    links = [("/uslugi/montazh-stellazhey", "Монтаж стеллажей"), ("/uslugi", "Услуги"), ("/uslugi/arenda", "Аренда")]

    assert pick_pages("https://pel.kz/", links) == [("https://pel.kz/uslugi", "services")]


def test_pick_pages_same_page_is_taken_once():
    links = [
        ("/contacts", "Контакты"),
        ("/contacts/", "Контакты"),
        ("https://www.pel.kz/contacts#top", "Контакты"),
        ("/page/5", "Вакансии"),
        ("/page/5", "О компании"),
    ]

    assert pick_pages("https://pel.kz/", links) == [
        ("https://pel.kz/contacts", "contacts"),
        ("https://pel.kz/page/5", "about"),
    ]


def test_pick_pages_resolves_relative_to_base_path():
    assert pick_pages("https://www.pel.kz/ru/", [("contacts", "Контакты")]) == [
        ("https://www.pel.kz/ru/contacts", "contacts"),
    ]


# --- SiteCrawl.text ---

LONG = "Склады в Алматы и Астане, инвентаризация раз в квартал. " * 200


def test_site_text_sections_in_reading_order_with_labels():
    pages = (
        PageText(url="https://pel.kz/", text="Главная."),
        PageText(url="https://pel.kz/kontakty", text="info@pel.kz", kind="contacts"),
        PageText(url="https://pel.kz/o-nas", text="О компании.", kind="about"),
        PageText(url="https://pel.kz/uslugi", text="Услуги.", kind="services"),
        PageText(url="https://pel.kz/sklady", text="Склады.", kind="logistics"),
        PageText(url="https://pel.kz/vakansii", text="Кладовщик.", kind="vacancies"),
    )

    text = SiteCrawl(start_url="https://pel.kz", pages=pages).text

    headers = [line for line in text.splitlines() if line.startswith("[")]
    assert headers == [
        "[Главная] https://pel.kz/",
        "[О компании] https://pel.kz/o-nas",
        "[Услуги и продукция] https://pel.kz/uslugi",
        "[Склады, филиалы, доставка] https://pel.kz/sklady",
        "[Вакансии] https://pel.kz/vakansii",
        "[Контакты] https://pel.kz/kontakty",
    ]
    assert text.startswith("[Главная] https://pel.kz/\nГлавная.")


def test_site_text_fits_limit_and_keeps_short_pages_whole():
    pages = (
        PageText(url="https://pel.kz/", text=LONG[:MAX_PAGE_TEXT_CHARS]),
        PageText(url="https://pel.kz/kontakty", text="Алматы, пр. Абая 10. info@pel.kz", kind="contacts"),
        PageText(url="https://pel.kz/o-nas", text=LONG[:MAX_PAGE_TEXT_CHARS], kind="about"),
        PageText(url="https://pel.kz/uslugi", text=LONG[:MAX_PAGE_TEXT_CHARS], kind="services"),
        PageText(url="https://pel.kz/sklady", text=LONG[:MAX_PAGE_TEXT_CHARS], kind="logistics"),
        PageText(url="https://pel.kz/vakansii", text="Требуется кладовщик.", kind="vacancies"),
    )

    text = SiteCrawl(start_url="https://pel.kz", pages=pages).text

    assert MAX_SITE_TEXT_CHARS - 200 < len(text) <= MAX_SITE_TEXT_CHARS
    assert "Алматы, пр. Абая 10. info@pel.kz" in text
    assert "Требуется кладовщик." in text
    assert text.count("…") == 4


def test_site_limits():
    assert MAX_SITE_TEXT_CHARS == 9000
    assert MAX_PAGE_TEXT_CHARS == 2500
    assert sites.SITE_TIMEOUT_S == 60


def test_site_text_unknown_kind_goes_last_as_other():
    pages = (
        PageText(url="https://pel.kz/x", text="Что-то", kind="news"),
        PageText(url="https://pel.kz/", text="Главная"),
    )

    text = SiteCrawl(start_url="https://pel.kz", pages=pages).text

    assert text == "[Главная] https://pel.kz/\nГлавная\n\n[Другая страница] https://pel.kz/x\nЧто-то"


def test_site_text_skips_empty_pages():
    pages = (
        PageText(url="https://pel.kz/", text="Коротко о нас"),
        PageText(url="https://pel.kz/x", text="", kind="about"),
    )

    assert SiteCrawl(start_url="https://pel.kz", pages=pages).text == "[Главная] https://pel.kz/\nКоротко о нас"


def test_site_text_empty_without_pages():
    assert SiteCrawl(start_url="https://pel.kz", pages=(), emails=frozenset(), error="ошибка").text == ""


# --- crawl_site с фейковым crawl4ai ---


def page_result(url, *, html="", markdown="", internal=(), success=True, error=None, redirected_url=None, status=200):
    """Похоже на CrawlResult crawl4ai: success, error_message, status_code, html, markdown, links, redirected_url."""
    return SimpleNamespace(
        url=url,
        success=success,
        status_code=status,
        error_message=error,
        html=html,
        markdown=SimpleNamespace(raw_markdown=markdown, fit_markdown=""),
        links={"internal": [{"href": href, "text": text} for href, text in internal], "external": []},
        redirected_url=redirected_url or url,
    )


class FakeCrawler:
    """Тот же асинхронный интерфейс, что у AsyncWebCrawler: async with и arun."""

    def __init__(self, results, *, fail_on_enter=False, delays=None):
        self.results = results
        self.fail_on_enter = fail_on_enter
        self.delays = delays or {}
        self.calls: list[str] = []
        self.configs: list = []
        self.entered = 0
        self.exited = 0

    async def __aenter__(self):
        self.entered += 1
        if self.fail_on_enter:
            raise RuntimeError("Executable doesn't exist at .browsers\\chromium\\chrome.exe")
        return self

    async def __aexit__(self, *exc_info):
        self.exited += 1
        return False

    async def arun(self, url, config=None):
        self.calls.append(url)
        self.configs.append(config)
        if url in self.delays:
            await asyncio.sleep(self.delays[url])
        result = self.results.get(url)
        if result is None:
            return page_result(url, success=False, error="net::ERR_NAME_NOT_RESOLVED")
        return result


PEL_DNS = {
    "pel.kz": [PUBLIC_IP],
    "www.pel.kz": [PUBLIC_IP],
    "intranet.pel.kz": ["10.0.0.7"],
}


def run_crawl(url, crawler, **kwargs):
    kwargs.setdefault("resolver", fake_resolver(PEL_DNS))
    return asyncio.run(crawl_site(url, crawler_factory=lambda: crawler, **kwargs))


def pel_site():
    return {
        "https://pel.kz": page_result(
            "https://pel.kz",
            html='<a href="mailto:Sales@Pel.kz">Отдел продаж</a> <img src="logo@2x.png">',
            markdown="# Пэл\nНасосы для складов и производств.",
            internal=[("https://pel.kz/kontakty", "Контакты"), ("https://pel.kz/catalog", "Каталог")],
        ),
        "https://pel.kz/kontakty": page_result(
            "https://pel.kz/kontakty",
            html="<p>Алматы</p>",
            markdown="Бухгалтерия: buh [at] pel [dot] kz",
        ),
        "https://pel.kz/catalog": page_result("https://pel.kz/catalog", markdown="Насосы Grundfos со склада."),
    }


def test_crawl_site_fetches_homepage_and_key_pages():
    crawler = FakeCrawler(pel_site())

    crawl = run_crawl("pel.kz", crawler)

    assert crawl.error is None
    assert crawl.start_url == "https://pel.kz"
    assert crawler.calls == ["https://pel.kz", "https://pel.kz/kontakty", "https://pel.kz/catalog"]
    assert [(page.url, page.kind) for page in crawl.pages] == [
        ("https://pel.kz", "home"),
        ("https://pel.kz/kontakty", "contacts"),
        ("https://pel.kz/catalog", "services"),
    ]
    assert crawl.pages[0].text == "# Пэл\nНасосы для складов и производств."
    assert crawl.emails == frozenset({"sales@pel.kz", "buh@pel.kz"})
    assert crawler.entered == crawler.exited == 1


def test_crawl_site_default_is_home_plus_five_kinds():
    kinds = {
        "kontakty": "Контакты", "o-nas": "О нас", "uslugi": "Услуги", "sklady": "Склады",
        "vakansii": "Вакансии", "rekvizity": "Реквизиты", "dostavka": "Доставка",
    }
    results = {
        f"https://pel.kz/{slug}": page_result(f"https://pel.kz/{slug}", markdown=f"{label}. hr@pel.kz")
        for slug, label in kinds.items()
    }
    results["https://pel.kz"] = page_result(
        "https://pel.kz", markdown="Главная", internal=[(f"/{slug}", label) for slug, label in kinds.items()]
    )
    crawler = FakeCrawler(results)

    crawl = run_crawl("https://pel.kz", crawler)

    assert crawler.calls == [
        "https://pel.kz",
        "https://pel.kz/kontakty",
        "https://pel.kz/o-nas",
        "https://pel.kz/uslugi",
        "https://pel.kz/sklady",
        "https://pel.kz/vakansii",
    ]
    assert [page.kind for page in crawl.pages] == ["home", "contacts", "about", "services", "logistics", "vacancies"]
    assert crawl.emails == frozenset({"hr@pel.kz"})
    assert crawl.text.index("[О компании]") < crawl.text.index("[Вакансии]") < crawl.text.index("[Контакты]")


def test_crawl_site_bypasses_cache_and_passes_timeout():
    crawler = FakeCrawler(pel_site())

    run_crawl("https://pel.kz", crawler, page_timeout_ms=15_000)

    config = crawler.configs[0]
    assert config.cache_mode == sites.CacheMode.BYPASS
    assert config.page_timeout == 15_000
    assert not config.screenshot and not config.pdf
    assert all(c is config for c in crawler.configs)


def test_crawl_site_skips_non_public_link():
    results = pel_site()
    results["https://pel.kz"] = page_result(
        "https://pel.kz",
        markdown="Главная",
        internal=[("https://intranet.pel.kz/contacts", "Контакты"), ("https://pel.kz/kontakty", "Контакты")],
    )
    crawler = FakeCrawler(results)

    crawl = run_crawl("https://pel.kz", crawler)

    assert "https://intranet.pel.kz/contacts" not in crawler.calls
    assert crawler.calls == ["https://pel.kz", "https://pel.kz/kontakty"]
    assert crawl.emails == frozenset({"buh@pel.kz"})


def test_crawl_site_takes_next_link_of_same_kind_when_page_is_broken():
    results = {
        "https://pel.kz": page_result(
            "https://pel.kz",
            markdown="Главная",
            internal=[("https://pel.kz/contacts", "Контакты"), ("https://pel.kz/rekvizity", "Реквизиты")],
        ),
        "https://pel.kz/contacts": page_result("https://pel.kz/contacts", markdown="Страница не найдена", status=404),
        "https://pel.kz/rekvizity": page_result("https://pel.kz/rekvizity", markdown="БИН 123, buh@pel.kz"),
    }
    crawler = FakeCrawler(results)

    crawl = run_crawl("https://pel.kz", crawler)

    assert crawler.calls == ["https://pel.kz", "https://pel.kz/contacts", "https://pel.kz/rekvizity"]
    assert [(page.url, page.kind) for page in crawl.pages] == [
        ("https://pel.kz", "home"),
        ("https://pel.kz/rekvizity", "contacts"),
    ]
    assert "не найдена" not in crawl.text
    assert crawl.emails == frozenset({"buh@pel.kz"})


def test_crawl_site_next_kind_moves_up_when_page_fails():
    results = {
        "https://pel.kz": page_result(
            "https://pel.kz",
            markdown="Главная",
            internal=[("https://pel.kz/kontakty", "Контакты"), ("https://pel.kz/o-nas", "О нас"),
                      ("https://pel.kz/vakansii", "Вакансии")],
        ),
        "https://pel.kz/o-nas": page_result("https://pel.kz/o-nas", markdown="О компании"),
        "https://pel.kz/vakansii": page_result("https://pel.kz/vakansii", markdown="Кладовщик"),
    }
    crawler = FakeCrawler(results)

    crawl = run_crawl("https://pel.kz", crawler, max_pages=3)

    assert crawler.calls == ["https://pel.kz", "https://pel.kz/kontakty", "https://pel.kz/o-nas", "https://pel.kz/vakansii"]
    assert [page.kind for page in crawl.pages] == ["home", "about", "vacancies"]


def test_crawl_site_homepage_with_http_error_is_an_error():
    results = {"https://pel.kz": page_result("https://pel.kz", markdown="403 Forbidden", status=403)}

    crawl = run_crawl("https://pel.kz", FakeCrawler(results))

    assert crawl.error and "403" in crawl.error
    assert crawl.pages == ()


def test_crawl_site_drops_page_redirected_to_private_address():
    results = pel_site()
    results["https://pel.kz/kontakty"] = page_result(
        "https://pel.kz/kontakty", markdown="secret@intranet.pel.kz", redirected_url="http://intranet.pel.kz/"
    )
    crawler = FakeCrawler(results)

    crawl = run_crawl("https://pel.kz", crawler)

    assert crawl.error is None
    assert [page.url for page in crawl.pages] == ["https://pel.kz", "https://pel.kz/catalog"]
    assert crawl.emails == frozenset({"sales@pel.kz"})


def test_crawl_site_uses_final_url_after_redirect():
    results = {
        "https://pel.kz": page_result(
            "https://pel.kz",
            markdown="Главная",
            internal=[("https://www.pel.kz/kontakty", "Контакты")],
            redirected_url="https://www.pel.kz/",
        ),
        "https://www.pel.kz/kontakty": page_result("https://www.pel.kz/kontakty", markdown="info@pel.kz"),
    }
    crawler = FakeCrawler(results)

    crawl = run_crawl("pel.kz", crawler)

    assert [page.url for page in crawl.pages] == ["https://www.pel.kz/", "https://www.pel.kz/kontakty"]
    assert crawl.emails == frozenset({"info@pel.kz"})


def test_crawl_site_homepage_redirected_to_private_address():
    results = {"https://pel.kz": page_result("https://pel.kz", markdown="x", redirected_url="http://127.0.0.1:8080/")}

    crawl = run_crawl("https://pel.kz", FakeCrawler(results))

    assert crawl.error
    assert crawl.pages == ()
    assert crawl.emails == frozenset()


def test_crawl_site_reports_crawler_failure():
    failed = page_result("https://pel.kz", success=False, error="Unexpected error\nCode context:\n...")

    crawl = run_crawl("https://pel.kz", FakeCrawler({"https://pel.kz": failed}))

    assert crawl.error and "Unexpected error" in crawl.error
    assert "Code context" not in crawl.error
    assert crawl.pages == ()
    assert crawl.emails == frozenset()


def test_crawl_site_reports_browser_start_failure():
    crawl = run_crawl("https://pel.kz", FakeCrawler({}, fail_on_enter=True))

    assert crawl.error and "chrome.exe" in crawl.error
    assert crawl.pages == ()


def test_crawl_site_survives_exception_from_arun():
    class Exploding(FakeCrawler):
        async def arun(self, url, config=None):
            raise RuntimeError("browser crashed")

    crawl = run_crawl("https://pel.kz", Exploding({}))

    assert crawl.error and "browser crashed" in crawl.error


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1:5432", "http://localhost:8080/v0/check_email", "https://intranet.pel.kz", "nosuch.kz", "", "ftp://pel.kz"],
)
def test_crawl_site_refuses_non_public_without_starting_browser(url):
    crawler = FakeCrawler(pel_site())
    created = []

    def factory():
        created.append(crawler)
        return crawler

    crawl = asyncio.run(crawl_site(url, crawler_factory=factory, resolver=fake_resolver(PEL_DNS)))

    assert crawl.error
    assert crawl.pages == ()
    assert created == []


def test_crawl_site_refuses_social_network():
    crawler = FakeCrawler({})

    crawl = run_crawl("https://www.instagram.com/pel_kz/", crawler, resolver=resolve_everything_public)

    assert crawl.error
    assert crawler.entered == 0


def test_crawl_site_respects_max_pages():
    results = pel_site()
    results["https://pel.kz"] = page_result(
        "https://pel.kz",
        markdown="Главная",
        internal=[("https://pel.kz/kontakty", "Контакты"), ("https://pel.kz/o-nas", "О нас"), ("/about", "")],
    )
    crawler = FakeCrawler(results)

    run_crawl("https://pel.kz", crawler, max_pages=2)

    assert crawler.calls == ["https://pel.kz", "https://pel.kz/kontakty"]
    crawler_single = FakeCrawler(results)
    run_crawl("https://pel.kz", crawler_single, max_pages=1)
    assert crawler_single.calls == ["https://pel.kz"]


def test_crawl_site_caps_page_text():
    results = {"https://pel.kz": page_result("https://pel.kz", markdown="Склад. " * 2000)}

    crawl = run_crawl("https://pel.kz", FakeCrawler(results))

    assert len(crawl.pages[0].text) <= MAX_PAGE_TEXT_CHARS


def test_crawl_site_accepts_plain_string_markdown():
    result = page_result("https://pel.kz")
    result.markdown = "Просто текст, info@pel.kz"

    crawl = run_crawl("https://pel.kz", FakeCrawler({"https://pel.kz": result}))

    assert crawl.pages[0].text == "Просто текст, info@pel.kz"
    assert crawl.emails == frozenset({"info@pel.kz"})


def test_crawl_site_keeps_homepage_when_site_budget_runs_out(monkeypatch):
    monkeypatch.setattr(sites, "SITE_TIMEOUT_S", 0.2)
    crawler = FakeCrawler(pel_site(), delays={"https://pel.kz/kontakty": 5})

    crawl = run_crawl("https://pel.kz", crawler)

    assert crawl.error is None
    assert [page.url for page in crawl.pages] == ["https://pel.kz"]


def test_crawl_site_homepage_timeout_is_an_error(monkeypatch):
    monkeypatch.setattr(sites, "SITE_TIMEOUT_S", 0.1)
    crawler = FakeCrawler(pel_site(), delays={"https://pel.kz": 5})

    crawl = run_crawl("https://pel.kz", crawler)

    assert crawl.error
    assert crawl.pages == ()


# --- защита браузера от запросов на локальные адреса ---


class FakeRoute:
    def __init__(self, url, resource_type="document"):
        self.request = SimpleNamespace(url=url, resource_type=resource_type)
        self.outcome = None

    async def fallback(self):
        self.outcome = "fallback"

    async def abort(self, error_code=None):
        self.outcome = "abort"


@pytest.mark.parametrize(
    ("url", "resource_type", "outcome"),
    [
        ("https://pel.kz/kontakty", "document", "fallback"),
        ("https://pel.kz/app.js", "script", "fallback"),
        ("https://pel.kz/logo.png", "image", "abort"),
        ("https://pel.kz/font.woff2", "font", "abort"),
        ("http://127.0.0.1:8080/v0/check_email", "fetch", "abort"),
        ("http://localhost:5432/", "xhr", "abort"),
        ("https://intranet.pel.kz/", "document", "abort"),
    ],
)
def test_guard_request(monkeypatch, url, resource_type, outcome):
    resolver = fake_resolver(PEL_DNS)
    original = sites.is_public_url
    monkeypatch.setattr(sites, "is_public_url", lambda u: original(u, resolver=resolver))
    route = FakeRoute(url, resource_type)

    asyncio.run(sites._guard_request(route))

    assert route.outcome == outcome


def test_default_crawler_is_headless_with_guard():
    crawler = sites._default_crawler()

    assert crawler.browser_config.headless is True
    assert crawler.browser_config.accept_downloads is False
    assert crawler.crawler_strategy.hooks["on_page_context_created"] is sites._guard_page


def test_http_link_from_2gis_is_tried_over_https_first():
    crawler = FakeCrawler(pel_site())

    crawl = run_crawl("http://pel.kz", crawler)

    assert crawl.error is None
    assert crawl.start_url == "https://pel.kz"
    assert crawler.calls[0] == "https://pel.kz"


def test_http_is_kept_when_https_does_not_open():
    site = {"http://pel.kz": page_result("http://pel.kz", markdown="Только http.")}
    crawler = FakeCrawler(site)

    crawl = run_crawl("http://pel.kz", crawler)

    assert crawl.error is None
    assert crawler.calls == ["https://pel.kz", "http://pel.kz"]
    assert crawl.pages[0].text == "Только http."


def test_nat64_addresses_are_not_public():
    resolver = fake_resolver({"nat.example.kz": ["64:ff9b::7f00:1"]})

    assert not is_public_url("https://nat.example.kz/", resolver=resolver)
