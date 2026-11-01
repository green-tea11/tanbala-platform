"""Показ интерфейса на выдуманных данных: схема ui_demo, порт 8002, поддельный запуск.

    .venv/Scripts/python.exe scripts/ui_demo.py

Схема ui_demo пересоздаётся при каждом старте. Схему public скрипт не трогает: у каждого соединения
search_path=ui_demo, и перед записью это проверяется. Поддельный запуск только двигает счётчики
в ui_demo.runs и добавляет выдуманные компании: ни 2ГИС, ни сайтов, ни Claude API, ни Reacher.
"""

from __future__ import annotations

import sys
import threading
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

import psycopg
import uvicorn
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tanbala_leads import contact_policy, db, pipeline  # noqa: E402
from tanbala_leads.settings import load_settings  # noqa: E402
from tanbala_leads.steps import send  # noqa: E402
from tanbala_leads.web.app import create_app  # noqa: E402

SCHEMA = "ui_demo"
HOST = "127.0.0.1"
PORT = 8002  # 8000 и 8001 заняты настоящим сервером: API и интерфейс
FAKE_STEP_SECONDS = 3.0

SIGNATURE = "С уважением,\nАрман"
CHECKS_OK = [
    {"name": name, "passed": True, "details": []}
    for name in ("dashes", "colons", "semicolons", "prices", "stop_words", "links", "length", "signature", "notes",
                 "jargon", "style", "contacts")
]


def checks_with(failed: dict[str, list[str]]) -> list[dict]:
    return [{**check, "passed": check["name"] not in failed, "details": failed.get(check["name"], [])}
            for check in CHECKS_OK]


# (имя, рубрика, адрес, сайт, статус, оценка, fit, сегмент, причина, почты, письмо, ошибка)
COMPANIES = [
    ("ТОО «Степь Склад Сервис»", "Складские услуги", "Алматы, ул. Бекмаханова, 93", "step-sklad.example.kz",
     "drafted", 86, "yes", "склады 3PL",
     "Ответственное хранение на 12 000 паллетомест, клиенты из ритейла. Инвентаризация вручную, на сайте вакансия "
     "кладовщика на пересчёт остатков. RFID сократит инвентаризацию с дней до часов.",
     [("info@step-sklad.example.kz", "/kontakty", "safe", False, True),
      ("sales@step-sklad.example.kz", "/", "risky", True, True)],
     ("Инвентаризация 12 000 паллетомест за часы",
      "[Проверить: число паллетомест взято с главной страницы сайта, уточнить актуальность]\n"
      "[Проверить: на этот адрес и в эту компанию раньше не писали]\n"
      "Здравствуйте!\n\nПишу по поводу ответственного хранения на Бекмаханова. На вашем сайте видно, что остатки "
      "пересчитывают вручную. Мы ставим RFID-метки на паллеты и считываем весь склад за один проход с ручным "
      "считывателем. Обычно инвентаризация, которая занимала два дня, проходит за 3–4 часа. Можем показать на "
      "одном ряду стеллажей у вас, без оплаты. Удобно ли созвониться на этой неделе?\n\n" + SIGNATURE,
      checks_with({"dashes": ["тире: «–» в «…проходит за 3–4 часа. Можем…»"]})), None),
    ("ТОО «Жетысу Логистик»", "Грузоперевозки, логистика", "Алматы, Илийский тракт, 20/1", "zhetysu-log.example.kz",
     "drafted", 74, "yes", "логистика",
     "Кросс-докинг и доставка по Казахстану. Возвратная тара (паллеты, контейнеры) теряется между точками. "
     "Отслеживание тары по RFID на воротах.",
     [("office@zhetysu-log.example.kz", "/about", "safe", False, True)],
     ("Где ваши паллеты после отгрузки",
      "[Ответить лично: в письме обращение по имени из 2ГИС, проверить имя]\n"
      "Здравствуйте, Ержан!\n\nУвидел, что вы работаете с возвратной тарой между Алматы и Астаной. Часто паллеты "
      "и контейнеры теряются на чужих складах, и это прямые потери. RFID-метка на таре и считыватель на воротах "
      "показывают, где каждая единица и кто её не вернул. Внедрение начинается с одних ворот. Расскажу подробнее "
      "за 15 минут, когда вам удобно?\n\n" + SIGNATURE,
      checks_with({"stop_words": ["стоп-слово: «за 15 минут» в «…подробнее за 15 минут, когда…»"]})), None),
    ("ТОО «Алтын Тара Пласт»", "Оборотная тара, производство", "Алматы, ул. Казыбаева, 26", "altyn-tara.example.kz",
     "drafted", 79, "yes", "оборотная тара",
     "Производят и сдают в аренду пластиковые ящики сетям. Ящики не возвращаются из магазинов, учёт в Excel.",
     [("sales@altyn-tara.example.kz", "/contacts", "safe", False, True)],
     ("Сколько ящиков не вернулось из магазинов",
      "[Проверить: что аренда ящиков сетям есть на сайте, а не только производство]\n"
      "Здравствуйте!\n\nВы сдаёте ящики в аренду сетям, и часть из них не возвращается. RFID-метка на ящике и "
      "считыватель на воротах склада показывают, сколько ящиков ушло к каждой сети и сколько вернулось. Сверка "
      "занимает минуты, а не дни в Excel. Можем начать с одной партии ящиков. Интересно обсудить?\n\n" + SIGNATURE,
      CHECKS_OK), None),
    ("ТОО «Медикал Сток»", "Медицинский склад", "Алматы, ул. Жансугурова, 112", "med-stock.example.kz",
     "drafted", 72, "maybe", "медицинский склад",
     "Склад медизделий с учётом сроков годности. RFID поможет видеть партии и сроки без пересчёта.",
     [("info@med-stock.example.kz", "/", "risky", True, True)],
     ("Сроки годности без пересчёта коробок",
      "Здравствуйте!\n\nУ медицинского склада главная боль: партии и сроки годности. RFID-метки на коробках "
      "читаются без вскрытия, и список партий с датами собирается за один обход. Можем показать на одной "
      "стойке. Позвоните, когда удобно: +7 701 000 00 00.\n\n" + SIGNATURE,
      checks_with({"contacts": ["чужой номер: «+7 701 000 00 00»"], "length": ["5 предложений, нужно от 5 до 8"]})),
     None),
    ("ТОО «Kaz Textile Group»", "Магазин одежды", "Алматы, пр. Абая, 44", "kaztextile.example.kz",
     "approved", 81, "yes", "ритейл одежды",
     "Сеть из 6 магазинов одежды, единый склад. RFID-метки на одежде ускоряют инвентаризацию и защищают от краж.",
     [("hello@kaztextile.example.kz", "/contacts", "safe", False, True)],
     ("Инвентаризация шести магазинов за вечер",
      "Здравствуйте!\n\nУ вас шесть магазинов и общий склад на Абая. В рознице одежды RFID-метки на бирках "
      "позволяют пересчитать магазин за час и видеть, каких размеров не хватает в зале. Это же защищает от краж "
      "на выходе. Можем начать с одного магазина и сравнить с вашей текущей инвентаризацией. Интересно?\n\n"
      + SIGNATURE, CHECKS_OK), None),
    ("ИП «Тара-Сервис»", "Оборотная тара", "Алматы, ул. Рыскулова, 57", None,
     "verified", 68, "maybe", "оборотная тара",
     "Аренда пластиковых ящиков для пищевых производств. Учёт возврата ящиков ведут в Excel.",
     [("tara.servis@mail.example.kz", "/", "unknown", None, False)], None, None),
    ("ТОО «Алатау Строй Инвест»", "Строительная компания", "Алматы, мкр. Алатау, 12", "alatau-stroy.example.kz",
     "qualified", 55, "maybe", "стройка",
     "Генподрядчик, 3 объекта. Инструмент и опалубка уходят между объектами. Вопрос, готовы ли платить за учёт.",
     [("tender@alatau-stroy.example.kz", "/tender", None, None, True)], None, None),
    ("ТОО «Медеу Фарм Дистрибьюшн»", "Фармацевтический склад", "Алматы, ул. Тимирязева, 15", "medeu-pharm.example.kz",
     "crawled", None, None, None, None,
     [("info@medeu-pharm.example.kz", "/", None, None, True)], None, None),
    ("ТОО «Береке Продукт»", "Производство продуктов питания", "Алматы, ул. Суюнбая, 263", "bereke.example.kz",
     "rejected", 18, "no", None,
     "Небольшой цех на 8 человек, продажи через 2 магазина. Для RFID слишком мало объёма.",
     [("bereke@mail.example.kz", "/", "invalid", None, False)], None, None),
    ("ТОО «Нур Авто Запчасти»", "Автозапчасти, склад", "Алматы, ул. Пятницкого, 104", "nur-avto.example.kz",
     "new", None, None, None, None, [], None, None),
    ("ТОО «Достык Ритейл <b>Плюс</b>»", "Магазин одежды", "Алматы, ТРЦ «Достык Плаза»", "javascript:alert(1)",
     "crawled", None, None, None, None, [], None,
     "Сайт не открылся: таймаут 30 с после 2 попыток"),
]
# Боли с цитатами (раздел 5 документа о Tanbala). verified: цитата найдена во входных данных.
PAINS = {
    "ТОО «Степь Склад Сервис»": [
        ("Инвентаризация занимает дни и отрывает людей", "инвентаризация раз в квартал, склад закрыт два дня", "site", True),
        ("Считают вручную или сканируют штрихкоды по одному", "вакансия: кладовщик, пересчёт остатков", "site", True),
        ("Цифры в 1С не сходятся с тем, что на полках", "расхождения остатков с учётной системой", "site", False),
    ],
    "ТОО «Жетысу Логистик»": [
        ("Тара уходит к партнёрам и не возвращается", "возвратная тара: паллеты и контейнеры между складами", "2gis", True),
        ("Трудно проверить, вся ли партия ушла на отгрузку", "кросс-докинг, отгрузка в день поступления", "site", False),
    ],
    "ТОО «Алтын Тара Пласт»": [
        ("Тара уходит к партнёрам и не возвращается", "аренда пластиковых ящиков торговым сетям", "site", True),
        ("Считают вручную или сканируют штрихкоды по одному", "учёт возврата ящиков ведётся в Excel", "site", True),
    ],
    "ТОО «Медикал Сток»": [
        ("Непонятно, что внутри коробок, пока их не вскроешь", "хранение медизделий в заводской упаковке", "2gis", False),
    ],
    "ТОО «Kaz Textile Group»": [
        ("Инвентаризация занимает дни и отрывает людей", "сеть из 6 магазинов, общий склад на Абая", "2gis", True),
    ],
}
SEARCH_QUERY = {
    "ТОО «Степь Склад Сервис»": "склад",
    "ТОО «Жетысу Логистик»": "логистика",
    "ТОО «Алтын Тара Пласт»": "оборотная тара",
    "ТОО «Kaz Textile Group»": "склад",
    "ИП «Тара-Сервис»": "оборотная тара",
    "ТОО «Алатау Строй Инвест»": "логистика",
    "ТОО «Медеу Фарм Дистрибьюшн»": "склад",
    "ТОО «Береке Продукт»": "склад",
    "ТОО «Медикал Сток»": "склад",
    "ТОО «Нур Авто Запчасти»": "оборотная тара",
    "ТОО «Достык Ритейл <b>Плюс</b>»": "оборотная тара",
}
SITE_TEXT = (
    "Ответственное хранение и комплектация заказов. Склад класса А, 12 000 паллетомест, температурный режим.\n"
    "Вакансия: кладовщик, пересчёт остатков, инвентаризация раз в квартал.\n"
    "<script>alert('этот текст с сайта должен показаться как текст')</script>\n"
)


def demo_connect(dsn: str) -> psycopg.Connection:
    conn = psycopg.connect(dsn, autocommit=True, connect_timeout=10, options=f"-c search_path={SCHEMA}")
    schema = conn.execute("SELECT current_schema()").fetchone()[0]
    if schema != SCHEMA:
        conn.close()
        raise RuntimeError(f"Ожидалась схема {SCHEMA}, а соединение смотрит в {schema}")
    return conn


def reset_schema(dsn: str) -> None:
    with psycopg.connect(dsn, autocommit=True, connect_timeout=10) as admin:
        admin.execute(f'DROP SCHEMA IF EXISTS "{SCHEMA}" CASCADE')
        admin.execute(f'CREATE SCHEMA "{SCHEMA}"')
    with demo_connect(dsn) as conn:
        db.migrate(conn)


def insert_run(conn, city: str, query: str, n: int, status: str, counters: dict, minutes_ago: int,
               error: str | None = None) -> int:
    row = conn.execute(
        "INSERT INTO runs (city, query, max_companies, status, stage, found, new_companies, crawled, qualified,"
        " rejected, verified, drafted, errors, error, created_at, started_at, finished_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,"
        " now() - make_interval(mins => %s), now() - make_interval(mins => %s),"
        " now() - make_interval(mins => %s) + interval '6 minutes') RETURNING id",
        (city, query, n, status, counters.get("stage"), counters.get("found", 0), counters.get("new", 0),
         counters.get("crawled", 0), counters.get("qualified", 0), counters.get("rejected", 0),
         counters.get("verified", 0), counters.get("drafted", 0), counters.get("errors", 0), error,
         minutes_ago, minutes_ago, minutes_ago),
    ).fetchone()
    return row[0]


def insert_company(conn, run_id: int, item: tuple, minutes_ago: int) -> None:
    (name, rubric, address, website, status, score, fit, segment, reason, contacts, draft, error) = item
    domain = website if website and website.endswith(".example.kz") else None
    company_id = conn.execute(
        "INSERT INTO companies (name, city, rubric, address, phones, website, website_domain, source_id, source_url,"
        " branches_count, site_text, status, last_error, run_id, search_query, created_at) VALUES (%s, 'almaty', %s,"
        " %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now() - make_interval(mins => %s)) RETURNING id",
        (name, rubric, address, ["+7 727 355 10 20", "+7 701 555 44 33"], website, domain,
         f"demo-{uuid.uuid4().hex[:12]}",
         f"https://2gis.kz/almaty/firm/demo{minutes_ago}", 1 if status != "approved" else 6,
         SITE_TEXT if website else None, status, error, run_id, SEARCH_QUERY.get(name), minutes_ago),
    ).fetchone()[0]
    if reason:
        pains = [{"pain": pain, "evidence": evidence, "source": source, "verified": verified}
                 for pain, evidence, source, verified in PAINS.get(name, [])]
        conn.execute("INSERT INTO qualifications (company_id, fit, score, reason, segment, model, pains)"
                     " VALUES (%s, %s, %s, %s, %s, 'claude-haiku-5-5', %s)",
                     (company_id, fit, score, reason, segment, Jsonb(pains)))
    contact_ids = []
    for email, page, verify, catch_all, role in contacts:
        contact_ids.append(conn.execute(
            "INSERT INTO contacts (company_id, email, source_page, verify_result, is_catch_all, is_role)"
            " VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (company_id, email, f"https://{website}{page}" if website else page, verify, catch_all, role),
        ).fetchone()[0])
    if draft:
        subject, body, checks = draft
        approved = status == "approved"
        conn.execute(
            "INSERT INTO drafts (company_id, contact_id, subject, body, model, check_result, review_status,"
            " approved_by, approved_at) VALUES (%s, %s, %s, %s, 'claude-haiku-5-5', %s, %s, %s, %s)",
            (company_id, contact_ids[0], subject, body, Jsonb(checks), "approved" if approved else "pending",
             "владелец" if approved else None, datetime.now(UTC) if approved else None),
        )
    for task, tokens_in, tokens_out in (("qualify", 3100, 240), ("first_email", 3600, 610)):
        if (task == "qualify" and reason) or (task == "first_email" and draft):
            conn.execute(
                "INSERT INTO llm_calls (task, model, run_id, company_id, input_tokens, output_tokens,"
                " cache_read_tokens, cache_write_tokens) VALUES (%s, 'claude-haiku-5-5', %s, %s, %s, %s, 2900, 0)",
                (task, run_id, company_id, tokens_in, tokens_out),
            )


def seed(dsn: str) -> None:
    with demo_connect(dsn) as conn:
        first = insert_run(conn, "almaty", "оборотная тара", 3, "failed",
                           {"stage": "Сайты", "found": 3, "new": 3, "crawled": 1, "errors": 1}, 60 * 26,
                           error="Сайт не открылся у 1 компании, запуск остановлен вручную")
        second = insert_run(conn, "almaty", "склад, логистика, оборотная тара", 4, "done",
                            {"stage": "Готово", "found": 10, "new": 9, "crawled": 8, "qualified": 5, "rejected": 2,
                             "verified": 4, "drafted": 3, "errors": 1}, 95)
        for index, item in enumerate(COMPANIES):
            insert_company(conn, second if index < 9 else first, item, 90 - index if index < 9 else 60 * 26 - index)
        conn.execute("INSERT INTO llm_calls (task, model, run_id, input_tokens, output_tokens)"
                     " VALUES ('check', 'claude-experimental-x', %s, 1200, 90)", (second,))
        seed_history(conn)
        seed_test_sends(conn)


TEST_TO = next(iter(send.TEST_RECIPIENTS))  # единственный разрешённый адрес, как в steps/send.py


def seed_test_sends(conn) -> None:
    """Две прошлые тестовые отправки первого письма: удачная и неудачная."""
    draft_id, real_to = conn.execute("SELECT d.id, c.email FROM drafts d JOIN contacts c ON c.id = d.contact_id"
                                     " ORDER BY d.id LIMIT 1").fetchone()
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, error, created_at)"
                 " VALUES (%s, %s, %s, 'failed', 'SMTP: SMTPAuthenticationError', now() - interval '40 minutes')",
                 (draft_id, TEST_TO, real_to))
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, message_id, created_at)"
                 " VALUES (%s, %s, %s, 'sent', '<demo@venmart.kz>', now() - interval '25 minutes')",
                 (draft_id, TEST_TO, real_to))


def fake_send_test(conn, draft_id: int) -> send.TestSendResult:
    """Как send.send_test, но без почтового сервера: только строка в ui_demo.test_sends. Писем нет вообще."""
    row = conn.execute("SELECT d.review_status, c.email FROM drafts d JOIN contacts c ON c.id = d.contact_id"
                       " WHERE d.id = %s", (draft_id,)).fetchone()
    if row is None or row[0] == "rejected":
        raise send.SendBlocked("Отклонённое письмо не отправляется даже в тест")
    conn.execute("INSERT INTO test_sends (draft_id, sent_to, real_to, status, message_id)"
                 " VALUES (%s, %s, %s, 'sent', '<demo@venmart.kz>')", (draft_id, TEST_TO, row[1]))
    return send.TestSendResult(sent_to=TEST_TO, real_to=row[1], message_id="<demo@venmart.kz>")


def seed_history(conn) -> None:
    """История писем (система и импорт) и список «не писать», в том числе одна компания с письмом."""
    nur = conn.execute("SELECT id FROM companies WHERE name = 'ТОО «Нур Авто Запчасти»'").fetchone()[0]
    contact_policy.record_message(conn, company_id=nur, email="zakaz@nur-avto.example.kz", direction="out",
                                  subject="Учёт запчастей без пересчёта")
    contact_policy.record_message(conn, company_id=nur, email="zakaz@nur-avto.example.kz", direction="in",
                                  kind="reply", source="manual", note="ответили по телефону, интересно")
    contact_policy.import_contacts(conn, "tender@alatau-stroy.example.kz\nold.client@astana-sklad.example.kz\n"
                                   "director@mega-trade.example.kz", refused=False)
    contact_policy.import_contacts(conn, "spam-sklad.example.kz\nno-reply@bereke.example.kz", refused=True)
    medical = conn.execute("SELECT id FROM companies WHERE name = 'ТОО «Медикал Сток»'").fetchone()[0]
    contact_policy.block_company(conn, medical, note="просили не писать, звонок 20.10")


def fake_start_run(dsn: str, city: str, query: str, max_companies: int) -> int:
    """Как pipeline.start_run, но вместо шагов пайплайна только счётчики в ui_demo.runs."""
    with demo_connect(dsn) as conn:
        run_id = pipeline.create_run(conn, city, query, max_companies)
    queries = pipeline.split_queries(query)
    threading.Thread(target=_fake_progress, args=(dsn, run_id, max_companies, queries), daemon=True).start()
    return run_id


def fake_letter_item(run_id: int, index: int, query: str) -> tuple:
    """Выдуманная компания с черновиком, ждущим проверки: письмо поддельного запуска."""
    name = f"ТОО «Демо {query} {run_id}-{index + 1}»"
    SEARCH_QUERY[name] = query
    body = ("[Проверить: письмо из поддельного запуска, данные выдуманы]\n"
            "Здравствуйте!\n\nПишу по поводу вашего склада. RFID-метки на паллетах позволяют пересчитать склад за "
            "один обход. Можем показать на одном ряду стеллажей. Удобно ли созвониться?\n\n" + SIGNATURE)
    return (name, "Складские услуги", "Алматы, ул. Демо, 1", None, "drafted", 70, "yes", "склады",
            "Выдуманная компания для показа очереди писем.",
            [(f"info@demo-{run_id}-{index + 1}.example.kz", "/", "safe", False, True)],
            ("Пересчёт склада за один обход", body, CHECKS_OK), None)


def _fake_progress(dsn: str, run_id: int, per_query: int, queries: list[str]) -> None:
    """Те же названия этапов в runs.stage и stage_detail, что пишет pipeline.execute_run."""
    n = per_query * len(queries)
    good = max(1, n * 6 // 10)
    plan = [
        ("Поиск в 2ГИС", {"found": n, "new_companies": max(1, n - 1)}),
        ("Сайты", {"crawled": max(1, n - 2)}),
        ("Квалификация", {"qualified": good, "rejected": max(0, n - 2 - good)}),
        ("Проверка почт", {"verified": max(1, good - 1)}),
        ("Письма", {"drafted": max(1, good - 1)}),
    ]
    with demo_connect(dsn) as conn:
        try:
            conn.execute("UPDATE runs SET status = 'running', started_at = now(), stage = 'Подготовка'"
                         " WHERE id = %s", (run_id,))
            for stage, counters in plan:
                conn.execute("UPDATE runs SET stage = %s WHERE id = %s", (stage, run_id))
                if stage == "Поиск в 2ГИС":
                    for index, query in enumerate(queries, start=1):
                        detail = f"{query} ({index} из {len(queries)})" if len(queries) > 1 else query
                        conn.execute("UPDATE runs SET stage_detail = %s WHERE id = %s", (detail, run_id))
                        time.sleep(FAKE_STEP_SECONDS / 1.5)
                    conn.execute("UPDATE runs SET stage_detail = NULL WHERE id = %s", (run_id,))
                else:
                    time.sleep(FAKE_STEP_SECONDS)
                if stage == "Письма":
                    for index in range(counters["drafted"]):
                        item = fake_letter_item(run_id, index, queries[index % len(queries)])
                        insert_company(conn, run_id, item, 0)
                sets = ", ".join(f"{field} = %s" for field in counters)
                conn.execute(f"UPDATE runs SET {sets} WHERE id = %s", (*counters.values(), run_id))
            conn.execute("UPDATE runs SET status = 'done', stage = 'Готово', finished_at = now() WHERE id = %s",
                         (run_id,))
        except Exception:
            # Иначе демо-запуск навсегда останется «идёт» и заблокирует новые.
            conn.execute("UPDATE runs SET status = 'failed', error = 'Демо-запуск упал', finished_at = now()"
                         " WHERE id = %s", (run_id,))
            raise


def main() -> int:
    dsn = load_settings().require("database_url")
    reset_schema(dsn)
    seed(dsn)
    app = create_app(lambda: demo_connect(dsn), lambda city, query, n: fake_start_run(dsn, city, query, n),
                     daily_budget_usd=pipeline.daily_budget(load_settings()),
                     send_test=fake_send_test, test_address=TEST_TO)
    print(f"Демо: http://{HOST}:{PORT}/  (схема {SCHEMA}, запуск поддельный)")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
