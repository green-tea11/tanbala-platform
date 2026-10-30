"""Веб-интерфейс поиска клиентов: поиск по кнопке, очередь писем, компании и «кому писали».

Работает только на 127.0.0.1. Страницы показывают текст с чужих сайтов и от модели, поэтому:
Jinja экранирует всё, ссылки выводятся только http(s), в JS данные попадают только через textContent,
каждый POST требует CSRF-токен и своё Origin. Отправки писем здесь нет.
На сервере интерфейс открывают через Caddy по имени из PUBLIC_UI_HOST (HTTPS и пароль в Caddy); внутренний API
по этому имени недоступен.
Порты разные (serve, PortSplit): на --port (8000) только /internal (бот и консоль), на --ui-port (8001) только
интерфейс. Так процесс, которому можно ходить на 8000 (бот), не нажмёт кнопки интерфейса.

Модули: labels (подписи и лимиты), format (форматирование), queries (чтение из базы),
views (данные для шаблонов), actions (действия кнопок, общие с API консоли), internal (API для WhatsApp-бота
по токену), console (API для единой панели по своему токену), этот файл: безопасность, маршруты и запуск.
"""

from __future__ import annotations

import copy
import hashlib
import logging
import re
import secrets
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from http import HTTPStatus
from pathlib import Path
from typing import Any, TypeVar

import psycopg
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from starlette.datastructures import Headers
from starlette.datastructures import UploadFile  # request.form() отдаёт файлы этого класса, не fastapi.UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.types import ASGIApp, Receive, Scope, Send

from tanbala_leads import __version__, browsers, db, pipeline
from tanbala_leads.internal import research
from tanbala_leads.settings import Settings, load_settings
from tanbala_leads.steps import collect
from tanbala_leads.steps import send as send_step
from tanbala_leads.web import actions, console, internal
from tanbala_leads.web import queries as q
from tanbala_leads.web import views
from tanbala_leads.web.format import (
    Cost,
    fmt_date,
    fmt_dt,
    fmt_int,
    format_usd,
    letters_url,
    parse_id,
    plural,
)
from tanbala_leads.web.labels import (
    COMPANY_SEARCH_MAX_LENGTH,
    COMPANY_STATUSES,
    DB_ERROR_MESSAGE,
    DONE_MESSAGES,
    ERROR_MESSAGES,
    LETTER_FORMS,
    MAX_DB_ID,
    MAX_FORM_BYTES,
    MAX_UPLOAD_BYTES,
    POLL_INTERVAL_MS,
    REJECTED_TEST_TEXT,
    REVIEWER,
    TEST_OFF_TEXT,
    TOKEN_FORMS,
)
from tanbala_leads.web.ports import PortSplit, bind_sockets, check_ports, make_server, run_server

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

BIND_HOST = "127.0.0.1"
DEFAULT_API_PORT = 8000  # /internal: бот и консоль; интерфейс на --ui-port (cli: 8001)
# Защита от DNS rebinding: чужое имя хоста в запросе получает 400. Порт не сравнивается:
# «127.0.0.1:8000» и «localhost:8000» проходят (так их шлют браузер и HTTP-клиент бота).
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
# Имя интерфейса за Caddy (PUBLIC_UI_HOST): части из латиницы, цифр и дефиса через точку, последняя с буквы
# (так IP-адрес не пройдёт), без схемы, порта и пути.
PUBLIC_HOST_RE = re.compile(r"(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?")
# Host для /internal: ровно 127.0.0.1 или localhost, порт можно (так шлёт бот).
LOCAL_HOST_RE = re.compile(r"(127\.0\.0\.1|localhost)(:\d{1,5})?", re.IGNORECASE)
# Заголовки, которые ставит прокси (Caddy). Бот ходит в /internal напрямую и их не шлёт.
PROXY_HEADERS = ("x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "via")
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
)
# После одобрения или отклонения в очереди дальше идёт следующее письмо, ждущее проверки.
NEXT_LETTER_FILTERS = frozenset({"pending", "all"})


def _static_version() -> str:
    digest = hashlib.sha256(__version__.encode())
    for path in sorted(p for p in STATIC_DIR.glob("*") if p.is_file()):
        digest.update(path.name.encode() + path.read_bytes())
    return digest.hexdigest()[:10]


def _make_templates() -> Jinja2Templates:
    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR), autoescape=True, undefined=StrictUndefined,
                      trim_blocks=True, lstrip_blocks=True)
    version = _static_version()
    env.globals["static"] = lambda name: f"/static/{name}?v={version}"
    env.filters.update(fmt_int=fmt_int, fmt_dt=fmt_dt, fmt_date=fmt_date, plural=plural)
    return Jinja2Templates(env=env)


async def _security_headers(request: Request, call_next: Callable) -> Response:
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    # Адрес интерфейса не уходит на сайты компаний. no-referrer не годится: с ним браузер шлёт в POST «Origin: null».
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if not request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _redirect(url: str) -> RedirectResponse:
    return RedirectResponse(url, status_code=303)


T = TypeVar("T")


def page_action(action: Callable[[], T]) -> T:
    """Действие из web/actions.py для страницы: отказ — страница ошибки с прежним статусом и текстом."""
    try:
        return action()
    except actions.ActionError as exc:
        raise HTTPException(exc.page_status, exc.page_message) from exc


def parse_public_host(value: str) -> str | None:
    """Имя интерфейса за Caddy из PUBLIC_UI_HOST в нижнем регистре. Пусто: интерфейс только по 127.0.0.1 и localhost."""
    host = value.strip().lower()
    if not host:
        return None
    if not PUBLIC_HOST_RE.fullmatch(host):
        raise ValueError("PUBLIC_UI_HOST должен быть именем без схемы, порта и пути, например leads.tanbala.kz")
    return host


def is_public_host(host: str, public_host: str | None) -> bool:
    """Заголовок Host — имя интерфейса за Caddy (без порта: с портом HostRules запрос не пускает)."""
    return public_host is not None and host.lower() == public_host


class HostRules:
    """Проверки имени до приложения, вместе с TrustedHostMiddleware. Ответ 400 «Invalid host header», как у неё.

    /internal (без учёта регистра и лишних «/» в начале): только Host 127.0.0.1 или localhost и без заголовков прокси.
    Так внутренний API недоступен ни по имени из PUBLIC_UI_HOST, ни через Caddy, даже если Caddy когда-нибудь станет
    передавать Host 127.0.0.1. Ответ до проверки токена: снаружи не видно, есть ли такой путь.
    Имя из PUBLIC_UI_HOST — только без порта. Caddy шлёт его без порта; с портом (например :8000) запрос пришёл мимо
    Caddy и его пароля: так было бы, если бы кто-то подменил DNS имени на 127.0.0.1 для браузера на сервере.
    """

    def __init__(self, app: ASGIApp, public_host: str | None = None):
        self.app = app
        self.public_host = public_host

    def refused(self, scope: Scope) -> bool:
        headers = Headers(scope=scope)
        host = headers.get("host", "")
        if internal.looks_internal(scope["path"]):
            return not LOCAL_HOST_RE.fullmatch(host) or any(name in headers for name in PROXY_HEADERS)
        return self.public_host is not None and host.lower().startswith(self.public_host + ":")

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket") and self.refused(scope):
            # API консоли отвечает ошибками своего вида {"error", "message"}; остальное как раньше.
            if console.is_console_path(scope["path"]):
                response: Response = console.error(400, "bad_request", console.HOST_MESSAGE)
            else:
                response = PlainTextResponse("Invalid host header", status_code=400)
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


def create_app(connect: Callable[[], psycopg.Connection], start_run: Callable[[str, str, int], int], *,
               csrf_token: str | None = None, daily_budget_usd: float | None = None,
               send_test: Callable[[psycopg.Connection, int], send_step.TestSendResult] | None = None,
               test_address: str | None = None, internal_token: str | None = None,
               research_queue: research.ResearchQueue | None = None, public_host: str | None = None,
               console_token: str | None = None, api_port: int | None = None,
               ui_port: int | None = None) -> FastAPI:
    """Собрать приложение. connect открывает соединение на запрос, start_run запускает поиск в фоне.

    daily_budget_usd: суточный лимит расходов на API для сводки на странице поиска (None: не показывать).
    send_test: тестовая отправка письма владельцу (steps/send.send_test); test_address: куда она уходит.
    Без них, или если адрес не из send.TEST_RECIPIENTS, тестовая отправка выключена.
    internal_token: токен внутреннего API для WhatsApp-бота (web/internal.py); пустой выключает API.
    research_queue: очередь проверок новых компаний для бота (internal/research.py).
    public_host: имя интерфейса за Caddy (parse_public_host). Пускается только к интерфейсу, своё Origin у него
    https://имя: Caddy принимает HTTPS, а сюда приходит по HTTP.
    console_token: токен API консоли (web/console.py, LEADS_CONSOLE_TOKEN); пустой или неверного вида выключает его.
    С токеном бота он совпадать не может: иначе бот получил бы права консоли.
    api_port и ui_port: порты API и интерфейса (PortSplit); без api_port всё на одном порту (тесты, ui_demo).
    """
    check_tokens(internal_token, console_token)
    if api_port is None and ui_port is not None:
        raise ValueError("ui_port без api_port: порт API обязателен")
    token = csrf_token or secrets.token_urlsafe(32)
    # Компаниям здесь не отправляется ничего: только тест, и только на зашитый в send.py адрес владельца.
    test_to = test_address if send_test is not None and test_address in send_step.TEST_RECIPIENTS else None
    templates = _make_templates()
    # redirect_slashes: /internal/lookup/ иначе получил бы 307 до проверки токена.
    app = FastAPI(title="Tanbala", docs_url=None, redoc_url=None, openapi_url=None, redirect_slashes=False)
    app.middleware("http")(_security_headers)
    # www_redirect=False: иначе example.kz при имени www.example.kz получил бы редирект на http:// (без HTTPS).
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[*ALLOWED_HOSTS, *([public_host] if public_host else [])],
                       www_redirect=False)
    app.add_middleware(HostRules, public_host=public_host)
    if api_port is not None:
        app.add_middleware(PortSplit, api_port=api_port, ui_port=ui_port)
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @contextmanager
    def open_conn() -> Iterator[psycopg.Connection]:
        conn = connect()
        try:
            yield conn
        finally:
            conn.close()

    def get_conn() -> Iterator[psycopg.Connection]:
        with open_conn() as conn:
            yield conn

    app.include_router(internal.make_router(open_conn, internal_token, research_queue))
    # Отдельно от роутера бота: свой токен на всех путях /internal/console, свои ошибки.
    app.include_router(console.make_router(console.ConsoleDeps(
        open_conn=open_conn, token=console_token, start_run=start_run, send_test=send_test, test_to=test_to,
        daily_budget_usd=daily_budget_usd, research_per_day=research_queue.per_day if research_queue else None)))

    def make_csrf_form(max_bytes: int) -> Callable:
        async def csrf_form(request: Request) -> dict[str, Any]:
            """Каждый POST: своё Origin, разумный размер и токен из скрытого поля.

            Вернуть текстовые поля формы; файлы (только у импорта) лежат отдельно в ключе "_files".
            """
            origin = request.headers.get("origin")
            host = request.headers.get("host", "")
            if is_public_host(host, public_host):
                own_origin = f"https://{public_host}"
            else:
                own_origin = f"{request.url.scheme}://{host}"
            if origin is not None and origin != own_origin:
                raise HTTPException(403, ERROR_MESSAGES[403])
            if request.headers.get("sec-fetch-site") == "cross-site":
                raise HTTPException(403, ERROR_MESSAGES[403])
            length = request.headers.get("content-length", "")
            if length.isascii() and length.isdigit() and int(length) > max_bytes:
                raise HTTPException(413, ERROR_MESSAGES[413])
            form = await request.form()
            sent = form.get("csrf_token")
            if not isinstance(sent, str) or not secrets.compare_digest(sent.encode(), token.encode()):
                raise HTTPException(403, ERROR_MESSAGES[403])
            fields: dict[str, Any] = {key: value for key, value in form.items() if isinstance(value, str)}
            fields["_files"] = {key: value for key, value in form.items() if isinstance(value, UploadFile)}
            return fields

        return csrf_form

    csrf_form = make_csrf_form(MAX_FORM_BYTES)
    # Файл до 1 МБ плюс поля формы и разметка multipart.
    csrf_upload = make_csrf_form(MAX_UPLOAD_BYTES + MAX_FORM_BYTES)

    def render(request: Request, name: str, context: dict[str, Any], *, conn: psycopg.Connection | None = None,
               status_code: int = 200) -> HTMLResponse:
        api_cost = q.fetch_total_cost(conn) if conn is not None else None
        pending = q.count_pending_letters(conn) if conn is not None else 0
        full = {"csrf_token": token, "api_cost": api_cost, "pending_total": pending, "token_forms": TOKEN_FORMS,
                "letter_forms": LETTER_FORMS, "api_cost_text": f"≈ {format_usd(api_cost.usd)}" if api_cost else "",
                "test_address": test_to, "test_off_text": TEST_OFF_TEXT, "rejected_test_text": REJECTED_TEST_TEXT,
                "send_error": None, **context}
        return templates.TemplateResponse(request, name, full, status_code=status_code)

    def render_search(request: Request, conn, *, form: dict, run_id: int | None = None,
                      message: str | None = None, status_code: int = 200) -> HTMLResponse:
        pending = q.count_pending_letters(conn)
        context = views.search_context(conn, form=form, run_id=run_id, message=message, pending_total=pending,
                                       budget_usd=daily_budget_usd)
        return render(request, "search.html", {**context, "poll_ms": POLL_INTERVAL_MS}, conn=conn,
                      status_code=status_code)

    def edit_state(letter: dict | None, edit: dict | None, requested: bool) -> dict[str, Any]:
        """Правка письма открывается по ссылке «Изменить» (?edit=1) или после ошибки в форме."""
        default = {"subject": letter["subject"], "body": letter["body"], "error": None} if letter else None
        is_open = bool(letter and letter["can_edit"] and (requested or (edit and edit.get("error"))))
        return {"edit": edit or default, "edit_open": is_open}

    def done_text(conn, done: str | None, letter: dict | None) -> str | None:
        """Сообщение после действия. «Тест отправлен» собирается из базы, а не из адреса страницы."""
        if done != "test_sent":
            return DONE_MESSAGES.get(done or "")
        last = q.fetch_test_sends(conn, letter["id"], 1) if letter else []
        if not last or last[0]["status"] != "sent":
            return None
        return f"Тест отправлен на {last[0]['sent_to']} в {last[0]['created_at'].astimezone():%H:%M}."

    def render_company(request: Request, conn, company_id: int, *, done: str | None = None,
                       edit: dict | None = None, edit_requested: bool = False, send_error: str | None = None,
                       status_code: int = 200) -> HTMLResponse:
        context = views.company_context(conn, company_id)
        if context is None:
            raise HTTPException(404, "Компания не найдена.")
        context.update(done_message=done_text(conn, done, context["draft"]), send_error=send_error,
                       **edit_state(context["draft"], edit, edit_requested))
        return render(request, "company.html", context, conn=conn, status_code=status_code)

    def render_letters(request: Request, conn, *, status: str | None, run: str | None, draft_id: int | None = None,
                       done: str | None = None, edit: dict | None = None, edit_requested: bool = False,
                       send_error: str | None = None, status_code: int = 200) -> HTMLResponse:
        selected = None
        if draft_id is not None:
            selected = q.fetch_letter(conn, draft_id)
            if selected is None:
                raise HTTPException(404, "Письмо не найдено.")
        filter_code = views.letter_filter(status, selected["review_status"] if selected else None)
        context = views.letters_context(conn, filter_code=filter_code, run_id=parse_id(run), selected=selected)
        context.update(done_message=done_text(conn, done, context["letter"]), send_error=send_error,
                       **edit_state(context["letter"], edit, edit_requested))
        return render(request, "letters.html", context, conn=conn, status_code=status_code)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        # Токен по пути: /internal/console — токен консоли, остальной /internal — токен бота, как раньше.
        if console.is_console_path(request.url.path):
            return console.framework_error(request, exc.status_code, console_token)
        if internal.is_internal(request):
            return internal.framework_error(request, exc.status_code, internal_token)
        detail = exc.detail if isinstance(exc.detail, str) else ""
        if not detail or detail == HTTPStatus(exc.status_code).phrase:
            detail = ERROR_MESSAGES.get(exc.status_code, "Что-то пошло не так.")
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": detail}, status_code=exc.status_code)
        context = {"title": "Ошибка", "nav": "", "status_code": exc.status_code, "message": detail}
        return render(request, "error.html", context, status_code=exc.status_code)

    @app.exception_handler(internal.InternalError)
    async def internal_api_error(request: Request, exc: internal.InternalError) -> Response:
        return internal.error(exc.status_code, exc.code)

    @app.exception_handler(console.ConsoleError)
    async def console_api_error(request: Request, exc: console.ConsoleError) -> Response:
        return exc.response()

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> Response:
        if console.is_console_path(request.url.path):
            return console.framework_error(request, 400, console_token)
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception) -> Response:
        """Необработанная ошибка: API консоли получает JSON без текста исключения, остальное как у Starlette."""
        if console.is_console_path(request.url.path):
            try:  # и здесь сначала токен: 500 видит только тот, кому можно в API консоли
                console.check_access(request, console_token)
            except console.ConsoleError as denied:
                return denied.response()
            return console.error(500, "internal", console.INTERNAL_MESSAGE)
        return PlainTextResponse("Internal Server Error", status_code=500)

    @app.exception_handler(psycopg.Error)
    async def db_error(request: Request, exc: psycopg.Error) -> Response:
        # Текст ошибки не пишем: в нём бывают адрес сервера и имя пользователя базы.
        logger.error("Ошибка базы данных: %s, sqlstate=%s", type(exc).__name__, getattr(exc, "sqlstate", None))
        if console.is_console_path(request.url.path):
            return console.error(503, "db_unavailable", DB_ERROR_MESSAGE)
        if internal.is_internal(request):
            return internal.error(503, "db_unavailable")
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": DB_ERROR_MESSAGE}, status_code=503)
        context = {"title": "База недоступна", "nav": "", "status_code": 503, "message": DB_ERROR_MESSAGE}
        return render(request, "error.html", context, status_code=503)

    # ---------- поиск ----------

    @app.get("/", response_class=HTMLResponse)
    def search_page(request: Request, run: str | None = None, text: str | None = Query(None, alias="q"),
                    conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_search(request, conn, form=views.search_form(query=(text or "").strip()), run_id=parse_id(run))

    @app.post("/runs")
    def create_run(request: Request, form: dict[str, str] = Depends(csrf_form)) -> Response:
        city, query, count_text = form.get("city", ""), form.get("query", "").strip(), form.get("max_companies", "")
        values = views.search_form(city, query, count_text.strip())
        try:
            run_id = actions.start_search(start_run, city, query, parse_id(count_text))
        except actions.ActionError as exc:  # в том числе суточный лимит расходов: здесь 400, как раньше
            message, status_code = exc.page_message, exc.page_status
        else:
            return _redirect(f"/?run={int(run_id)}")
        with open_conn() as conn:
            return render_search(request, conn, form=values, message=message, status_code=status_code)

    # ---------- компании ----------

    @app.get("/companies", response_class=HTMLResponse)
    def companies_page(request: Request, run: str | None = None, status: str | None = None,
                       text: str | None = Query(None, alias="q"), page: str | None = None, query: str | None = None,
                       conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        industry = " ".join((query or "").split())[: pipeline.MAX_QUERY_LENGTH] or None
        filters = views.CompanyFilters(
            run_id=parse_id(run), status=status if status in COMPANY_STATUSES else None,
            q=" ".join((text or "").split())[:COMPANY_SEARCH_MAX_LENGTH], page=max(1, parse_id(page) or 1),
            query=industry)
        return render(request, "companies.html", views.companies_context(conn, filters), conn=conn)

    @app.get("/companies/{company_id:int}", response_class=HTMLResponse)
    def company_page(request: Request, company_id: int, done: str | None = None, edit: str | None = None,
                     conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_company(request, conn, company_id, done=done, edit_requested=edit == "1")

    @app.post("/companies/{company_id:int}/block")
    def block_company(company_id: int, form: dict[str, Any] = Depends(csrf_form),
                      conn: psycopg.Connection = Depends(get_conn)) -> Response:
        """«Больше не писать»: компания и её корпоративный домен в do_not_contact."""
        page_action(lambda: actions.block_company(conn, company_id))
        return _redirect(f"/companies/{company_id}?done=blocked")

    @app.post("/companies/{company_id:int}/whatsapp-clear")
    def clear_whatsapp(company_id: int, form: dict[str, Any] = Depends(csrf_form),
                       conn: psycopg.Connection = Depends(get_conn)) -> Response:
        """«Снять отметку WhatsApp»: собеседник бота назвал чужую компанию. Снимаются обе пометки."""
        page_action(lambda: actions.clear_whatsapp(conn, company_id))
        logger.info("Компания %s: отметки WhatsApp сняты кнопкой в карточке", company_id)
        return _redirect(f"/companies/{company_id}?done=whatsapp_cleared")

    # ---------- кому писали ----------

    def render_history(request: Request, conn, *, history_page: int = 1, blocked_page: int = 1,
                       result: dict | None = None, form_text: dict | None = None,
                       status_code: int = 200) -> HTMLResponse:
        context = views.history_context(conn, history_page=history_page, blocked_page=blocked_page, result=result,
                                        form_text=form_text)
        return render(request, "history.html", context, conn=conn, status_code=status_code)

    @app.get("/history", response_class=HTMLResponse)
    def history_page(request: Request, history_page: str | None = None, blocked_page: str | None = None,
                     conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_history(request, conn, history_page=max(1, parse_id(history_page) or 1),
                              blocked_page=max(1, parse_id(blocked_page) or 1))

    def read_upload(upload: UploadFile | None) -> tuple[str, str | None]:
        """Текст из файла списка и ошибка для владельца. Нет файла: пустая строка."""
        if upload is None or not upload.filename:
            return "", None
        try:
            return actions.decode_list_file(upload.file.read(MAX_UPLOAD_BYTES + 1)), None
        except actions.ActionError as exc:
            return "", exc.page_message

    @app.post("/history/import")
    def import_history(request: Request, form: dict[str, Any] = Depends(csrf_upload),
                       conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        """Импорт «Уже писали раньше» (адреса) или «Не писать» (адреса и домены): текст и/или файл."""
        kind = form.get("kind")
        refused = page_action(lambda: actions.import_refused(kind))
        typed = form.get("text", "")
        file_text, error = read_upload(form["_files"].get("file"))
        if error is None:
            try:
                outcome = actions.import_list(conn, refused, typed + "\n" + file_text)
            except actions.ActionError as exc:
                error = exc.page_message
        if error:
            return render_history(request, conn, result={"kind": kind, "error": error}, form_text={kind: typed},
                                  status_code=400)
        result = {"kind": kind, "error": None, "added": outcome.added, "skipped": outcome.skipped,
                  "invalid": outcome.invalid, "invalid_more": outcome.invalid_more}
        return render_history(request, conn, result=result)

    # ---------- письма ----------

    @app.get("/letters", response_class=HTMLResponse)
    def letters_page(request: Request, status: str | None = None, run: str | None = None, done: str | None = None,
                     edit: str | None = None, conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_letters(request, conn, status=status, run=run, done=done, edit_requested=edit == "1")

    @app.get("/letters/{draft_id:int}", response_class=HTMLResponse)
    def letter_page(request: Request, draft_id: int, status: str | None = None, run: str | None = None,
                    done: str | None = None, edit: str | None = None,
                    conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_letters(request, conn, status=status, run=run, draft_id=draft_id, done=done,
                              edit_requested=edit == "1")

    def after_decision(conn, ref: dict[str, Any], form: dict[str, str], done: str) -> RedirectResponse:
        """Из очереди: к следующему письму на проверку (или к пустой очереди). С карточки: обратно в карточку."""
        if form.get("back") != "letters":
            return _redirect(f"/companies/{ref['company_id']}?done={done}")
        run_id = parse_id(form.get("run"))
        status = form.get("status") if form.get("status") in NEXT_LETTER_FILTERS else "pending"
        next_id = q.fetch_next_pending(conn, ref, run_id)
        return _redirect(letters_url(next_id, status=status, run_id=run_id, done=done))

    @app.post("/drafts/{draft_id:int}/approve")
    def approve_draft(draft_id: int, form: dict[str, str] = Depends(csrf_form),
                      conn: psycopg.Connection = Depends(get_conn)) -> Response:
        ref = page_action(lambda: actions.draft_ref(conn, draft_id))
        page_action(lambda: actions.approve(conn, ref, REVIEWER))
        return after_decision(conn, ref, form, "approved")

    @app.post("/drafts/{draft_id:int}/reject")
    def reject_draft(draft_id: int, form: dict[str, str] = Depends(csrf_form),
                     conn: psycopg.Connection = Depends(get_conn)) -> Response:
        ref = page_action(lambda: actions.draft_ref(conn, draft_id))
        page_action(lambda: actions.reject(conn, ref, REVIEWER))
        return after_decision(conn, ref, form, "rejected")

    @app.post("/drafts/{draft_id:int}/edit")
    def edit_draft(request: Request, draft_id: int, form: dict[str, str] = Depends(csrf_form),
                   conn: psycopg.Connection = Depends(get_conn)) -> Response:
        ref = page_action(lambda: actions.draft_ref(conn, draft_id))
        from_queue = form.get("back") == "letters"
        try:
            actions.edit(conn, ref, form.get("subject", ""), form.get("body", ""))
        except actions.EditRefused as exc:  # форма открывается снова с введённым текстом
            edit = {"subject": exc.subject, "body": exc.body, "error": exc.page_message}
            if from_queue:
                return render_letters(request, conn, status=form.get("status"), run=form.get("run"),
                                      draft_id=draft_id, edit=edit, status_code=exc.page_status)
            return render_company(request, conn, ref["company_id"], edit=edit, status_code=exc.page_status)
        except actions.ActionError as exc:
            raise HTTPException(exc.page_status, exc.page_message) from exc
        if from_queue:
            status = views.letter_filter(form.get("status"), "pending")
            return _redirect(letters_url(draft_id, status=status, run_id=parse_id(form.get("run")), done="saved"))
        return _redirect(f"/companies/{ref['company_id']}?done=saved")

    @app.post("/drafts/{draft_id:int}/send-test")
    def send_test_draft(request: Request, draft_id: int, form: dict[str, Any] = Depends(csrf_form),
                        conn: psycopg.Connection = Depends(get_conn)) -> Response:
        """«Отправить тест»: письмо уходит только на адрес владельца, компании ничего не отправляется."""
        ref = page_action(lambda: actions.draft_for_test_send(conn, draft_id))
        from_queue = form.get("back") == "letters"
        status, run = form.get("status"), form.get("run")

        def show_error(message: str, status_code: int) -> HTMLResponse:
            if from_queue:
                return render_letters(request, conn, status=status, run=run, draft_id=draft_id,
                                      send_error=message, status_code=status_code)
            return render_company(request, conn, ref["company_id"], send_error=message, status_code=status_code)

        try:
            actions.send_test(conn, ref, test_to=test_to, sender=send_test)
        except actions.ActionError as exc:
            return show_error(exc.page_message, exc.page_status)
        if from_queue:
            filter_code = views.letter_filter(status, ref["review_status"])
            return _redirect(letters_url(draft_id, status=filter_code, run_id=parse_id(run), done="test_sent"))
        return _redirect(f"/companies/{ref['company_id']}?done=test_sent")

    # ---------- API для живого хода запуска ----------

    def run_payload(conn, row: dict[str, Any]) -> JSONResponse:
        cost = q.fetch_run_costs(conn, [row["id"]]).get(row["id"], Cost())
        payload = views.run_json(row, cost, letters_pending=q.count_pending_letters(conn, row["id"]),
                                 pending_total=q.count_pending_letters(conn))
        return JSONResponse(jsonable_encoder(payload))

    @app.get("/api/runs/active")
    def api_active_run(conn: psycopg.Connection = Depends(get_conn)) -> JSONResponse:
        row = q.fetch_active_run(conn)
        if row is None:
            raise HTTPException(404, "Сейчас ничего не идёт.")
        return run_payload(conn, row)

    @app.get("/api/runs/{run_id:int}")
    def api_run(run_id: int, conn: psycopg.Connection = Depends(get_conn)) -> JSONResponse:
        row = q.fetch_run(conn, run_id) if run_id <= MAX_DB_ID else None
        if row is None:
            raise HTTPException(404, "Запуск не найден.")
        return run_payload(conn, row)

    return app


def log_config() -> dict[str, Any]:
    """Логи uvicorn как по умолчанию, но в access-логе нет строки запроса (телефоны клиентов бота).

    Логи приложения от INFO идут туда же, куда ошибки uvicorn: например, кто снял отметку WhatsApp.
    """
    config = copy.deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["filters"] = {"hide_query": {"()": internal.HideQuery}}
    config["loggers"]["uvicorn.access"]["filters"] = ["hide_query"]
    config["formatters"]["app"] = {"()": "uvicorn.logging.DefaultFormatter",
                                   "fmt": "%(asctime)s %(levelprefix)s %(message)s"}
    config["handlers"]["app"] = {"formatter": "app", "class": "logging.StreamHandler", "stream": "ext://sys.stderr"}
    config["loggers"]["tanbala_leads"] = {"handlers": ["app"], "level": "INFO", "propagate": False}
    return config


def server_options(host: str, port: int) -> dict[str, Any]:
    """Настройки uvicorn для serve(): без заголовков прокси и Server, логи через log_config()."""
    return {"host": host, "port": port, "proxy_headers": False, "server_header": False, "log_config": log_config()}


def check_tokens(internal_token: str | None, console_token: str | None) -> None:
    """Токен консоли не может совпадать с токеном бота: бот получил бы права одобрять письма и запускать поиск.

    Текст ошибки без значений токенов.
    """
    if console_token and console_token == internal_token:
        raise ValueError("LEADS_CONSOLE_TOKEN совпадает с INTERNAL_API_TOKEN: у консоли и бота должны быть"
                         " разные токены")


def log_startup(settings: Settings, public_host: str | None, port: int, ui_port: int | None) -> None:
    logger.info("Внутренний API (бот и консоль): http://%s:%s/internal", BIND_HOST, port)
    if ui_port is not None:
        logger.info("Интерфейс: http://%s:%s", BIND_HOST, ui_port)
    else:
        logger.info("Интерфейса нет: порт --ui-port не задан")
    if public_host:
        logger.info("Интерфейс открыт и по имени %s (через Caddy, HTTPS); внутренний API по нему недоступен",
                    public_host)
    if not internal.token_ok(settings.internal_api_token, settings.internal_api_token):
        logger.warning("Внутренний API выключен: INTERNAL_API_TOKEN пустой или короче %s символов",
                       internal.MIN_TOKEN_CHARS)
    if not console.token_valid(settings.leads_console_token):
        logger.warning("API консоли выключен: LEADS_CONSOLE_TOKEN пустой или не от 32 до 512 видимых символов ASCII")


def serve(host: str = BIND_HOST, port: int = DEFAULT_API_PORT, ui_port: int | None = None) -> None:
    """Настоящее приложение: миграции, пометить прерванные запуски и проверки, uvicorn только на 127.0.0.1.

    port: внутренний API (/internal: бот и консоль), больше ничего. ui_port: старый интерфейс на своём порту;
    без него интерфейса нет (python -m tanbala_leads web передаёт --ui-port всегда, по умолчанию 8001).
    Оба сокета занимаются до базы: если порт занят, прерванные запуски не помечаются и сервер не стартует.
    """
    if host != BIND_HOST:
        raise ValueError(f"Интерфейс слушает только {BIND_HOST}: он может тратить деньги на API")
    check_ports(port, ui_port)
    settings = load_settings()
    check_tokens(settings.internal_api_token, settings.leads_console_token)
    dsn = settings.require("database_url")
    budget = pipeline.daily_budget(settings)
    per_day = research.per_day_limit(settings)
    # Браузеры общие для поиска и проверок из WhatsApp: не больше MAX_2GIS_BROWSERS и MAX_SITE_BROWSERS сразу
    # (по умолчанию по одному, VPS 4 ГБ). Неверная настройка останавливает запуск до миграций.
    limits = browsers.limits_from_settings(settings)
    # Имя интерфейса за Caddy (PUBLIC_UI_HOST) и режим Chrome для 2ГИС (PARSER_2GIS_HEADLESS): неверное значение
    # тоже останавливает запуск до миграций, а не первый поиск.
    public_host = parse_public_host(settings.public_ui_host)
    collect.check_parser_setup(settings.parser_2gis_bin, collect.parse_headless(settings.parser_2gis_headless))
    try:
        test_address = send_step.test_recipient(settings)
    except send_step.SendBlocked:
        test_address = None  # баннер «Тестовая отправка выключена», кнопка неактивна
    sockets = bind_sockets(host, (port, ui_port)) if ui_port is not None else []
    try:
        with db.connect(dsn) as conn:
            db.migrate(conn)
            pipeline.recover_stale_runs(conn)
            research.recover_stale_jobs(conn)
        research_queue = research.ResearchQueue(
            connect=lambda: db.connect(dsn),
            deps_factory=lambda: pipeline.default_deps(load_settings(), limits, urgent=True),
            per_day=per_day,
            budget_usd=budget,
        )
        app = create_app(
            connect=lambda: db.connect(dsn),
            start_run=lambda city, query, n: pipeline.start_run(dsn, city, query, n, limits=limits),
            daily_budget_usd=budget,
            send_test=lambda conn, draft_id: send_step.send_test(conn, draft_id, load_settings()),
            test_address=test_address,
            internal_token=settings.internal_api_token,
            research_queue=research_queue,
            public_host=public_host,
            console_token=settings.leads_console_token,
            api_port=port,
            ui_port=ui_port,
        )
        research_queue.kick()  # задачи, оставшиеся в очереди до перезапуска
        options = server_options(host, port)
        if not sockets:  # только API: порт занимает сам uvicorn
            log_startup(settings, public_host, port, ui_port)
            uvicorn.run(app, **options)
            return
        server = make_server(app, options)
        log_startup(settings, public_host, port, ui_port)
        run_server(server, sockets)
    finally:
        for sock in sockets:
            sock.close()
