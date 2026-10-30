"""API для единой панели (console): /internal/console/* на 127.0.0.1:8000. Контракт: ..\\contract\\CONSOLE_API.md.

Токен свой: LEADS_CONSOLE_TOKEN в заголовке X-Console-Token. Бот по nftables может ходить на 8000, и его взлом не
должен давать права одобрять письма или запускать платный поиск: токен бота здесь даёт 401, токен консоли на путях
бота тоже 401, а одинаковые токены сервер не принимает (app.check_tokens).
Порядок проверок: Host и заголовки прокси (app.HostRules) → токен, на любом пути под /internal/console, даже
несуществующем → запрос из браузера (Origin, Sec-Fetch-Site) → X-Console-User у POST → тело потоком с пределом →
разбор → база. Ошибки {"error": код, "message": текст} без текста исключений.
Чтение ничего не меняет: справку brief и отметку «писал в WhatsApp» эти маршруты не зовут никогда.
Действия — те же функции, что у кнопок старого интерфейса (web/actions.py); «кто одобрил» — X-Console-User.
Лог: одна строка INFO на действие (действие, пользователь, id, итог), без текстов, адресов и строки запроса.
"""

import base64
import binascii
import hmac
import json
import logging
import re
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any

import psycopg
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from starlette.convertors import Convertor, register_url_convertor

from tanbala_leads.pipeline import MAX_QUERY_LENGTH
from tanbala_leads.settings import SettingsError
from tanbala_leads.steps import send as send_step
from tanbala_leads.web import actions
from tanbala_leads.web import console_queries as cq
from tanbala_leads.web import console_views as cv
from tanbala_leads.web import queries as q
from tanbala_leads.web.format import parse_id
from tanbala_leads.web.labels import (
    COMPANY_SEARCH_MAX_LENGTH,
    COMPANY_SORTS,
    COMPANY_STATUSES,
    COMPANY_VIA,
    DIGEST_MAX_IDS,
    ERROR_MESSAGES,
    IMPORT_KINDS,
    LETTER_FILTERS,
    MAX_DB_ID,
    RESEARCH_STATUSES,
    SPEND_MAX_DAYS,
)

logger = logging.getLogger(__name__)

PREFIX = "/internal/console"
TOKEN_HEADER = "X-Console-Token"
USER_HEADER = "X-Console-User"
# Токен: от 32 до 512 видимых символов ASCII, как проверяет консоль. Другой — API выключен.
TOKEN_RE = re.compile(r"[\x21-\x7e]{32,512}")
USER_RE = re.compile(r"[a-z0-9._-]{1,32}")
DAY_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
MIN_YEAR, MAX_YEAR = 2000, 2100
MAX_BODY_BYTES = 16 * 1024
# Правка письма: тема до 200 и текст до 10 000 символов; кириллица в UTF-8 — 2 байта, всего около 20,6 КБ.
MAX_EDIT_BODY_BYTES = 32 * 1024
MAX_IMPORT_BODY_BYTES = 1536 * 1024  # файл до 1 МБ в base64 и текст
# Так шлёт браузер (DNS rebinding на ПК, где нет nftables); служба консоли их не шлёт.
BROWSER_HEADERS = ("origin", "sec-fetch-site")
JSON_TYPE = "application/json"
LETTER_FILTER_CODES = tuple(code for code, _, _ in LETTER_FILTERS)

UNAUTHORIZED_MESSAGE = "Нужен верный токен консоли в заголовке X-Console-Token."
FORBIDDEN_MESSAGE = "Запрос из браузера не принимается: этот API только для службы консоли."
HOST_MESSAGE = "Запрос только напрямую на 127.0.0.1 или localhost, без прокси."
NOT_FOUND_MESSAGE = "Такого адреса нет."
BAD_REQUEST_MESSAGE = ERROR_MESSAGES[400]
USER_MESSAGE = ("Нужен заголовок X-Console-User: строчная латиница, цифры, «.», «_» или «-», от 1 до 32 символов.")
BODY_MESSAGE = "Тело запроса — JSON-объект с Content-Type: application/json."
TOO_LARGE_MESSAGE = ERROR_MESSAGES[413]
INTERNAL_MESSAGE = "Внутренняя ошибка почты. Подробности в журнале сервера."
ALREADY_APPROVED_MESSAGE = "Письмо уже одобрено."
NOT_CONFIGURED_MESSAGE = ("Тестовая отправка не настроена: проверьте SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,"
                          " AGENT_EMAIL и AGENT_NAME в .env почты.")
RUN_NOT_FOUND = "Запуск не найден."
RUN_ACTIVE_MESSAGE = "Идёт запуск №{run_id}. Новый можно начать, когда он закончится."
FILE_BASE64_MESSAGE = "Файл не прочитан: fileBase64 должен быть в base64."
PERIOD_MESSAGE = (f"Нужны from и to в виде ГГГГ-ММ-ДД (годы {MIN_YEAR}–{MAX_YEAR}), from не позже to,"
                  f" не больше {SPEND_MAX_DAYS} дней.")
IDS_MESSAGE = f"ids: от 1 до {DIGEST_MAX_IDS} номеров компаний через запятую."


class DbIdConvertor(Convertor[int]):
    """Номер в пути консоли: до 19 цифр (bigint). Длиннее — такого пути нет (404 после токена), а не int() на тысячах
    цифр до проверки токена. Больше MAX_DB_ID отсекают сами запросы (queries.fetch_*)."""

    regex = "[0-9]{1,19}"

    def convert(self, value: str) -> int:
        return int(value)

    def to_string(self, value: int) -> str:
        return str(value)


register_url_convertor("dbid", DbIdConvertor())


class ConsoleError(Exception):
    """Ошибка API консоли: статус, код и понятный текст; extra — дополнительные поля ответа."""

    def __init__(self, status_code: int, code: str, message: str, **extra: Any):
        super().__init__(code)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.extra = extra

    def response(self) -> JSONResponse:
        return error(self.status_code, self.code, self.message, **self.extra)


class ConsoleJSON(JSONResponse):
    """JSON с кодировкой в Content-Type, без кэша и без угадывания типа."""

    media_type = "application/json; charset=utf-8"

    def __init__(self, content: Any, status_code: int = 200):
        super().__init__(content, status_code=status_code,
                         headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


def error(status_code: int, code: str, message: str, **extra: Any) -> JSONResponse:
    return ConsoleJSON({"error": code, "message": message, **extra}, status_code=status_code)


def is_console_path(path: str) -> bool:
    return path == PREFIX or path.startswith(PREFIX + "/")


def token_valid(token: str | None) -> bool:
    return bool(token) and TOKEN_RE.fullmatch(token) is not None


def token_ok(configured: str | None, given: str | None) -> bool:
    """Токен совпал (за постоянное время). Пустой или неверного вида токен в настройках выключает API."""
    if not token_valid(configured) or not given:
        return False
    return hmac.compare_digest(configured.encode(), given.encode())


def check_access(request: Request, token: str | None) -> None:
    """Первое на любом пути консоли: токен, потом запрос из браузера. До тела, параметров и базы."""
    if not token_ok(token, request.headers.get(TOKEN_HEADER)):
        raise ConsoleError(401, "unauthorized", UNAUTHORIZED_MESSAGE)
    if any(name in request.headers for name in BROWSER_HEADERS):
        raise ConsoleError(403, "forbidden", FORBIDDEN_MESSAGE)


def framework_error(request: Request, status_code: int, token: str | None) -> JSONResponse:
    """Ошибка до маршрута (нет пути, не тот метод, неверный параметр): сначала токен, потом код по статусу."""
    try:
        check_access(request, token)
    except ConsoleError as exc:
        return exc.response()
    if status_code == 404:
        return error(404, "not_found", NOT_FOUND_MESSAGE)
    return error(400, "bad_request", BAD_REQUEST_MESSAGE)


async def console_user(request: Request) -> str:
    """Имя пользователя консоли из X-Console-User: идёт в журнал и в approved_by. Права проверяет консоль."""
    user = request.headers.get(USER_HEADER, "")
    if not USER_RE.fullmatch(user):
        raise ConsoleError(400, "bad_request", USER_MESSAGE)
    return user


def body_reader(limit: int) -> Callable:
    """Зависимость POST: JSON-объект не больше limit байт, тело читается потоком (как internal.read_research)."""

    async def read_body(request: Request) -> dict[str, Any]:
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != JSON_TYPE:
            raise ConsoleError(400, "bad_request", BODY_MESSAGE)
        length = request.headers.get("content-length", "")
        if length.isascii() and length.isdigit() and int(length) > limit:
            raise ConsoleError(413, "too_large", TOO_LARGE_MESSAGE)
        body = bytearray()
        async for chunk in request.stream():
            body += chunk
            if len(body) > limit:
                raise ConsoleError(413, "too_large", TOO_LARGE_MESSAGE)
        try:
            data = json.loads(body)
        # json.JSONDecodeError и UnicodeDecodeError тоже ValueError; RecursionError: [[[[… глубже 1000 уровней.
        except (ValueError, RecursionError) as exc:
            raise ConsoleError(400, "bad_request", BODY_MESSAGE) from exc
        if not isinstance(data, dict):
            raise ConsoleError(400, "bad_request", BODY_MESSAGE)
        return data

    return read_body


def body_fields(body: dict[str, Any], required: Mapping[str, type] | None = None,
                optional: Mapping[str, type] | None = None) -> dict[str, Any]:
    """Поля тела: обязательные и необязательные с типом, лишние — 400."""
    required, optional = required or {}, optional or {}
    if set(body) - set(required) - set(optional):
        raise ConsoleError(400, "bad_request", "В теле запроса лишние поля.")
    for name, kind in required.items():
        if not isinstance(body.get(name), kind):
            raise ConsoleError(400, "bad_request", f"В теле запроса нужно поле {name}.")
    for name, kind in optional.items():
        if body.get(name) is not None and not isinstance(body[name], kind):
            raise ConsoleError(400, "bad_request", f"Неверное поле {name}.")
    return body


# ---------- параметры запроса ----------


def _bad(name: str) -> ConsoleError:
    return ConsoleError(400, "bad_request", f"Неверный параметр {name}.")


def param_id(params: Mapping[str, str], name: str) -> int | None:
    value = params.get(name) or ""
    if not value:
        return None
    parsed = parse_id(value)
    if parsed is None or not 1 <= parsed <= MAX_DB_ID:
        raise _bad(name)
    return parsed


def param_page(params: Mapping[str, str]) -> int:
    value = params.get("page") or ""
    if not value:
        return 1
    parsed = parse_id(value)
    if parsed is None or parsed < 1:
        raise _bad("page")
    return parsed


def param_choice(params: Mapping[str, str], name: str, allowed: tuple[str, ...] | Mapping[str, Any],
                 default: str | None = None) -> str | None:
    value = params.get(name) or ""
    if not value:
        return default
    if value not in allowed:
        raise _bad(name)
    return value


def param_flag(params: Mapping[str, str], name: str) -> bool:
    value = params.get(name) or ""
    if value not in ("", "0", "1"):
        raise _bad(name)
    return value == "1"


def param_text(params: Mapping[str, str], name: str, limit: int) -> str:
    """Текст фильтра как в старом списке: пробелы схлопываются, длина обрезается. NUL — 400, а не «база недоступна»."""
    value = params.get(name) or ""
    if "\x00" in value:
        raise ConsoleError(400, "bad_request", f"Неверный параметр {name}.")
    return " ".join(value.split())[:limit]


def param_period(params: Mapping[str, str]) -> tuple[date, date]:
    values = [params.get(name) or "" for name in ("from", "to")]
    if not all(DAY_RE.fullmatch(value) for value in values):
        raise ConsoleError(400, "bad_request", PERIOD_MESSAGE)
    try:
        start, end = (date.fromisoformat(value) for value in values)
    except ValueError as exc:  # 2026-02-30
        raise ConsoleError(400, "bad_request", PERIOD_MESSAGE) from exc
    in_range = MIN_YEAR <= start.year and end.year <= MAX_YEAR  # и date.max + 1 день не переполнится
    if not in_range or end < start or (end - start).days + 1 > SPEND_MAX_DAYS:
        raise ConsoleError(400, "bad_request", PERIOD_MESSAGE)
    return start, end


def param_ids(params: Mapping[str, str]) -> list[int]:
    parts = [part.strip() for part in (params.get("ids") or "").split(",")]
    if len(parts) > DIGEST_MAX_IDS:
        raise ConsoleError(400, "bad_request", IDS_MESSAGE)
    ids: list[int] = []
    for part in parts:
        parsed = parse_id(part)
        if parsed is None or not 1 <= parsed <= MAX_DB_ID:
            raise ConsoleError(400, "bad_request", IDS_MESSAGE)
        if parsed not in ids:
            ids.append(parsed)
    return ids


def company_filters(params: Mapping[str, str]) -> cq.CompanyFilters:
    return cq.CompanyFilters(
        run_id=param_id(params, "run"), status=param_choice(params, "status", COMPANY_STATUSES),
        q=param_text(params, "q", COMPANY_SEARCH_MAX_LENGTH), query=param_text(params, "query", MAX_QUERY_LENGTH) or None,
        via=param_choice(params, "via", COMPANY_VIA), wa=param_flag(params, "wa"),
        blocked=param_flag(params, "blocked"), letter=param_flag(params, "letter"),
        sort=param_choice(params, "sort", COMPANY_SORTS, "new"), page=param_page(params))


# ---------- действия ----------


def log_action(action: str, user: str, target: str, outcome: str) -> None:
    logger.info("Консоль: %s, %s, пользователь %s: %s", action, target, user, outcome)


def perform(action: str, user: str, target: str, run: Callable[[], Any],
            describe: Callable[[Any], str] | None = None) -> Any:
    """Действие из web/actions.py: одна строка в лог с итогом; отказ — ошибка API со своим кодом."""
    try:
        result = run()
    except actions.ActionError as exc:
        log_action(action, user, target, exc.code)
        raise ConsoleError(exc.status, exc.code, exc.message) from exc
    log_action(action, user, target, describe(result) if describe else "ok")
    return result


@dataclass(frozen=True)
class ConsoleDeps:
    """То же, что у кнопок старого интерфейса: соединение на запрос, запуск поиска, тестовая отправка, лимиты."""

    open_conn: Callable[[], AbstractContextManager[psycopg.Connection]]
    token: str | None
    start_run: Callable[[str, str, int], int]
    send_test: Callable[[psycopg.Connection, int], send_step.TestSendResult] | None = None
    test_to: str | None = None
    daily_budget_usd: float | None = None
    research_per_day: int | None = None


def make_router(deps: ConsoleDeps) -> APIRouter:
    """Маршруты /internal/console/... Проверка доступа стоит на всём роутере и выполняется раньше остального."""

    async def require_access(request: Request) -> None:
        check_access(request, deps.token)

    router = APIRouter(prefix=PREFIX, dependencies=[Depends(require_access)])
    _add_reads(router, deps)
    _add_actions(router, deps)
    return router


def _add_reads(router: APIRouter, deps: ConsoleDeps) -> None:
    @router.get("/summary")
    def summary() -> JSONResponse:
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.summary(conn, test_to=deps.test_to, budget_usd=deps.daily_budget_usd,
                                          research_per_day=deps.research_per_day))

    @router.get("/spend")
    def spend(request: Request) -> JSONResponse:
        start, end = param_period(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.spend(conn, start, end))

    @router.get("/companies")
    def companies(request: Request) -> JSONResponse:
        filters = company_filters(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.companies(conn, filters))

    @router.get("/companies/digest")
    def digest(request: Request) -> JSONResponse:
        ids = param_ids(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.digest(conn, ids))

    @router.get("/companies/{company_id:dbid}")
    def company(company_id: int) -> JSONResponse:
        if company_id > MAX_DB_ID:
            raise ConsoleError(404, "not_found", actions.COMPANY_NOT_FOUND)
        with deps.open_conn() as conn:
            card = cv.company_card(conn, company_id, test_to=deps.test_to)
        if card is None:
            raise ConsoleError(404, "not_found", actions.COMPANY_NOT_FOUND)
        return ConsoleJSON(card)

    @router.get("/letters")
    def letters(request: Request) -> JSONResponse:
        params = request.query_params
        status = param_choice(params, "status", LETTER_FILTER_CODES, "pending")
        run_id, page = param_id(params, "run"), param_page(params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.letters(conn, status, run_id, page))

    @router.get("/letters/{draft_id:dbid}")
    def letter(draft_id: int) -> JSONResponse:
        with deps.open_conn() as conn:
            found = cv.letter(conn, draft_id, test_to=deps.test_to)
        if found is None:
            raise ConsoleError(404, "not_found", actions.LETTER_NOT_FOUND)
        return ConsoleJSON(found)

    @router.get("/runs")
    def runs(request: Request) -> JSONResponse:
        page = param_page(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.runs(conn, page))

    @router.get("/runs/active")
    def active_run() -> JSONResponse:
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.active_run(conn))

    @router.get("/runs/{run_id:dbid}")
    def run(run_id: int) -> JSONResponse:
        with deps.open_conn() as conn:
            found = cv.run_by_id(conn, run_id)
        if found is None:
            raise ConsoleError(404, "not_found", RUN_NOT_FOUND)
        return ConsoleJSON(found)

    @router.get("/search/options")
    def search_options() -> JSONResponse:
        return ConsoleJSON(cv.search_options())

    @router.get("/history")
    def history(request: Request) -> JSONResponse:
        page = param_page(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.history(conn, page))

    @router.get("/blocked")
    def blocked(request: Request) -> JSONResponse:
        page = param_page(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.blocked(conn, page))

    @router.get("/research-jobs")
    def research_jobs(request: Request) -> JSONResponse:
        status = param_choice(request.query_params, "status", RESEARCH_STATUSES)
        page = param_page(request.query_params)
        with deps.open_conn() as conn:
            return ConsoleJSON(cv.research_jobs(conn, status, page))


def _approve_once(conn: psycopg.Connection, draft_id: int, user: str) -> None:
    """Одобрить из консоли. Уже одобренное — 409: иначе повтор перезаписал бы, кто и когда одобрил.
    Старая кнопка повтор допускает (у одобренного письма её не видно), там это не меняется."""
    ref = actions.draft_ref(conn, draft_id)
    if ref["review_status"] == "approved":
        raise actions.ActionError(409, "conflict", ALREADY_APPROVED_MESSAGE)
    actions.approve(conn, ref, user)


def _add_actions(router: APIRouter, deps: ConsoleDeps) -> None:
    small_body = body_reader(MAX_BODY_BYTES)
    edit_body = body_reader(MAX_EDIT_BODY_BYTES)
    import_body = body_reader(MAX_IMPORT_BODY_BYTES)

    @router.post("/runs")
    def start_search(user: str = Depends(console_user), body: dict = Depends(small_body)) -> JSONResponse:
        fields = body_fields(body, {"query": str, "city": str}, {"count": object})
        count = fields.get("count")
        count = count if type(count) is int else None  # не число (и не true/false): та же ошибка, что у формы
        try:
            run_id = actions.start_search(deps.start_run, fields["city"], fields["query"], count)
        except actions.ActionError as exc:
            log_action("start_search", user, "запуск", exc.code)
            if exc.code != "conflict":
                raise ConsoleError(exc.status, exc.code, exc.message) from exc
            with deps.open_conn() as conn:
                active = q.fetch_active_run(conn)
            if active is None:
                raise ConsoleError(exc.status, exc.code, exc.message) from exc
            raise ConsoleError(409, "conflict", RUN_ACTIVE_MESSAGE.format(run_id=active["id"]),
                               activeRunId=active["id"]) from exc
        log_action("start_search", user, f"запуск {run_id}", "ok")
        return ConsoleJSON({"runId": run_id}, status_code=202)

    @router.post("/drafts/{draft_id:dbid}/approve")
    def approve(draft_id: int, user: str = Depends(console_user), body: dict = Depends(small_body)) -> JSONResponse:
        body_fields(body)
        with deps.open_conn() as conn:
            perform("approve", user, f"письмо {draft_id}", lambda: _approve_once(conn, draft_id, user))
        return ConsoleJSON({"result": "approved"})

    @router.post("/drafts/{draft_id:dbid}/reject")
    def reject(draft_id: int, user: str = Depends(console_user), body: dict = Depends(small_body)) -> JSONResponse:
        body_fields(body)
        with deps.open_conn() as conn:
            perform("reject", user, f"письмо {draft_id}",
                    lambda: actions.reject(conn, actions.draft_ref(conn, draft_id), user))
        return ConsoleJSON({"result": "rejected"})

    @router.post("/drafts/{draft_id:dbid}/edit")
    def edit(draft_id: int, user: str = Depends(console_user), body: dict = Depends(edit_body)) -> JSONResponse:
        fields = body_fields(body, {"subject": str, "body": str})
        with deps.open_conn() as conn:
            checks = perform("edit", user, f"письмо {draft_id}", lambda: actions.edit(
                conn, actions.draft_ref(conn, draft_id), fields["subject"], fields["body"]))
        failed = sum(1 for check in checks if not check.get("passed"))
        return ConsoleJSON({"result": "saved", "checksTotal": len(checks), "checksFailed": failed})

    @router.post("/drafts/{draft_id:dbid}/send-test")
    def send_test(draft_id: int, user: str = Depends(console_user), body: dict = Depends(small_body)) -> JSONResponse:
        body_fields(body)

        def send(conn: psycopg.Connection) -> send_step.TestSendResult:
            ref = actions.draft_for_test_send(conn, draft_id)
            try:
                return actions.send_test(conn, ref, test_to=deps.test_to, sender=deps.send_test)
            except SettingsError as exc:  # нет SMTP_* или AGENT_* в .env, SMTP_PORT не число
                raise actions.ActionError(503, "not_configured", NOT_CONFIGURED_MESSAGE) from exc

        with deps.open_conn() as conn:
            result = perform("send_test", user, f"письмо {draft_id}", lambda: send(conn))
            last = q.fetch_test_sends(conn, draft_id, 1)
        at = last[0]["created_at"] if last and last[0]["status"] == "sent" else datetime.now(timezone.utc)
        return ConsoleJSON({"result": "sent", "sentTo": result.sent_to, "at": cv.iso(at)})

    @router.post("/companies/{company_id:dbid}/block")
    def block(company_id: int, user: str = Depends(console_user), body: dict = Depends(small_body)) -> JSONResponse:
        body_fields(body)
        with deps.open_conn() as conn:
            perform("block", user, f"компания {company_id}", lambda: actions.block_company(conn, company_id))
        return ConsoleJSON({"result": "blocked"})

    @router.post("/companies/{company_id:dbid}/whatsapp-clear")
    def whatsapp_clear(company_id: int, user: str = Depends(console_user),
                       body: dict = Depends(small_body)) -> JSONResponse:
        body_fields(body)
        with deps.open_conn() as conn:
            was = perform("whatsapp_clear", user, f"компания {company_id}",
                          lambda: actions.clear_whatsapp(conn, company_id))
        return ConsoleJSON({"result": "cleared", "wasRequestedVia": was})

    @router.post("/history/import")
    def import_history(user: str = Depends(console_user), body: dict = Depends(import_body)) -> JSONResponse:
        fields = body_fields(body, {"kind": str}, {"text": str, "fileBase64": str})
        target = f"список {fields['kind'] if fields['kind'] in IMPORT_KINDS else '?'}"

        def run() -> actions.ImportSummary:
            refused = actions.import_refused(fields["kind"])
            text = fields.get("text") or ""
            if fields.get("fileBase64"):
                try:
                    data = base64.b64decode(fields["fileBase64"], validate=True)
                except (binascii.Error, ValueError) as exc:
                    raise actions.ActionError(400, "bad_request", FILE_BASE64_MESSAGE) from exc
                text += "\n" + actions.decode_list_file(data)
            with deps.open_conn() as conn:
                return actions.import_list(conn, refused, text)

        outcome = perform("import", user, target, run, lambda result: (
            f"ok, добавлено {result.added}, уже были {result.skipped},"
            f" не распознано {len(result.invalid) + result.invalid_more}"))
        return ConsoleJSON({"added": outcome.added, "existing": outcome.skipped, "invalid": list(outcome.invalid),
                            "invalidMore": outcome.invalid_more})
