"""Порты: на --port (8000) только /internal (бот и консоль), на --ui-port (8001) только интерфейс. Решает порт сокета.

Так процесс, которому nftables разрешает 127.0.0.1:8000 (бот), не нажмёт кнопки интерфейса. Без сети наружу,
настоящие сокеты только на свободных портах 127.0.0.1 (не 8000 и не 8001).
"""

import asyncio
import contextlib
import logging
import logging.config
import sys
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn
from console_support import AUTH, BOT_AUTH, CONSOLE_TOKEN, FakeStartRun, make_app
from fastapi.testclient import TestClient

from tanbala_leads import cli
from tanbala_leads.settings import load_settings
from tanbala_leads.web import app as web
from tanbala_leads.web import ports

API, UI = 8000, 8001
UI_PATHS = ["/", "/static/app.css", "/companies", "/companies/1", "/letters", "/history", "/docs", "/api/runs/1",
            "/api/runs/active", "/favicon.ico"]
INTERNAL_LIKE = ["/internal", "/internal/", "/internal/lookup?domain=sklad.kz", "/internal/companies/1/brief",
                 "/internal/research", "/internal/console", "/internal/console/summary",
                 "/internal/console/search/options", "/INTERNAL/lookup", "/Internal/console/summary", "/internalx",
                 "/internal%2Fconsole%2Fsummary"]


def split_app(ui_port=UI, start_run=None, **options):
    return make_app(api_port=API, ui_port=ui_port, start_run=start_run, **options)


def client(app, port: int) -> TestClient:
    return TestClient(app, base_url=f"http://127.0.0.1:{port}")


def not_found(response) -> bool:
    """Ответ PortSplit: 404 простым текстом, до приложения (у страниц интерфейса 404 — HTML)."""
    return (response.status_code, response.text) == (404, "Not Found")


# ---------- порт API ----------


def test_api_port_serves_bot_and_console_api():
    api = client(split_app(), API)

    assert api.get("/internal/lookup?domain=sklad.kz").json() == {"error": "unauthorized"}
    assert api.get("/internal/nope", headers=BOT_AUTH).json() == {"error": "not_found"}
    assert api.get("/internal/console/search/options", headers=AUTH).status_code == 200
    assert api.get("/internal/console/nope", headers=AUTH).json()["error"] == "not_found"


@pytest.mark.parametrize("path", UI_PATHS + ["/INTERNAL/lookup", "/internalx"])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_api_port_has_no_interface(path, method):
    response = client(split_app(), API).request(method, path, headers={**AUTH, **BOT_AUTH})

    assert not_found(response)


def test_bot_on_api_port_cannot_press_interface_buttons():
    """Даже с верным CSRF-токеном и своим Origin форма на порту API не доходит до приложения."""
    start_run = FakeStartRun()
    api = client(split_app(start_run=start_run), API)
    form = {"csrf_token": "csrf", "city": "almaty", "query": "склад", "max_companies": "5"}

    for path in ("/runs", "/drafts/1/approve", "/companies/1/block", "/history/import"):
        assert not_found(api.post(path, data=form, headers={"Origin": f"http://127.0.0.1:{API}"}))
    assert start_run.calls == []


# ---------- порт интерфейса ----------


def test_ui_port_serves_interface():
    start_run = FakeStartRun(result=9)
    ui = client(split_app(start_run=start_run), UI)

    assert ui.get("/static/app.css").status_code == 200
    page = ui.get("/docs")  # страница ошибки интерфейса, без базы
    assert page.status_code == 404 and "Такой страницы нет." in page.text
    response = ui.post("/runs", data={"csrf_token": "csrf", "city": "almaty", "query": "склад", "max_companies": "5"},
                       headers={"Origin": f"http://127.0.0.1:{UI}"}, follow_redirects=False)
    assert (response.status_code, response.headers["location"]) == (303, "/?run=9")


@pytest.mark.parametrize("host", [None, "127.0.0.1", "127.0.0.1:8000", "localhost:8001", "leads.tanbala.kz"])
@pytest.mark.parametrize("path", INTERNAL_LIKE)
def test_ui_port_never_reaches_internal_api(path, host):
    ui = client(split_app(public_host="leads.tanbala.kz"), UI)
    headers = {**AUTH, **BOT_AUTH, **({"Host": host} if host else {})}

    assert not_found(ui.get(path, headers=headers))
    assert not_found(ui.post(path, headers=headers, json={"name": "Рахат"}))


@pytest.mark.parametrize(("port", "path"), [(UI, "//internal/lookup"), (UI, "///INTERNAL/console/summary"),
                                            (API, "//internal/lookup"), (API, "/")])
def test_raw_paths_with_extra_slashes(port, path):
    """Путь «//internal/...» клиент может прислать как есть; TestClient счёл бы «internal» хостом."""
    app = split_app()
    scope = {"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": "GET", "scheme": "http",
             "path": path, "raw_path": path.encode(), "query_string": b"", "root_path": "",
             "headers": [(b"host", f"127.0.0.1:{port}".encode()), (b"x-console-token", CONSOLE_TOKEN.encode())],
             "server": ("127.0.0.1", port), "client": ("127.0.0.1", 50000)}
    sent: list[dict] = []

    async def receive() -> dict:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict) -> None:
        sent.append(message)

    asyncio.run(app(scope, receive, send))

    assert sent[0]["status"] == 404
    assert b"".join(m.get("body", b"") for m in sent[1:]) == b"Not Found"


@pytest.mark.parametrize("port", [80, 8002, 3100])
def test_unknown_port_gets_nothing(port):
    other = client(split_app(), port)

    assert not_found(other.get("/static/app.css"))
    assert not_found(other.get("/internal/console/search/options", headers=AUTH))


def test_without_ui_port_there_is_no_interface_at_all():
    app = split_app(ui_port=None)

    assert client(app, API).get("/internal/console/search/options", headers=AUTH).status_code == 200
    assert not_found(client(app, API).get("/static/app.css"))
    assert not_found(client(app, UI).get("/static/app.css"))


def test_unknown_socket_and_websocket_are_refused():
    app = split_app()
    for server in (None, ("/run/app.sock", None)):
        scope = {"type": "http", "method": "GET", "path": "/static/app.css", "raw_path": b"/static/app.css",
                 "query_string": b"", "headers": [(b"host", b"127.0.0.1")], "server": server}
        sent: list[dict] = []

        async def send(message: dict) -> None:
            sent.append(message)

        async def receive() -> dict:
            return {"type": "http.request", "body": b"", "more_body": False}

        asyncio.run(app(scope, receive, send))
        assert sent[0]["status"] == 404
    closed: list[dict] = []

    async def ws_send(message: dict) -> None:
        closed.append(message)

    asyncio.run(ports.PortSplit(lambda *a: pytest.fail("до приложения дойти не должно"), API, UI)(
        {"type": "websocket", "path": "/internal/lookup", "server": ("127.0.0.1", UI)}, None, ws_send))
    assert closed == [{"type": "websocket.close", "code": 1008}]


def test_ui_port_needs_api_port():
    with pytest.raises(ValueError, match="ui_port"):
        make_app(ui_port=UI)


@pytest.mark.parametrize(("port", "ui_port"), [(8000, 8000), (0, 8001), (8000, 70000), (65536, 8001)])
def test_bad_ports_are_refused(port, ui_port):
    with pytest.raises(ValueError, match="[Пп]орт|port"):
        ports.check_ports(port, ui_port)


# ---------- serve() и командная строка ----------


class FakeQueue:
    per_day = 20

    def __init__(self, **kwargs):
        pass

    def kick(self):
        pass


class FakeSocket:
    def __init__(self, port: int):
        self.port = port
        self.closed = False

    def close(self):
        self.closed = True


def patch_serve(monkeypatch, events: list, env: dict | None = None) -> dict:
    """serve() без базы, браузеров и сети: всё внешнее записывает события по порядку."""
    calls: dict = {}
    monkeypatch.setattr(web, "load_settings", lambda: load_settings({
        "DATABASE_URL": "postgresql://test", "PARSER_2GIS_BIN": sys.executable, "PARSER_2GIS_HEADLESS": "true",
        "INTERNAL_API_TOKEN": "b" * 40, "LEADS_CONSOLE_TOKEN": CONSOLE_TOKEN, **(env or {})}))

    def bind(host, wanted):
        events.append(("bind", host, wanted))
        calls["sockets"] = [FakeSocket(port) for port in wanted]
        return calls["sockets"]

    def connect(dsn):
        events.append(("db",))
        return contextlib.nullcontext(object())

    monkeypatch.setattr(web, "bind_sockets", bind)
    monkeypatch.setattr(web.db, "connect", connect)
    monkeypatch.setattr(web.db, "migrate", lambda conn: [])
    monkeypatch.setattr(web.pipeline, "recover_stale_runs", lambda conn: events.append(("recover",)))
    monkeypatch.setattr(web.research, "recover_stale_jobs", lambda conn: 0)
    monkeypatch.setattr(web.research, "ResearchQueue", FakeQueue)
    monkeypatch.setattr(web, "create_app", lambda **kwargs: calls.setdefault("app", kwargs))
    monkeypatch.setattr(web, "make_server", lambda app, options: calls.setdefault("server", ("server", options)))
    monkeypatch.setattr(web, "run_server", lambda server, sockets: events.append(("run", server, sockets)))
    monkeypatch.setattr(web.uvicorn, "run", lambda app, **options: events.append(("uvicorn.run", options)))
    return calls


def test_serve_binds_both_ports_before_database_and_runs_one_server(monkeypatch):
    events: list = []
    calls = patch_serve(monkeypatch, events)

    web.serve(ui_port=UI)

    assert events[0] == ("bind", "127.0.0.1", (API, UI))
    assert events[1:3] == [("db",), ("recover",)]
    run = events[-1]
    assert run[0] == "run" and run[1] is calls["server"] and [s.port for s in run[2]] == [API, UI]
    assert calls["server"][1]["host"] == "127.0.0.1" and calls["server"][1]["proxy_headers"] is False
    app = calls["app"]
    assert (app["api_port"], app["ui_port"], app["console_token"]) == (API, UI, CONSOLE_TOKEN)
    assert all(sock.closed for sock in calls["sockets"])
    assert not [event for event in events if event[0] == "uvicorn.run"]


def test_serve_without_ui_port_serves_only_api_through_uvicorn_run(monkeypatch):
    events: list = []
    calls = patch_serve(monkeypatch, events)

    web.serve()

    assert [event[0] for event in events] == ["db", "recover", "uvicorn.run"]
    assert events[-1][1]["port"] == API and (calls["app"]["api_port"], calls["app"]["ui_port"]) == (API, None)


def test_busy_port_stops_serve_before_database(monkeypatch):
    events: list = []
    patch_serve(monkeypatch, events)

    def busy(host, wanted):
        raise OSError(98, "Не удалось занять 127.0.0.1:8001, порт занят? (Address already in use)")

    monkeypatch.setattr(web, "bind_sockets", busy)

    with pytest.raises(OSError, match="8001"):
        web.serve(ui_port=UI)
    assert events == []


def test_sockets_are_closed_when_startup_fails(monkeypatch):
    events: list = []
    calls = patch_serve(monkeypatch, events)
    monkeypatch.setattr(web.db, "migrate", lambda conn: (_ for _ in ()).throw(RuntimeError("миграция упала")))

    with pytest.raises(RuntimeError, match="миграция"):
        web.serve(ui_port=UI)
    assert all(sock.closed for sock in calls["sockets"])


@pytest.mark.parametrize(("argv", "expected"), [
    (["web"], {"port": 8000, "ui_port": 8001}),
    (["web", "--port", "9000", "--ui-port", "9001"], {"port": 9000, "ui_port": 9001}),
])
def test_cli_web_passes_both_ports(monkeypatch, argv, expected):
    seen: list[dict] = []
    monkeypatch.setattr(web, "serve", lambda **kwargs: seen.append(kwargs))

    assert cli.main(argv) == 0
    assert seen == [expected]


def test_busy_port_cannot_be_taken_twice():
    """bind_socket сразу слушает: второй процесс не займёт порт ни на Windows, ни на Linux (SO_REUSEADDR)."""
    first = ports.bind_socket("127.0.0.1", 0)
    try:
        port = first.getsockname()[1]
        with pytest.raises(OSError, match=f"Не удалось занять 127.0.0.1:{port}"):
            ports.bind_socket("127.0.0.1", port)
    finally:
        first.close()


# ---------- настоящий uvicorn на двух сокетах ----------


def get_status(url: str, headers: dict | None = None) -> int:
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


@pytest.fixture
def live_ports():
    """Один uvicorn с настройками serve() на двух свободных портах; после теста логи как были."""
    sockets = ports.bind_sockets("127.0.0.1", (0, 0))
    api_port, ui_port = (sock.getsockname()[1] for sock in sockets)
    app = make_app(lambda: pytest.fail("нет базы"), api_port=api_port, ui_port=ui_port)
    server = ports.make_server(app, web.server_options("127.0.0.1", api_port))
    thread = threading.Thread(target=server.run, kwargs={"sockets": sockets}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "uvicorn не запустился за 10 с"
    yield api_port, ui_port
    server.should_exit = True
    thread.join(10)
    for sock in sockets:
        sock.close()
    logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)
    app_logger = logging.getLogger("tanbala_leads")
    app_logger.handlers.clear()
    app_logger.propagate, app_logger.level = True, logging.NOTSET


def test_one_uvicorn_splits_by_socket_port(live_ports):
    api_port, ui_port = live_ports
    api, ui = f"http://127.0.0.1:{api_port}", f"http://127.0.0.1:{ui_port}"

    assert get_status(f"{api}/internal/console/search/options", AUTH) == 200
    assert get_status(f"{api}/internal/lookup?domain=sklad.kz") == 401
    assert get_status(f"{api}/static/app.css") == 404
    assert get_status(f"{ui}/static/app.css") == 200
    assert get_status(f"{ui}/internal/console/search/options", AUTH) == 404
    assert get_status(f"{ui}/internal/lookup?domain=sklad.kz", {**BOT_AUTH, "Host": f"127.0.0.1:{api_port}"}) == 404
