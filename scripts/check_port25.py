"""Проверить, открыт ли исходящий порт 25. Он нужен Reacher для SMTP-проверки почт.

Подключается к почтовым серверам и читает приветствие 220. Писем и SMTP-команд не отправляет.
Запуск: python scripts/check_port25.py
"""

import socket
import sys
from collections.abc import Callable
from dataclasses import dataclass

HOSTS = ("gmail-smtp-in.l.google.com", "alt1.gmail-smtp-in.l.google.com", "mxs.mail.ru")
PORT = 25
TIMEOUT_SECONDS = 10


@dataclass(frozen=True)
class ProbeResult:
    host: str
    is_open: bool
    detail: str


def probe(host: str, port: int = PORT, timeout: float = TIMEOUT_SECONDS,
          connect: Callable[..., socket.socket] = socket.create_connection) -> ProbeResult:
    """Открыть TCP-соединение и прочитать первую строку ответа сервера."""
    try:
        with connect((host, port), timeout=timeout) as sock:
            banner = sock.recv(512).decode("ascii", errors="replace").strip()
    except OSError as exc:
        return ProbeResult(host, False, f"{type(exc).__name__}: {exc}")
    if banner.startswith("220"):
        return ProbeResult(host, True, banner[:80])
    return ProbeResult(host, False, f"нет приветствия 220: {banner[:80]!r}")


def main() -> int:
    results = [probe(host) for host in HOSTS]
    for result in results:
        mark = "открыт" if result.is_open else "закрыт"
        print(f"{result.host}:{PORT}  {mark}  {result.detail}")
    if any(result.is_open for result in results):
        print("Исходящий порт 25 открыт.")
        return 0
    print("Исходящий порт 25 закрыт: Reacher не сможет проверять почты с этой машины.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
