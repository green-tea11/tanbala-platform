"""Общий лимит браузеров: поиск из интерфейса и проверки из WhatsApp делят их на весь процесс сервера.

VPS 4 ГБ, на нём ещё WhatsApp-бот (решение владельца 28.10.2026). Chrome parser-2gis ≈ 1 ГБ, Chromium crawl4ai
≈ 0.75 ГБ с драйвером. Одновременно не больше MAX_2GIS_BROWSERS выдач 2ГИС и MAX_SITE_BROWSERS обходов сайтов,
по умолчанию по одному.

Проверка из WhatsApp идёт вне очереди: ждёт только шаг поиска, который уже идёт (одна выдача 2ГИС или один сайт),
а следующий шаг поиска ждёт её. Одновременно с поиском может работать только браузер другого вида.
Ждать место дольше разумного не будем: если браузер завис, шаг падает с BrowserBusy, а не стоит до перезапуска.
Лимит живёт в одном процессе (сервер `web`): поиск из командной строки в другом процессе его не видит.
"""

import functools
import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import ParamSpec, TypeVar

from tanbala_leads.settings import ENV_NAMES, Settings
from tanbala_leads.steps.collect import PARSER_TIMEOUT_SECONDS

logger = logging.getLogger(__name__)

P = ParamSpec("P")
T = TypeVar("T")

MAX_BROWSERS = 4  # больше на VPS 4 ГБ не поместится: опечатка в .env не должна снять защиту памяти
# Сколько ждать место. parser-2gis сам остановится через PARSER_TIMEOUT_SECONDS, сайт обходится за минуту.
GIS_WAIT_SECONDS = PARSER_TIMEOUT_SECONDS + 2 * 60
SITE_WAIT_SECONDS = 5 * 60


class BrowserBusy(RuntimeError):
    """Место браузера не освободилось за отведённое время: вероятно, браузер завис."""


class Slots:
    """Места для браузеров одного вида. Срочный ждёт только тех, кто уже держит место, обычный пропускает срочных."""

    def __init__(self, limit: int, *, kind: str = "браузер", max_wait_seconds: float = SITE_WAIT_SECONDS):
        if limit < 1:
            raise ValueError("Лимит браузеров должен быть не меньше 1")
        self.limit = limit
        self.kind = kind
        self.max_wait_seconds = max_wait_seconds
        self.busy = 0
        self.waiting = 0
        self._urgent_waiting = 0
        self._changed = threading.Condition()

    @contextmanager
    def hold(self, *, urgent: bool = False) -> Iterator[None]:
        """Занять место на время блока. Место свободно: сразу; иначе ждать, пока его отпустят (не дольше предела)."""
        with self._changed:
            self.waiting += 1
            self._urgent_waiting += int(urgent)
            deadline = time.monotonic() + self.max_wait_seconds
            try:
                while self.busy >= self.limit or (not urgent and self._urgent_waiting):
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        logger.warning("%s занят дольше %.0f с: шаг пропущен", self.kind, self.max_wait_seconds)
                        raise BrowserBusy(f"{self.kind} занят дольше {self.max_wait_seconds / 60:.0f} мин")
                    self._changed.wait(remaining)
            finally:
                self.waiting -= 1
                self._urgent_waiting -= int(urgent)
                self._changed.notify_all()  # обычные ждали, пока не останется срочных
            self.busy += 1
        try:
            yield
        finally:
            with self._changed:
                self.busy -= 1
                self._changed.notify_all()

    def guard(self, call: Callable[P, T], *, urgent: bool = False) -> Callable[P, T]:
        """Тот же call, но только после того, как занято место."""

        @functools.wraps(call)
        def guarded(*args: P.args, **kwargs: P.kwargs) -> T:
            with self.hold(urgent=urgent):
                return call(*args, **kwargs)

        return guarded


@dataclass(frozen=True)
class BrowserLimits:
    gis: Slots  # Chrome для 2ГИС (parser-2gis)
    sites: Slots  # Chromium для сайтов (crawl4ai)


def parse_limit(settings: Settings, name: str) -> int:
    """Целое от 1 до MAX_BROWSERS из настройки name (например max_2gis_browsers)."""
    env_name = ENV_NAMES[name]
    value = getattr(settings, name)
    if not (value.isascii() and value.isdigit() and 1 <= int(value) <= MAX_BROWSERS):
        raise ValueError(f"{env_name} должен быть целым числом от 1 до {MAX_BROWSERS}, например 1")
    return int(value)


def limits_from_settings(settings: Settings) -> BrowserLimits:
    """Лимиты из MAX_2GIS_BROWSERS и MAX_SITE_BROWSERS (по умолчанию по одному браузеру)."""
    return BrowserLimits(
        gis=Slots(parse_limit(settings, "max_2gis_browsers"), kind="Браузер для 2ГИС",
                  max_wait_seconds=GIS_WAIT_SECONDS),
        sites=Slots(parse_limit(settings, "max_site_browsers"), kind="Браузер для сайтов",
                    max_wait_seconds=SITE_WAIT_SECONDS),
    )
