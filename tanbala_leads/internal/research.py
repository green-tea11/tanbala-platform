"""Проверка новой компании по запросу WhatsApp-бота (POST /internal/research).

Тот же путь, что в поиске: 2ГИС → сайт → оценка Haiku. Почты не проверяются, письмо не пишется.
Компания, которую проверка сама добавила в базу, получает requested_via = 'whatsapp' и в рассылку не попадает
никогда (решение владельца 27.10.2026). Уже известные компании не помечаем: иначе любой собеседник бота мог бы
закрыть рассылку чужой компании, назвав её домен (вопрос владельцу).
Задачи лежат в research_jobs. Одновременно выполняется одна, очередь своя, но браузеры общие с поиском
(browsers.py): проверка ждёт только текущий шаг поиска (одну выдачу 2ГИС или один сайт) и идёт вне очереди.
"""

import logging
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

import psycopg
from psycopg.rows import dict_row

from tanbala_leads import pipeline
from tanbala_leads.internal import brief, lookup
from tanbala_leads.internal import normalize as norm
from tanbala_leads.settings import Settings
from tanbala_leads.steps import collect, crawl, qualify
from tanbala_leads.steps.collect import CITIES

logger = logging.getLogger(__name__)

DEFAULT_CITY = "almaty"
# Компанию ищем по названию: нужная обычно первая в выдаче, берём с запасом.
PARSER_RECORDS = 5
# Ключ блокировки: две заявки одновременно не обойдут дневной лимит.
LIMIT_LOCK_KEY = 0x7E5EA2C4
FIELDS = ("name", "city", "phone", "domain")
TODAY_JOBS_SQL = """
SELECT count(*) FROM research_jobs
WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty'
  AND reason IS DISTINCT FROM 'city_unsupported'
"""
CLAIM_SQL = """
UPDATE research_jobs SET status = 'running', started_at = now()
WHERE id = (SELECT id FROM research_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1
            FOR UPDATE SKIP LOCKED)
RETURNING id, name, city, phone, domain, company_id
"""
# Та же заявка, пока первая ещё в очереди или в работе: повтор бота не тратит лимит и второй вызов Haiku.
ACTIVE_JOB_SQL = """
SELECT id FROM research_jobs
WHERE status IN ('queued', 'running')
  AND (company_id = %(company_id)s
       OR (lower(name) = lower(%(name)s) AND city IS NOT DISTINCT FROM %(city)s
           AND phone IS NOT DISTINCT FROM %(phone)s AND domain IS NOT DISTINCT FROM %(domain)s))
ORDER BY created_at LIMIT 1
"""
# Очередь после сбоя (база пропала посреди задачи): пауза и новая попытка.
RETRY_SECONDS = 30
# Название города для сравнения: по-русски и кодом 2ГИС, без регистра, ё как е.
CITY_KEYS = {key: code for code, name in CITIES.items() for key in (code, name.lower().replace("ё", "е"))}


class LimitReached(RuntimeError):
    """Дневной лимит проверок или бюджета: ответ 429 с этим кодом."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Request:
    name: str  # как прислал бот, для поиска в 2ГИС
    city: str | None  # код 2ГИС; None: город не поддерживается
    phone: str | None
    domain: str | None  # регистрируемый домен; None: не передан или общая почта

    @property
    def query(self) -> lookup.Query:
        return lookup.Query(domain=self.domain, phone=self.phone, name=norm.normalize_name(self.name))


@dataclass(frozen=True)
class Started:
    company_id: int | None = None  # компания уже есть и оценена: ответ 200 done
    job_id: str | None = None  # иначе задача: ответ 202


def per_day_limit(settings: Settings) -> int:
    """Дневной лимит проверок из WhatsApp: RESEARCH_PER_DAY, целое от 0."""
    try:
        value = int(settings.research_per_day)
    except ValueError as exc:
        raise ValueError("RESEARCH_PER_DAY должен быть целым числом, например 20") from exc
    if value < 0:
        raise ValueError("RESEARCH_PER_DAY не может быть меньше нуля")
    return value


def resolve_city(value: str | None) -> str | None:
    """Код города 2ГИС. Пусто: Алматы. Город не из CITIES: None."""
    text = (value or "").strip().lower().replace("ё", "е")
    return CITY_KEYS.get(text) if text else DEFAULT_CITY


def _optional(payload: dict, key: str) -> str | None:
    value = payload.get(key)
    if value is not None and not isinstance(value, str):
        raise norm.BadInput(f"{key}: строка или null")
    return value if value and value.strip() else None


def parse_request(payload: object) -> Request:
    """Тело запроса от бота. Неверное: BadInput (400). Неизвестный город не ошибка: задача завершится failed."""
    if not isinstance(payload, dict):
        raise norm.BadInput("ожидался объект JSON")
    name = payload.get("name")
    if not isinstance(name, str):
        raise norm.BadInput("name обязателен")
    norm.parse_name(name)
    city, phone, domain = (_optional(payload, key) for key in FIELDS[1:])
    if city is not None and len(city.strip()) > norm.MAX_CITY_CHARS:
        raise norm.BadInput("city слишком длинный")
    return Request(name=" ".join(name.split()), city=resolve_city(city),
                   phone=norm.normalize_phone(phone) if phone else None,
                   domain=norm.parse_domain(domain) if domain else None)


def _is_qualified(conn: psycopg.Connection, company_id: int) -> bool:
    return conn.execute("SELECT EXISTS (SELECT 1 FROM qualifications WHERE company_id = %s)",
                        (company_id,)).fetchone()[0]


def _insert_job(conn: psycopg.Connection, request: Request, company_id: int | None, *,
                failed_reason: str | None = None) -> str:
    job_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO research_jobs (id, name, city, phone, domain, company_id, status, reason, finished_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END)",
        (job_id, request.name, request.city, request.phone, request.domain, company_id,
         "failed" if failed_reason else "queued", failed_reason, failed_reason is not None),
    )
    return job_id


def start(conn: psycopg.Connection, request: Request, *, per_day: int, budget_usd: float) -> Started:
    """Компания уже оценена: сразу её id. Та же заявка уже в работе: её job_id. Иначе задача в пределах лимитов."""
    city_name = CITIES.get(request.city) if request.city else None
    known = lookup.find_known(conn, request.query, city_name)
    if known is not None and _is_qualified(conn, known):
        return Started(company_id=known)
    if known is None and request.city is None:
        return Started(job_id=_insert_job(conn, request, None, failed_reason="city_unsupported"))
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (LIMIT_LOCK_KEY,))
        active = conn.execute(ACTIVE_JOB_SQL, {"company_id": known, "name": request.name, "city": request.city,
                                               "phone": request.phone, "domain": request.domain}).fetchone()
        if active is not None:
            return Started(job_id=str(active[0]))
        if conn.execute(TODAY_JOBS_SQL).fetchone()[0] >= per_day:
            raise LimitReached("rate_limited")
        if pipeline.spent_today_usd(conn) >= budget_usd:
            raise LimitReached("budget_exhausted")
        return Started(job_id=_insert_job(conn, request, known))


def job_status(conn: psycopg.Connection, job_id: str) -> dict:
    """Статус задачи по контракту. Неизвестный или неверный job_id: status not_found."""
    not_found = {"status": "not_found", "company_id": None, "brief": None, "reason": None}
    try:
        uuid.UUID(job_id)
    except ValueError:
        return not_found
    row = conn.execute("SELECT status, reason, company_id FROM research_jobs WHERE id = %s", (job_id,)).fetchone()
    if row is None:
        return not_found
    status, reason, company_id = row
    done = status == "done" and company_id is not None
    return {"status": status, "company_id": company_id if done else None,
            "brief": brief.company_brief(conn, company_id) if done else None, "reason": reason}


def recover_stale_jobs(conn: psycopg.Connection, note: str = "Проверка прервана: приложение было перезапущено") -> int:
    """Задачи, прерванные перезапуском или сбоем: failed / error. Задачи в очереди остаются в ней."""
    return conn.execute(
        "UPDATE research_jobs SET status = 'failed', reason = 'error', finished_at = now(), error = %s"
        " WHERE status = 'running'", (note,)
    ).rowcount


# ---------- выполнение задачи ----------


def _phones(card: collect.CompanyCard) -> set[str]:
    phones = set()
    for phone in card.phones:
        try:
            phones.add(norm.normalize_phone(phone))
        except norm.BadInput:
            continue
    return phones


def _card_score(card: collect.CompanyCard, request: Request) -> float:
    """Насколько карточка 2ГИС та самая компания: 1.0 по домену или телефону, иначе похожесть названия."""
    if request.domain:
        hosts = [card.website_domain or ""] + [email.rsplit("@", 1)[-1] for email in card.emails]
        if request.domain in {norm.registrable_domain(host) for host in hosts if host}:
            return lookup.EXACT_SCORE
    if request.phone and request.phone in _phones(card):
        return lookup.EXACT_SCORE
    similarity = norm.name_similarity(request.query.name or "", norm.normalize_name(card.name))
    return similarity if similarity >= lookup.MIN_NAME_SIMILARITY else 0.0


def best_card(cards: list[collect.CompanyCard], request: Request) -> collect.CompanyCard | None:
    """Лучшая карточка; при равенстве первая в выдаче 2ГИС. Ничего похожего: None."""
    scored = [(score, -index, card) for index, card in enumerate(cards) if (score := _card_score(card, request)) > 0]
    return max(scored, key=lambda item: item[:2])[2] if scored else None


def _find_in_2gis(conn: psycopg.Connection, job: dict, deps: pipeline.Deps) -> int | None:
    request = Request(name=job["name"], city=job["city"], phone=job["phone"], domain=job["domain"])
    export = deps.exports_dir / f"research-{job['id']}.json"
    deps.run_parser(collect.build_search_url(job["city"], job["name"]), export, PARSER_RECORDS)
    cards = [card for item in collect.read_export(export) if (card := collect.parse_item(item))]
    card = best_card(cards, request)
    return collect.save_card(conn, card, requested_via="whatsapp") if card else None


def _crawl_if_new(conn: psycopg.Connection, company_id: int, deps: pipeline.Deps) -> None:
    """Обойти сайт, если его ещё не обходили. Сайт не открылся: оценка по карточке 2ГИС, как в поиске."""
    status = conn.execute("SELECT status FROM companies WHERE id = %s", (company_id,)).fetchone()[0]
    if status != "new":
        return
    try:
        crawl.crawl_company(conn, company_id, deps.crawl)
    except Exception as exc:  # noqa: BLE001  сайт не открылся: дальше по карточке 2ГИС
        logger.warning("Проверка из WhatsApp, компания %s: сайт не открылся", company_id)
        conn.execute("UPDATE companies SET status = 'crawled', last_error = %s WHERE id = %s AND status = 'new'",
                     (pipeline.safe_error(exc), company_id))


def _finish(conn: psycopg.Connection, job_id: str, *, company_id: int | None = None, reason: str | None = None,
            error: str | None = None) -> None:
    conn.execute(
        "UPDATE research_jobs SET status = %s, reason = %s, company_id = coalesce(%s, company_id), error = %s,"
        " finished_at = now() WHERE id = %s",
        ("failed" if reason else "done", reason, company_id, error, job_id),
    )


def run_job(conn: psycopg.Connection, job: dict, deps: pipeline.Deps, budget_usd: float) -> None:
    """Выполнить одну задачу: 2ГИС (если компании ещё нет), сайт, оценка Haiku. Итог в research_jobs."""
    job_id = str(job["id"])
    try:
        if pipeline.spent_today_usd(conn) >= budget_usd:
            _finish(conn, job_id, reason="budget_exhausted")
            return
        company_id = job["company_id"] or _find_in_2gis(conn, job, deps)
        if company_id is None:
            _finish(conn, job_id, reason="not_in_2gis")
            return
        # Компанию уже оценила другая задача или поиск: второй вызов Haiku не нужен.
        if not _is_qualified(conn, company_id):
            _crawl_if_new(conn, company_id, deps)
            qualify.qualify_company(conn, company_id, client=deps.client, owner_doc=deps.owner_doc,
                                    on_usage=pipeline.usage_recorder(conn, None, company_id, deps.log_path))
        _finish(conn, job_id, company_id=company_id)
    except Exception as exc:  # noqa: BLE001  любая ошибка задачи видна боту как failed / error
        logger.exception("Проверка из WhatsApp %s упала", job_id)
        _finish(conn, job_id, reason="error", error=pipeline.safe_error(exc))


class ResearchQueue:
    """Принимает заявки и выполняет их по одной в фоновом потоке.

    inline=True (тесты): задача выполняется сразу внутри submit.
    """

    def __init__(self, connect: Callable[[], psycopg.Connection], deps_factory: Callable[[], pipeline.Deps], *,
                 per_day: int, budget_usd: float, inline: bool = False):
        self.connect = connect
        self.deps_factory = deps_factory
        self.per_day = per_day
        self.budget_usd = budget_usd
        self.inline = inline
        self._deps: pipeline.Deps | None = None
        self._lock = threading.Lock()
        self._pending = False
        self._thread: threading.Thread | None = None

    def submit(self, conn: psycopg.Connection, request: Request) -> Started:
        started = start(conn, request, per_day=self.per_day, budget_usd=self.budget_usd)
        if started.job_id is not None:
            self.kick()
        return started

    def kick(self) -> None:
        """Разбудить обработчик очереди. Если он уже работает, он заберёт новую задачу сам."""
        if self.inline:
            self.drain()
            return
        with self._lock:
            self._pending = True
            if self._thread is None or not self._thread.is_alive():
                self._thread = threading.Thread(target=self._loop, name="research", daemon=True)
                self._thread.start()

    def _loop(self) -> None:
        while True:
            with self._lock:
                if not self._pending:
                    self._thread = None
                    return
                self._pending = False
            try:
                self.drain()
            except Exception:  # noqa: BLE001  поток очереди не должен умирать молча
                logger.exception("Очередь проверок из WhatsApp: сбой, новая попытка через %s с", RETRY_SECONDS)
                with self._lock:
                    self._pending = True
                time.sleep(RETRY_SECONDS)

    def drain(self) -> int:
        """Выполнить все задачи из очереди по одной. Вернуть, сколько выполнено.

        Обработчик очереди один, поэтому задача в статусе running здесь осталась от сбоя: она failed / error,
        иначе уникальный индекс не дал бы взять следующую.
        """
        done = 0
        with self.connect() as conn:
            while True:
                recover_stale_jobs(conn, "Проверка прервана сбоем базы или приложения")
                with conn.cursor(row_factory=dict_row) as cursor:
                    job = cursor.execute(CLAIM_SQL).fetchone()
                if job is None:
                    return done
                try:
                    deps = self._deps = self._deps or self.deps_factory()
                except Exception as exc:  # noqa: BLE001  нет ключа API или документа: задача failed / error
                    logger.exception("Проверка из WhatsApp: не удалось подготовить зависимости")
                    _finish(conn, str(job["id"]), reason="error", error=pipeline.safe_error(exc))
                    continue
                run_job(conn, job, deps, self.budget_usd)
                done += 1
