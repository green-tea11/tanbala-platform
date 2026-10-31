"""Варианты названия в проверке из WhatsApp (aliases, решение владельца 30.10.2026). 2ГИС, сайт и Claude на моках.

Живой тест 30.10.2026: клиент написал «Тинькофф», 2ГИС Алматы вернул пустую выдачу, бренд с 2024 года «Т-Банк».
"""

import dataclasses
import json
from types import SimpleNamespace
from urllib.parse import unquote

import psycopg
import pytest
from test_internal_research import (
    AUTH,
    FakeClient,
    add_company,
    add_qualification,
    env,  # noqa: F401  фикстура pytest
    make_client_without_db,
    make_deps,
    post,
    status,
)

from tanbala_leads.internal import research
from tanbala_leads.sites import PageText, SiteCrawl
from tanbala_leads.steps import collect

TINKOFF = {"name": "Тинькофф", "aliases": ["Т-Банк", "Tinkoff"]}


def card_item(name: str, *, firm_id: str, phone: str | None = None, site: str | None = None) -> dict:
    """Карточка в виде выдачи parser-2gis: только поля, которые читает collect.parse_item."""
    contacts = [{"type": "phone", "value": phone}] if phone else []
    if site:
        contacts.append({"type": "website", "url": f"https://{site}", "text": site})
    return {"type": "branch", "id": f"{firm_id}_hash", "name": name, "org": {"id": firm_id, "branch_count": 1},
            "adm_div": [{"name": "Алматы", "type": "city"}], "city_alias": "almaty", "address_name": "Абая, 1",
            "rubrics": [{"name": "Банки"}], "contact_groups": [{"contacts": contacts}]}


T_BANK = card_item("Т-Банк, банк", firm_id="70000001000000001", phone="+77272000001", site="tbank.kz")
KASPI = card_item("Kaspi Bank, банк", firm_id="70000001000000002", phone="+77272000002", site="kaspi.kz")


class ScriptedParser:
    """Вместо parser-2gis: на каждый поиск своя выдача (список карточек или ошибка), запоминает запросы и файлы."""

    def __init__(self, *outputs):
        self.outputs = list(outputs)
        self.urls: list[str] = []
        self.exports: list[str] = []

    @property
    def searched(self) -> list[str]:
        return [unquote(url.rsplit("/", 1)[1]) for url in self.urls]

    def __call__(self, url, out, max_records):
        self.urls.append(url)
        self.exports.append(out.name)
        output = self.outputs[len(self.urls) - 1] if len(self.urls) <= len(self.outputs) else []
        if isinstance(output, Exception):
            raise output
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(output, ensure_ascii=False), encoding="utf-8")
        return out


def deps_with(env, *outputs, client=None):
    return make_deps(env.tmp_path, parser=ScriptedParser(*outputs), client=client)


def job_rows(conn) -> list[tuple]:
    return conn.execute("SELECT name, aliases, status, reason FROM research_jobs ORDER BY created_at").fetchall()


# ---------- разбор запроса, без базы ----------


@pytest.mark.parametrize(("aliases", "expected"), [
    (["  Т-Банк   Онлайн ", "ТИНЬКОФФ", "т-банк онлайн"], ("Т-Банк Онлайн",)),
    (["", "   ", "ТОО"], ()),
    (["«»", "Tinkoff", "T-Bank"], ("Tinkoff", "T-Bank")),
    (["Т-Банк", "Tinkoff", "T-Bank"], ("Т-Банк", "Tinkoff", "T-Bank")),
    (["а" * 200], ("а" * 200,)),
    ([], ()),
    (None, ()),
])
def test_aliases_are_cleaned_without_empty_and_repeats_in_given_order(aliases, expected):
    request = research.parse_request({"name": " Тинькофф ", "aliases": aliases})

    assert (request.name, request.aliases) == ("Тинькофф", expected)
    assert request.search_names == ("Тинькофф", *expected)


def test_request_without_aliases_field_has_none():
    assert research.parse_request({"name": "Тинькофф"}).aliases == ()


@pytest.mark.parametrize("aliases", [
    '"Т-Банк"', "{}", "5", "true", "[5]", "[null]", '[["Т-Банк"]]', '["Т-Банк", {}]',
    '["a", "b", "c", "d"]', '["Тинькофф", "Тинькофф", "Тинькофф", "Тинькофф"]',
    '["' + "а" * 201 + '"]', '["Т\\u0000Банк"]', '["Тинькофф\\u0000"]', '["\\ud800"]',
])
def test_bad_aliases_are_400_before_database(aliases):
    body = '{"name": "Тинькофф", "aliases": ' + aliases + "}"

    response = make_client_without_db().post("/internal/research", content=body.encode(),
                                             headers={**AUTH, "Content-Type": "application/json"})

    assert (response.status_code, response.json()) == (400, {"error": "bad_request"})


def test_card_is_scored_by_the_query_that_found_it():
    card = collect.parse_item(T_BANK)
    request = research.Request(name="Тинькофф", city="almaty", phone=None, domain=None, aliases=("Т-Банк",))

    assert research.best_card([card], request) is None  # «тинькофф» не похоже на «т банк»
    assert research.best_card([card], request, "Т-Банк") == card
    assert research.best_card([card], request, "ТОО «Т-Банк»") == card
    assert research.best_card([card], request, "Tinkoff") is None


# Выдача 2ГИС Алматы по «kusto» из живого теста 31.10.2026 (названия как в выдаче).
KUSTO_HOME = card_item("Kusto Home", firm_id="70000001000000011")
KUSTO_LOGISTICS = card_item("Kusto Logistics Management, компания", firm_id="70000001000000012")
MKS_KUSTO = card_item("Mks Kusto Logistics, логистическая компания", firm_id="70000001000000013")
DIAMOND = card_item("Diamond, жилой комплекс", firm_id="70000001000000014")


def test_short_brand_picks_the_only_card_that_starts_with_it():
    request = research.Request(name="kusto", city="almaty", phone=None, domain=None)
    cards = [collect.parse_item(item) for item in (DIAMOND, MKS_KUSTO, KUSTO_LOGISTICS)]

    assert research.best_card(cards, request) == cards[2]


def test_brand_word_inside_another_name_is_not_a_match():
    # Иначе проверка платно оценила бы «Mks Kusto Logistics» до вопроса клиенту (ревью 31.10.2026).
    request = research.Request(name="kusto", city="almaty", phone=None, domain=None)

    assert research.best_card([collect.parse_item(MKS_KUSTO)], request) is None


def test_short_brand_shared_by_two_companies_is_ambiguous():
    request = research.Request(name="kusto", city="almaty", phone=None, domain=None)
    cards = [collect.parse_item(item) for item in (DIAMOND, KUSTO_HOME, KUSTO_LOGISTICS, MKS_KUSTO)]

    assert research.best_card(cards, request) is None
    assert research.best_card(cards, request, "Kusto Logistics") == cards[2]
    assert research.best_card(cards, request, "ТОО Kusto Logistics Management") == cards[2]


def test_branches_with_one_name_are_not_ambiguous():
    request = research.Request(name="kusto", city="almaty", phone=None, domain=None)
    branch = card_item("Kusto Logistics Management, склад", firm_id="70000001000000012")
    cards = [collect.parse_item(item) for item in (KUSTO_LOGISTICS, branch)]

    assert research.best_card(cards, request) == cards[0]


def test_phone_or_domain_match_does_not_depend_on_the_query():
    card = collect.parse_item(T_BANK)
    by_phone = research.Request(name="Тинькофф", city="almaty", phone="77272000001", domain=None)
    by_domain = research.Request(name="Тинькофф", city="almaty", phone=None, domain="tbank.kz")

    assert research.best_card([card], by_phone, "Tinkoff") == card
    assert research.best_card([card], by_domain, "Tinkoff") == card


# ---------- 2ГИС по имени, затем по вариантам ----------


@pytest.mark.db
@pytest.mark.parametrize("first_output", [[], [T_BANK], [KASPI]], ids=["empty", "same-card-other-name", "other"])
def test_2gis_tries_aliases_in_order_until_a_card_is_found(env, first_output):
    """«Тинькофф» в 2ГИС пуст или не похож, «Т-Банк» находит карточку, до «Tinkoff» дело не доходит."""
    deps = deps_with(env, first_output, [KASPI, T_BANK])
    client, _, _ = env.client(deps=deps)

    job_id = post(client, TINKOFF)["job_id"]
    result = status(client, job_id)

    assert (result["status"], result["reason"]) == ("done", None)
    assert deps.run_parser.searched == ["Тинькофф", "Т-Банк"]
    assert deps.run_parser.exports == [f"research-{job_id}.json", f"research-{job_id}-1.json"]
    row = env.conn.execute("SELECT name, requested_via FROM companies WHERE id = %s",
                           (result["company_id"],)).fetchone()
    assert row == ("Т-Банк, банк", "whatsapp")
    assert env.conn.execute("SELECT count(*) FROM companies").fetchone()[0] == 1
    assert job_rows(env.conn) == [("Тинькофф", ["Т-Банк", "Tinkoff"], "done", None)]
    assert len(deps.client.calls) == 1


@pytest.mark.db
def test_without_aliases_2gis_is_searched_once(env):
    deps = deps_with(env, [], [T_BANK])
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {"name": "Тинькофф"})["job_id"])

    assert (result["status"], result["reason"]) == ("failed", "not_in_2gis")
    assert deps.run_parser.searched == ["Тинькофф"]


@pytest.mark.db
def test_not_in_2gis_after_name_and_every_alias(env):
    deps = deps_with(env, [], [KASPI], [], [])
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {"name": "Тинькофф", "aliases": ["Т-Банк", "Tinkoff", "T-Bank"]})["job_id"])

    assert result == {"status": "failed", "company_id": None, "brief": None, "reason": "not_in_2gis"}
    assert deps.run_parser.searched == ["Тинькофф", "Т-Банк", "Tinkoff", "T-Bank"]
    assert deps.client.calls == []
    assert env.conn.execute("SELECT count(*) FROM companies").fetchone()[0] == 0


@pytest.mark.db
def test_no_more_than_four_2gis_searches_per_job(env):
    """Даже если в задаче окажется больше вариантов, чем пропускает разбор запроса."""
    deps = deps_with(env)
    job = {"id": "00000000-0000-0000-0000-000000000001", "name": "Тинькофф", "city": "almaty", "phone": None,
           "domain": None, "company_id": None, "aliases": ["A1", "A2", "A3", "A4", "A5"]}

    assert research._find_in_2gis(env.conn, job, deps) is None
    assert deps.run_parser.searched == ["Тинькофф", "A1", "A2", "A3"]


@pytest.mark.db
def test_database_keeps_at_most_three_aliases(env):
    with pytest.raises(psycopg.errors.CheckViolation):
        env.conn.execute("INSERT INTO research_jobs (id, name, aliases) VALUES"
                         " (gen_random_uuid(), 'Тинькофф', ARRAY['a', 'b', 'c', 'd'])")


@pytest.mark.db
def test_parser_failure_on_alias_stops_the_job(env, caplog):
    from tanbala_leads.steps.collect import ParserError

    deps = deps_with(env, [], ParserError("Chrome упал на https://2gis.kz/almaty/search/Т-Банк"), [T_BANK])
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, TINKOFF)["job_id"])

    assert (result["status"], result["reason"]) == ("failed", "error")
    assert deps.run_parser.searched == ["Тинькофф", "Т-Банк"]
    # В лог сервера только номер задачи и вид ошибки: названия от клиента бота туда не идут.
    assert "ParserError" in caplog.text
    assert all(name not in caplog.text for name in ("Тинькофф", "Т-Банк", "Tinkoff"))


@pytest.mark.db
def test_aliases_of_unsupported_city_are_kept_without_search(env):
    deps = deps_with(env)
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {**TINKOFF, "city": "Тараз"})["job_id"])

    assert result["reason"] == "city_unsupported" and deps.run_parser.urls == []
    assert job_rows(env.conn) == [("Тинькофф", ["Т-Банк", "Tinkoff"], "failed", "city_unsupported")]


# ---------- известная компания по варианту ----------


@pytest.mark.db
def test_known_qualified_company_is_found_by_alias_without_job(env):
    company_id = add_company(env.conn, "Т-Банк, банк")
    add_qualification(env.conn, company_id)
    client, deps, _ = env.client(per_day=0)  # лимит не тратится

    assert post(client, TINKOFF, 200) == {"status": "done", "company_id": company_id}
    assert deps.run_parser.urls == [] and deps.client.calls == []
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 0


@pytest.mark.db
def test_known_company_without_assessment_is_found_by_alias_and_skips_2gis(env):
    company_id = add_company(env.conn, "ТОО «T-Bank»", status="rejected")
    deps = deps_with(env)
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {"name": "Тинькофф", "aliases": ["Т-Банк", "t-bank"]})["job_id"])

    assert (result["status"], result["company_id"]) == ("done", company_id)
    assert deps.run_parser.urls == [] and len(deps.client.calls) == 1
    assert env.conn.execute("SELECT requested_via FROM companies").fetchone()[0] is None


@pytest.mark.db
def test_domain_or_phone_match_wins_over_alias_name(env):
    by_alias = add_company(env.conn, "Т-Банк, банк")
    by_domain = add_company(env.conn, "Совсем другое имя", domain="tbank.kz", phones=["+77272000009"])
    city = "Алматы"

    for extra in ({"domain": "https://tbank.kz/"}, {"phone": "8 727 200 00 09"}):
        request = research.parse_request({**TINKOFF, **extra})
        assert research.find_known(env.conn, request, city) == by_domain
    assert research.find_known(env.conn, research.parse_request(TINKOFF), city) == by_alias


@pytest.mark.db
def test_alias_matches_known_company_only_in_the_same_city(env):
    company_id = add_company(env.conn, "Т-Банк, банк")
    add_qualification(env.conn, company_id)
    deps = deps_with(env)
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, {**TINKOFF, "city": "Астана"})["job_id"])

    assert result["reason"] == "not_in_2gis"
    assert deps.run_parser.urls[0].startswith("https://2gis.kz/astana/search/")


@pytest.mark.db
def test_repeat_after_done_comes_back_at_once_by_alias(env):
    deps = deps_with(env, [], [T_BANK])
    client, _, _ = env.client(deps=deps)
    company_id = status(client, post(client, TINKOFF)["job_id"])["company_id"]

    assert post(client, {"name": "Tinkoff", "aliases": ["т-банк"]}, 200) == {"status": "done",
                                                                             "company_id": company_id}
    assert len(deps.run_parser.urls) == 2


# ---------- та же заявка и дневной лимит ----------


@pytest.mark.db
@pytest.mark.parametrize("again", [
    {"name": "Т-Банк"},  # имя заявки — вариант задачи
    {"name": "т-банк", "aliases": ["Тинькофф"]},  # имя и вариант переставлены
    {"name": "тинькофф", "aliases": ["Kaspi"]},  # то же имя, другие варианты
    {"name": "Kaspi", "aliases": ["ТИНЬКОФФ"]},  # имя задачи — вариант заявки
    {"name": "Тинькофф", "aliases": ["Т-Банк", "Tinkoff"], "city": "Алматы"},
])
def test_names_swapped_or_other_aliases_return_the_same_job(env, again):
    client, _, queue = env.client(per_day=1, inline=False)
    queue.kick = lambda: None  # обработчик не запущен: задача остаётся в очереди
    first = post(client, TINKOFF)["job_id"]

    assert post(client, again)["job_id"] == first
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 1


@pytest.mark.db
@pytest.mark.parametrize("other", [
    {"name": "Т-Банк", "city": "Астана"},
    {"name": "Т-Банк", "phone": "+7 727 200 00 01"},
    {"name": "Kaspi", "aliases": ["Каспи"]},
    {"name": "Kaspi", "aliases": ["TINKOFF"]},  # общий только вариант: догадка бота не склеивает компании
])
def test_other_city_phone_or_names_make_a_new_job(env, other):
    client, _, queue = env.client(inline=False)
    queue.kick = lambda: None
    first = post(client, TINKOFF)["job_id"]

    assert post(client, other)["job_id"] != first
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 2


@pytest.mark.db
def test_longest_allowed_body_with_escaped_cyrillic_is_accepted(env):
    """name и три варианта по 200 знаков, кириллица в виде \\uXXXX: тело ≈ 5.7 КБ, это не 400."""
    client, _, queue = env.client(inline=False)
    queue.kick = lambda: None
    body = {"name": "Б" * 200, "aliases": ["В" * 200, "Г" * 200, "Д" * 200], "city": "Алматы" + " " * 94,
            "phone": "+7 (727) 200-00-01", "domain": "tbank.kz"}
    content = json.dumps(body, ensure_ascii=True).encode()
    assert 5000 < len(content) <= 8192

    response = client.post("/internal/research", content=content, headers={**AUTH, "Content-Type": "application/json"})

    assert response.status_code == 202, response.text
    assert job_rows(env.conn) == [("Б" * 200, ["В" * 200, "Г" * 200, "Д" * 200], "queued", None)]


def test_body_over_8_kb_is_400():
    body = json.dumps({"name": "Тинькофф", "pad": "x" * 8200}).encode()

    response = make_client_without_db().post("/internal/research", content=body,
                                             headers={**AUTH, "Content-Type": "application/json"})

    assert (response.status_code, response.json()) == (400, {"error": "bad_request"})


@pytest.mark.db
def test_aliases_do_not_bypass_the_daily_limit(env):
    client, _, queue = env.client(per_day=1, inline=False)
    queue.kick = lambda: None
    post(client, {"name": "Тинькофф", "aliases": ["Т-Банк", "Tinkoff", "T-Bank"]})

    for body in ({"name": "Kaspi", "aliases": ["Каспи"]}, {"name": "Kaspi", "aliases": ["Каспи", "Kaspi.kz"]}):
        response = client.post("/internal/research", json=body, headers=AUTH)
        assert (response.status_code, response.json()) == (429, {"error": "rate_limited"})
    assert env.conn.execute("SELECT count(*) FROM research_jobs").fetchone()[0] == 1


# ---------- до трёх болей в справке задачи ----------


class ThreePainsClient(FakeClient):
    """Квалификация с четырьмя болями: три с цитатами из сайта, одна выдуманная."""

    PAINS = [
        {"pain": "Инвентаризация занимает дни и отрывает людей", "evidence": "Инвентаризация раз в квартал",
         "source": "site"},
        {"pain": "Вещи теряются, никто не знает, где они", "evidence": "Теряем инструмент каждую неделю",
         "source": "site"},
        {"pain": "Считают вручную или сканируют штрихкоды по одному", "evidence": "Складское хранение и логистика",
         "source": "site"},
        {"pain": "Тара уходит к партнёрам и не возвращается", "evidence": "Возвратная тара у партнёров",
         "source": "site"},
    ]

    def create(self, **kwargs):
        response = super().create(**kwargs)
        answer = {**json.loads(response.content[0].text), "pains": self.PAINS}
        response.content = [SimpleNamespace(type="text", text=json.dumps(answer, ensure_ascii=False))]
        return response


def site_with_pains(url: str) -> SiteCrawl:
    text = "Складское хранение и логистика. Инвентаризация раз в квартал. Возвратная тара у партнёров."
    return SiteCrawl(start_url=url, pages=(PageText(url=url, text=text),), emails=frozenset(), error=None)


@pytest.mark.db
def test_research_brief_has_up_to_three_verified_pains(env):
    deps = dataclasses.replace(deps_with(env, [], [T_BANK], client=ThreePainsClient()), crawl=site_with_pains)
    client, _, _ = env.client(deps=deps)

    result = status(client, post(client, TINKOFF)["job_id"])

    assert [pain["evidence"] for pain in result["brief"]["pains"]] == [
        "Инвентаризация раз в квартал", "Складское хранение и логистика", "Возвратная тара у партнёров"]
    stored = env.conn.execute("SELECT pains FROM qualifications").fetchone()[0]
    assert [pain["verified"] for pain in stored] == [True, True, True]
