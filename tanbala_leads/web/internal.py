"""HTTP-часть внутреннего API для WhatsApp-бота (проект C).

Контракт: ..\\D-Email+WhatsApp\\contract\\INTERNAL_API.md. Слушает только 127.0.0.1, как весь интерфейс.
Токен X-Internal-Token проверяется первым: без него 401 на любой путь /internal/..., даже несуществующий.
Ответы JSON, ошибки {"error": код}. Вход разбирается до соединения с базой: неверный запрос даёт 400, а не 503.
"""

import hmac
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager

import psycopg
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from tanbala_leads.internal import lookup
from tanbala_leads.internal.normalize import BadInput

PREFIX = "/internal"
TOKEN_HEADER = "X-Internal-Token"
MIN_TOKEN_CHARS = 32
# Ошибки до маршрута (нет пути, не тот метод): код по HTTP-статусу, остальное bad_request.
STATUS_CODES = {401: "unauthorized", 404: "not_found", 503: "db_unavailable"}


class InternalError(Exception):
    """Ошибка внутреннего API: HTTP-статус и код для тела {"error": код}."""

    def __init__(self, status_code: int, code: str):
        super().__init__(code)
        self.status_code = status_code
        self.code = code


def is_internal(request: Request) -> bool:
    path = request.url.path
    return path == PREFIX or path.startswith(PREFIX + "/")


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


def make_router(open_conn: Callable[[], AbstractContextManager[psycopg.Connection]], token: str | None) -> APIRouter:
    """Маршруты /internal/... Зависимость токена стоит на всём роутере и выполняется раньше остальных."""

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

    return router
