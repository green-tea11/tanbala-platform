"""Веб-интерфейс поиска клиентов: поиск по кнопке, очередь писем, компании и «кому писали».

Работает только на 127.0.0.1. Страницы показывают текст с чужих сайтов и от модели, поэтому:
Jinja экранирует всё, ссылки выводятся только http(s), в JS данные попадают только через textContent,
каждый POST требует CSRF-токен и своё Origin. Отправки писем здесь нет.

Модули: labels (подписи и лимиты), format (форматирование), queries (чтение из базы),
views (данные для шаблонов), этот файл: безопасность, маршруты и запуск.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from http import HTTPStatus
from pathlib import Path
from typing import Any

import psycopg
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from jinja2 import Environment, FileSystemLoader, StrictUndefined
from starlette.datastructures import UploadFile  # request.form() отдаёт файлы этого класса, не fastapi.UploadFile
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from tanbala_leads import __version__, contact_policy, db, pipeline
from tanbala_leads.settings import load_settings
from tanbala_leads.steps import approve as approve_step
from tanbala_leads.web import queries as q
from tanbala_leads.web import views
from tanbala_leads.web.format import (
    Cost,
    decode_upload,
    fmt_dt,
    fmt_int,
    format_usd,
    letters_url,
    parse_id,
    plural,
    prepare_import_text,
)
from tanbala_leads.web.labels import (
    BLOCKED_MESSAGE,
    COMPANY_STATUSES,
    DB_ERROR_MESSAGE,
    DONE_MESSAGES,
    ERROR_MESSAGES,
    IMPORT_INVALID_SHOWN,
    IMPORT_KINDS,
    LETTER_FORMS,
    MAX_DB_ID,
    MAX_FORM_BYTES,
    MAX_UPLOAD_BYTES,
    POLL_INTERVAL_MS,
    REVIEWER,
    TOKEN_FORMS,
)

logger = logging.getLogger(__name__)

WEB_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = WEB_DIR / "templates"
STATIC_DIR = WEB_DIR / "static"

BIND_HOST = "127.0.0.1"
# Защита от DNS rebinding: чужое имя хоста в запросе получает 400.
ALLOWED_HOSTS = ("127.0.0.1", "localhost")
CSP = (
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; "
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
)
REJECTED_MESSAGE = "Письмо уже отклонено. Новый черновик напишет следующий запуск."
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
    env.filters.update(fmt_int=fmt_int, fmt_dt=fmt_dt, plural=plural)
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


def create_app(connect: Callable[[], psycopg.Connection], start_run: Callable[[str, str, int], int], *,
               csrf_token: str | None = None, daily_budget_usd: float | None = None) -> FastAPI:
    """Собрать приложение. connect открывает соединение на запрос, start_run запускает поиск в фоне.

    daily_budget_usd: суточный лимит расходов на API для сводки на странице поиска (None: не показывать).
    """
    token = csrf_token or secrets.token_urlsafe(32)
    templates = _make_templates()
    app = FastAPI(title="Tanbala", docs_url=None, redoc_url=None, openapi_url=None)
    app.middleware("http")(_security_headers)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(ALLOWED_HOSTS))
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

    def make_csrf_form(max_bytes: int) -> Callable:
        async def csrf_form(request: Request) -> dict[str, Any]:
            """Каждый POST: своё Origin, разумный размер и токен из скрытого поля.

            Вернуть текстовые поля формы; файлы (только у импорта) лежат отдельно в ключе "_files".
            """
            origin = request.headers.get("origin")
            own_origin = f"{request.url.scheme}://{request.headers.get('host', '')}"
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
                **context}
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

    def render_company(request: Request, conn, company_id: int, *, done: str | None = None,
                       edit: dict | None = None, edit_requested: bool = False, status_code: int = 200) -> HTMLResponse:
        context = views.company_context(conn, company_id)
        if context is None:
            raise HTTPException(404, "Компания не найдена.")
        context.update(done_message=DONE_MESSAGES.get(done or ""), **edit_state(context["draft"], edit, edit_requested))
        return render(request, "company.html", context, conn=conn, status_code=status_code)

    def render_letters(request: Request, conn, *, status: str | None, run: str | None, draft_id: int | None = None,
                       done: str | None = None, edit: dict | None = None, edit_requested: bool = False,
                       status_code: int = 200) -> HTMLResponse:
        selected = None
        if draft_id is not None:
            selected = q.fetch_letter(conn, draft_id)
            if selected is None:
                raise HTTPException(404, "Письмо не найдено.")
        filter_code = views.letter_filter(status, selected["review_status"] if selected else None)
        context = views.letters_context(conn, filter_code=filter_code, run_id=parse_id(run), selected=selected)
        context.update(done_message=DONE_MESSAGES.get(done or ""), **edit_state(context["letter"], edit, edit_requested))
        return render(request, "letters.html", context, conn=conn, status_code=status_code)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> Response:
        detail = exc.detail if isinstance(exc.detail, str) else ""
        if not detail or detail == HTTPStatus(exc.status_code).phrase:
            detail = ERROR_MESSAGES.get(exc.status_code, "Что-то пошло не так.")
        if request.url.path.startswith("/api/"):
            return JSONResponse({"detail": detail}, status_code=exc.status_code)
        context = {"title": "Ошибка", "nav": "", "status_code": exc.status_code, "message": detail}
        return render(request, "error.html", context, status_code=exc.status_code)

    @app.exception_handler(psycopg.Error)
    async def db_error(request: Request, exc: psycopg.Error) -> Response:
        # Текст ошибки не пишем: в нём бывают адрес сервера и имя пользователя базы.
        logger.error("Ошибка базы данных: %s, sqlstate=%s", type(exc).__name__, getattr(exc, "sqlstate", None))
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
        count = parse_id(count_text)
        try:
            if count is None:
                raise ValueError(f"Число компаний должно быть от 1 до {pipeline.MAX_COMPANIES_LIMIT}")
            run_id = start_run(city, query, count)
        except pipeline.RunAlreadyActive as exc:
            message, status_code = str(exc), 409
        except ValueError as exc:  # в том числе BudgetExceeded: суточный лимит расходов
            message, status_code = str(exc), 400
        else:
            return _redirect(f"/?run={int(run_id)}")
        with open_conn() as conn:
            return render_search(request, conn, form=values, message=message, status_code=status_code)

    # ---------- компании ----------

    @app.get("/companies", response_class=HTMLResponse)
    def companies_page(request: Request, run: str | None = None, status: str | None = None,
                       text: str | None = Query(None, alias="q"), page: str | None = None,
                       conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        filters = views.CompanyFilters(
            run_id=parse_id(run), status=status if status in COMPANY_STATUSES else None,
            q=" ".join((text or "").split())[: pipeline.MAX_QUERY_LENGTH], page=max(1, parse_id(page) or 1))
        return render(request, "companies.html", views.companies_context(conn, filters), conn=conn)

    @app.get("/companies/{company_id:int}", response_class=HTMLResponse)
    def company_page(request: Request, company_id: int, done: str | None = None, edit: str | None = None,
                     conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        return render_company(request, conn, company_id, done=done, edit_requested=edit == "1")

    @app.post("/companies/{company_id:int}/block")
    def block_company(company_id: int, form: dict[str, Any] = Depends(csrf_form),
                      conn: psycopg.Connection = Depends(get_conn)) -> Response:
        """«Больше не писать»: компания и её корпоративный домен в do_not_contact."""
        if q.fetch_company(conn, company_id) is None:
            raise HTTPException(404, "Компания не найдена.")
        contact_policy.block_company(conn, company_id, note="кнопка «Больше не писать»")
        return _redirect(f"/companies/{company_id}?done=blocked")

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
        data = upload.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            return "", "Файл больше 1 МБ. Разделите список на части."
        text = decode_upload(data)
        if text is None:
            return "", "Файл не в кодировке UTF-8. Сохраните его как UTF-8 и загрузите снова."
        return text, None

    @app.post("/history/import")
    def import_history(request: Request, form: dict[str, Any] = Depends(csrf_upload),
                       conn: psycopg.Connection = Depends(get_conn)) -> HTMLResponse:
        """Импорт «Уже писали раньше» (адреса) или «Не писать» (адреса и домены): текст и/или файл."""
        kind = form.get("kind")
        if kind not in IMPORT_KINDS:
            raise HTTPException(400, "Неизвестный список.")
        typed = form.get("text", "")
        file_text, error = read_upload(form["_files"].get("file"))
        items = prepare_import_text(typed + "\n" + file_text)
        if error is None and not items:
            error = "Список пуст: вставьте адреса или выберите файл."
        if error:
            return render_history(request, conn, result={"kind": kind, "error": error}, form_text={kind: typed},
                                  status_code=400)
        outcome = contact_policy.import_contacts(conn, items, refused=IMPORT_KINDS[kind])
        result = {"kind": kind, "error": None, "added": outcome.added, "skipped": outcome.skipped,
                  "invalid": outcome.invalid[:IMPORT_INVALID_SHOWN],
                  "invalid_more": max(0, len(outcome.invalid) - IMPORT_INVALID_SHOWN)}
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

    def draft_ref(conn, draft_id: int) -> dict[str, Any]:
        ref = q.fetch_draft_ref(conn, draft_id)
        if ref is None:
            raise HTTPException(404, "Письмо не найдено.")
        # Кнопки отклонённого письма скрыты; старая вкладка или повтор запроса не должны его вернуть.
        if ref["review_status"] == "rejected":
            raise HTTPException(409, REJECTED_MESSAGE)
        return ref

    def run_action(action: Callable[[], Any]) -> None:
        try:
            action()
        except approve_step.DraftNotFound as exc:
            raise HTTPException(409, "Письмо уже отправлено или отклонено.") from exc
        except psycopg.errors.IntegrityError as exc:
            raise HTTPException(409, "У компании уже есть другое активное письмо.") from exc

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
        ref = draft_ref(conn, draft_id)
        # Кнопка у такой компании выключена; сервер не полагается на то, что её не нажали.
        if ref["blocked"]:
            raise HTTPException(409, BLOCKED_MESSAGE)
        run_action(lambda: approve_step.approve(conn, draft_id, REVIEWER))
        return after_decision(conn, ref, form, "approved")

    @app.post("/drafts/{draft_id:int}/reject")
    def reject_draft(draft_id: int, form: dict[str, str] = Depends(csrf_form),
                     conn: psycopg.Connection = Depends(get_conn)) -> Response:
        ref = draft_ref(conn, draft_id)
        run_action(lambda: approve_step.reject(conn, draft_id, REVIEWER))
        return after_decision(conn, ref, form, "rejected")

    @app.post("/drafts/{draft_id:int}/edit")
    def edit_draft(request: Request, draft_id: int, form: dict[str, str] = Depends(csrf_form),
                   conn: psycopg.Connection = Depends(get_conn)) -> Response:
        ref = draft_ref(conn, draft_id)
        subject, body, error = views.validate_draft_edit(form.get("subject", ""), form.get("body", ""))
        from_queue = form.get("back") == "letters"
        if error:
            edit = {"subject": subject, "body": body, "error": error}
            if from_queue:
                return render_letters(request, conn, status=form.get("status"), run=form.get("run"),
                                      draft_id=draft_id, edit=edit, status_code=400)
            return render_company(request, conn, ref["company_id"], edit=edit, status_code=400)
        run_action(lambda: approve_step.update_draft(conn, draft_id, subject, body))
        if from_queue:
            status = views.letter_filter(form.get("status"), "pending")
            return _redirect(letters_url(draft_id, status=status, run_id=parse_id(form.get("run")), done="saved"))
        return _redirect(f"/companies/{ref['company_id']}?done=saved")

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


def serve(host: str = BIND_HOST, port: int = 8000) -> None:
    """Настоящее приложение: миграции, пометить прерванные запуски, uvicorn только на 127.0.0.1."""
    if host != BIND_HOST:
        raise ValueError(f"Интерфейс слушает только {BIND_HOST}: он может тратить деньги на API")
    settings = load_settings()
    dsn = settings.require("database_url")
    budget = pipeline.daily_budget(settings)
    with db.connect(dsn) as conn:
        db.migrate(conn)
        pipeline.recover_stale_runs(conn)
    app = create_app(
        connect=lambda: db.connect(dsn),
        start_run=lambda city, query, n: pipeline.start_run(dsn, city, query, n),
        daily_budget_usd=budget,
    )
    uvicorn.run(app, host=host, port=port, proxy_headers=False, server_header=False)
