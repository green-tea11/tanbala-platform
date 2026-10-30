"""Порты сервера: внутренний API (/internal) и старый интерфейс на разных портах одного uvicorn.

Решение владельца (риск 3 плана консоли): бот по nftables может ходить на 127.0.0.1:8000, поэтому на 8000 только
/internal, а интерфейс с кнопками на своём порту (8001), куда на сервере пускается только Caddy. Проверка Host или
Origin этого не даёт: локальный процесс подставит любые заголовки, а порт, на который он подключился, подменить нельзя.
"""

import os
import socket
import sys
from typing import Any

import uvicorn
from fastapi.responses import PlainTextResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from uvicorn.server import STARTUP_FAILURE

from tanbala_leads.web import internal

LISTEN_BACKLOG = 2048  # как у uvicorn по умолчанию; uvicorn потом вызывает listen() ещё раз, это безвредно


class PortSplit:
    """API и интерфейс на разных портах одного сервера. Решает порт сокета (scope["server"]), а не Host:
    заголовки локальный процесс подставит любые, а порт, на который он подключился, нет.

    api_port: только /internal (бот и консоль), любой другой путь 404. ui_port: только интерфейс, любой путь,
    похожий на /internal (регистр, лишние «/»), 404 при любом Host. ui_port None: интерфейса нет.
    Другой или неизвестный порт: 404. Самый внешний слой, до HostRules.
    """

    def __init__(self, app: ASGIApp, api_port: int, ui_port: int | None = None):
        self.app = app
        self.api_port = api_port
        self.ui_port = ui_port

    def allowed(self, scope: Scope) -> bool:
        server = scope.get("server")
        port = server[1] if server and len(server) == 2 else None
        if port == self.api_port:
            return internal.is_internal_path(scope["path"])
        return self.ui_port is not None and port == self.ui_port and not internal.looks_internal(scope["path"])

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and not self.allowed(scope):
            await PlainTextResponse("Not Found", status_code=404)(scope, receive, send)
            return
        if scope["type"] == "websocket" and not self.allowed(scope):
            await send({"type": "websocket.close", "code": 1008})
            return
        await self.app(scope, receive, send)


def check_ports(port: int, ui_port: int | None) -> None:
    for value in (port, ui_port):
        if value is not None and not 1 <= value <= 65535:
            raise ValueError("Порт должен быть от 1 до 65535")
    if port == ui_port:
        raise ValueError("--port и --ui-port должны быть разными: на одном только /internal, на другом интерфейс")


def bind_socket(host: str, port: int) -> socket.socket:
    """Сокет для uvicorn. На Windows порт занимается монопольно: SO_REUSEADDR там дал бы занять чужой порт."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)  # быстрый перезапуск после TIME_WAIT
        sock.bind((host, port))
        # Сразу слушать: на Linux с SO_REUSEADDR второй bind проходит, пока порт никто не слушает.
        sock.listen(LISTEN_BACKLOG)
    except OSError as exc:
        sock.close()
        raise OSError(exc.errno, f"Не удалось занять {host}:{port}, порт занят? ({exc.strerror})") from exc
    return sock


def bind_sockets(host: str, ports: tuple[int, ...]) -> list[socket.socket]:
    sockets: list[socket.socket] = []
    try:
        for port in ports:
            sockets.append(bind_socket(host, port))
    except OSError:
        for sock in sockets:
            sock.close()
        raise
    return sockets


def make_server(app: ASGIApp, options: dict[str, Any]) -> uvicorn.Server:
    """Сервер uvicorn с настройками serve(). Логи настраиваются здесь (log_config)."""
    return uvicorn.Server(uvicorn.Config(app, **options))


def run_server(server: uvicorn.Server, sockets: list[socket.socket]) -> None:
    """Один uvicorn на всех сокетах сразу (API и интерфейс), как uvicorn.run, но со своими сокетами."""
    try:
        server.run(sockets=sockets)
    except KeyboardInterrupt:
        pass
    if not server.started:
        sys.exit(STARTUP_FAILURE)
