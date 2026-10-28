"""Access-лог uvicorn: у путей /internal/... нет строки запроса, номера клиентов бота в лог не попадают."""

import io
import logging
import logging.config
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest
import uvicorn

from tanbala_leads.web import app as web
from tanbala_leads.web import create_app
from tanbala_leads.web.internal import HideInternalQuery

PHONE = "77001234567"
ACCESS_FORMAT = '%s - "%s %s HTTP/%s" %d'  # как пишет uvicorn (protocols/http/h11_impl.py)


def access_record(path: str) -> logging.LogRecord:
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, ACCESS_FORMAT,
                             ("127.0.0.1:50000", "GET", path, "1.1", 200), None)


@pytest.mark.parametrize(("path", "logged"), [
    (f"/internal/lookup?phone={PHONE}", "/internal/lookup"),
    ("/internal/lookup?domain=ivan%40sklad.kz&name=%D0%B0", "/internal/lookup"),
    ("/internal?phone=1", "/internal"),
    (f"//internal/lookup?phone={PHONE}", "//internal/lookup"),
    ("/internal/research/3f2c9e0a-0000-4000-8000-000000000000", "/internal/research/3f2c9e0a-0000-4000-8000-000000000000"),
    ("/companies?q=склад", "/companies?q=склад"),
    ("/internalx?phone=1", "/internalx?phone=1"),
])
def test_query_of_internal_paths_is_dropped(path, logged):
    record = access_record(path)

    assert HideInternalQuery().filter(record) is True
    assert record.getMessage() == f'127.0.0.1:50000 - "GET {logged} HTTP/1.1" 200'


def test_other_records_are_kept_as_is():
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "%s %s", ("a", f"?phone={PHONE}"), None)

    assert HideInternalQuery().filter(record) is True
    assert record.args == ("a", f"?phone={PHONE}")


@pytest.fixture
def live_server():
    """Настоящий uvicorn с настройками serve() на свободном порту, access-лог в буфер."""
    buffer = io.StringIO()
    options = web.server_options("127.0.0.1", 0)
    options["log_config"]["handlers"]["access"]["stream"] = buffer
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    app = create_app(lambda: pytest.fail("нет базы"), lambda *args: 1, csrf_token="csrf", internal_token="t" * 40)
    server = uvicorn.Server(uvicorn.Config(app, **options))
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}", buffer
    server.should_exit = True
    thread.join(10)
    sock.close()
    logging.config.dictConfig(uvicorn.config.LOGGING_CONFIG)  # вернуть логи uvicorn на stdout для других тестов


def get_status(url: str) -> int:
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code


def test_live_server_does_not_log_client_phone(live_server):
    base, buffer = live_server

    # Host «127.0.0.1:порт», как у бота: проходит до токена (401), а не 400.
    assert get_status(f"{base}/internal/lookup?phone={PHONE}&name=%D0%A0%D0%B0%D1%85%D0%B0%D1%82") == 401
    assert get_status(f"{base}/static/app.css?v=1") == 200

    log = buffer.getvalue()
    assert '"GET /internal/lookup HTTP/1.1" 401' in log
    assert PHONE not in log and "name=" not in log
    assert '"GET /static/app.css?v=1 HTTP/1.1" 200' in log
