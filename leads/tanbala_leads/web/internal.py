"""HTTP-часть внутреннего API для WhatsApp-бота (проект C).

Контракт: ..\\contract\\INTERNAL_API.md. Слушает только 127.0.0.1, как весь интерфейс. Имя интерфейса за Caddy
(PUBLIC_UI_HOST) сюда не пускается: app.LocalOnlyInternal отвечает 400 до токена.
Токен X-Internal-Token проверяется первым: без него 401 на любой путь /internal/..., даже несуществующий.
Ответы JSON, ошибки {"error": код}. Вход разбирается до соединения с базой: неверный запрос даёт 400, а не 503.
В access-лог строка запроса не попадает (HideQuery): в ней телефоны, почты и названия от клиентов бота.
"""

import hmac
import json
import logging
import re
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager

import psycopg
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from tanbala_leads.internal import brief, lookup, research
from tanbala_leads.internal.normalize import BadInput
from tanbala_leads.web.format import parse_id
from tanbala_leads.web.labels import MAX_DB_ID

PREFIX = "/internal"
TOKEN_HEADER = "X-Internal-Token"
MIN_TOKEN_CHARS = 32
MAX_BODY_BYTES = 4096
# Ошибки до маршрута (нет пути, не тот метод): код по HTTP-статусу, остальное bad_request.
STATUS_CODES = {401: "unauthorized", 404: "not_found", 503: "db_unavailable"}
# Строка access-лога uvicorn: '%s - "%s %s HTTP/%s" %d', путь третий.
ACCESS_LOG_ARGS = 5
# Путь, похожий на /internal (в любом регистре, с //, ./, http://хост, %3F вместо ?), пишется как есть только
# для известных маршрутов. Иначе вместо него INTERNAL_LOG_HIDDEN: в самом пути могли быть данные клиента бота.
INTERNAL_LOG_ROUTES_RE = re.compile(r"/internal(/lookup|/research(/[0-9a-fA-F-]{1,36})?|/companies/\d{1,19}/brief)?")
INTERNAL_LOG_HIDDEN = "/internal/[скрыто]"
LOG_QUERY_RE = re.compile(r"\?[^\s\"]*")


class InternalError(Exception):
    """Ошибка внутреннего API: HTTP-статус и код для тела {"error": код}."""

    def __init__(self, status_code: int, code: str):
        super().__init__(code)
        self.status_code = status_code
        self.code = code


def is_internal_path(path: str) -> bool:
    return path == PREFIX or path.startswith(PREFIX + "/")


def looks_internal(path: str) -> bool:
    """Путь похож на /internal в любом регистре и с лишними «/» в начале: такие пути только для 127.0.0.1."""
    return path.lstrip("/").lower().startswith(PREFIX.lstrip("/"))


def is_internal(request: Request) -> bool:
    return is_internal_path(request.url.path)


def log_path(path: str) -> str:
    """Путь для access-лога: без строки запроса; похожий на /internal только если это известный маршрут."""
    path = path.split("?", 1)[0]
    if "internal" not in path.lower() or INTERNAL_LOG_ROUTES_RE.fullmatch(path):
        return path
    return INTERNAL_LOG_HIDDEN


class HideQuery(logging.Filter):
    """Фильтр логгера uvicorn.access: строка запроса не пишется ни у одного пути (?phone=… → ничего).

    uvicorn пишет строку доступа с аргументами (адрес, метод, путь со строкой запроса, версия HTTP, статус).
    Если новая версия uvicorn пишет иначе, из каждого текстового аргумента вырезается всё от «?» до пробела.
    Запись не отбрасывается.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) == ACCESS_LOG_ARGS and isinstance(args[2], str):
            record.args = (*args[:2], log_path(args[2]), *args[3:])
        elif isinstance(args, tuple):  # форма та же, чтобы форматтер uvicorn не сломался
            record.args = tuple(LOG_QUERY_RE.sub("", arg) if isinstance(arg, str) else arg for arg in args)
        elif isinstance(record.msg, str):
            record.msg = LOG_QUERY_RE.sub("", record.msg)
        return True


def token_ok(configured: str | None, given: str | None) -> bool:
    """Токен совпал. Пустой или короткий токен в настройках выключает API."""
    if not configured or len(configured) < MIN_TOKEN_CHARS or not given:
        return False
    return hmac.compare_digest(configured.encode(), given.encode())


def error(status_code: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status_code)


def framework_error(request: Request, status_code: int, token: str | None) -> JSONResponse:
    """Ошибка фреймворка на пути /internal: сначала токен, потом код по статусу."""
    if not token_ok(token, request.headers.get(TOKEN_HEADER)):
        return error(401, "unauthorized")
    if status_code in STATUS_CODES:
        return error(status_code, STATUS_CODES[status_code])
    return error(400, "bad_request")


def parse_lookup(domain: str | None = None, phone: str | None = None, name: str | None = None) -> lookup.Query:
    try:
        return lookup.parse_query(domain, phone, name)
    except BadInput as exc:
        raise InternalError(400, "bad_request") from exc


def parse_company_id(company_id: str) -> int:
    parsed = parse_id(company_id)
    if parsed is None or not 1 <= parsed <= MAX_DB_ID:
        raise InternalError(400, "bad_request")
    return parsed


async def read_research(request: Request) -> research.Request:
    """Тело POST /internal/research: JSON-объект не больше MAX_BODY_BYTES."""
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_BODY_BYTES:
            raise InternalError(400, "bad_request")
    try:
        return research.parse_request(json.loads(body))
    # json.JSONDecodeError и UnicodeDecodeError тоже ValueError; RecursionError: [[[[… глубже 1000 уровней.
    except (ValueError, RecursionError, BadInput) as exc:
        raise InternalError(400, "bad_request") from exc


def make_router(open_conn: Callable[[], AbstractContextManager[psycopg.Connection]], token: str | None,
                queue: research.ResearchQueue | None = None) -> APIRouter:
    """Маршруты /internal/... Зависимость токена стоит на всём роутере и выполняется раньше остальных.

    queue: очередь проверок новых компаний; без неё маршрутов /internal/research нет.
    """

    def require_token(request: Request) -> None:
        if not token_ok(token, request.headers.get(TOKEN_HEADER)):
            raise InternalError(401, "unauthorized")

    def get_conn() -> Iterator[psycopg.Connection]:
        with open_conn() as conn:
            yield conn

    router = APIRouter(prefix=PREFIX, dependencies=[Depends(require_token)])

    @router.get("/lookup")
    def lookup_company(query: lookup.Query = Depends(parse_lookup),
                       conn: psycopg.Connection = Depends(get_conn)) -> dict:
        return {"candidates": lookup.find_candidates(conn, query)}

    @router.get("/companies/{company_id}/brief")
    def company_brief(company_id: int = Depends(parse_company_id),
                      conn: psycopg.Connection = Depends(get_conn)) -> dict:
        found = brief.company_brief(conn, company_id)
        if found is None:
            raise InternalError(404, "not_found")
        # Бот просит справку, когда клиент подтвердил «да, это мы»: запоминаем, что клиент писал в WhatsApp.
        # Справка внутри статуса research отметку не ставит: там клиент ещё ничего не подтверждал.
        brief.mark_whatsapp_contact(conn, company_id)
        return found

    if queue is None:
        return router

    @router.post("/research")
    def start_research(request: research.Request = Depends(read_research),
                       conn: psycopg.Connection = Depends(get_conn)) -> JSONResponse:
        try:
            started = queue.submit(conn, request)
        except research.LimitReached as exc:
            raise InternalError(429, exc.code) from exc
        if started.job_id is None:
            return JSONResponse({"status": "done", "company_id": started.company_id})
        return JSONResponse({"job_id": started.job_id}, status_code=202)

    @router.get("/research/{job_id}")
    def research_status(job_id: str, conn: psycopg.Connection = Depends(get_conn)) -> dict:
        return research.job_status(conn, job_id)

    return router
