"""Общий лимит браузеров для поиска и проверок из WhatsApp. Потоки и подменённые браузеры, без сети и API."""

import contextlib
import os
import threading
import time
from pathlib import Path

import pytest
from psycopg.conninfo import make_conninfo

from tanbala_leads import browsers, db, pipeline, sites
from tanbala_leads.settings import load_settings
from tanbala_leads.steps import collect
from tanbala_leads.web import app as web

WAIT_SECONDS = 5


def wait_until(condition) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError("не дождались")
        time.sleep(0.005)


class Browser:
    """Подменённый браузер: держит место, пока тест не отпустит, и пишет порядок запусков."""

    def __init__(self, slots: browsers.Slots):
        self.slots = slots
        self.order: list[str] = []
        self.release: dict[str, threading.Event] = {}
        self.started: dict[str, threading.Event] = {}
        self.threads: list[threading.Thread] = []
        self.not_released: list[str] = []
        self.max_busy = 0

    def start(self, name: str, *, urgent: bool = False) -> None:
        self.release[name] = threading.Event()
        self.started[name] = threading.Event()

        def work() -> None:
            self.order.append(name)
            self.max_busy = max(self.max_busy, self.slots.busy)
            self.started[name].set()
            if not self.release[name].wait(WAIT_SECONDS):
                self.not_released.append(name)

        thread = threading.Thread(target=self.slots.guard(work, urgent=urgent), daemon=True)
        thread.start()
        self.threads.append(thread)

    def finish(self) -> None:
        for thread in self.threads:
            thread.join(WAIT_SECONDS)
        assert not any(thread.is_alive() for thread in self.threads)
        assert self.not_released == []
        assert (self.slots.busy, self.slots.waiting) == (0, 0)


def test_second_browser_of_same_kind_waits_for_the_first():
    browser = Browser(browsers.Slots(1))
    browser.start("поиск: склад")
    assert browser.started["поиск: склад"].wait(WAIT_SECONDS)
    browser.start("поиск: логистика")
    wait_until(lambda: browser.slots.waiting == 1)
    assert browser.order == ["поиск: склад"]

    browser.release["поиск: склад"].set()
    assert browser.started["поиск: логистика"].wait(WAIT_SECONDS)
    browser.release["поиск: логистика"].set()
    browser.finish()

    assert browser.order == ["поиск: склад", "поиск: логистика"] and browser.max_busy == 1


def test_whatsapp_check_goes_between_search_steps():
    """Поиск держит браузер, следующий шаг поиска уже ждёт; проверка из WhatsApp пришла позже, но идёт раньше."""
    browser = Browser(browsers.Slots(1))
    browser.start("поиск, шаг 1")
    assert browser.started["поиск, шаг 1"].wait(WAIT_SECONDS)
    browser.start("поиск, шаг 2")
    wait_until(lambda: browser.slots.waiting == 1)
    browser.start("WhatsApp", urgent=True)
    wait_until(lambda: browser.slots.waiting == 2)

    browser.release["поиск, шаг 1"].set()
    assert browser.started["WhatsApp"].wait(WAIT_SECONDS)
    assert not browser.started["поиск, шаг 2"].is_set()  # параллельно с проверкой шаг поиска не идёт
    browser.release["WhatsApp"].set()
    assert browser.started["поиск, шаг 2"].wait(WAIT_SECONDS)
    browser.release["поиск, шаг 2"].set()
    browser.finish()

    assert browser.order == ["поиск, шаг 1", "WhatsApp", "поиск, шаг 2"] and browser.max_busy == 1


def test_free_browser_is_taken_at_once():
    limits = browsers.BrowserLimits(gis=browsers.Slots(1), sites=browsers.Slots(1))
    with limits.gis.hold():  # поиск в 2ГИС
        with limits.sites.hold(urgent=True):  # проверка из WhatsApp обходит сайт в это же время
            assert (limits.gis.busy, limits.sites.busy) == (1, 1)
    two = browsers.Slots(2)
    with two.hold(), two.hold(urgent=True):
        assert two.busy == 2


def test_failed_browser_frees_its_place():
    slots = browsers.Slots(1)

    def broken():
        raise collect.ParserError("Chrome упал")

    with pytest.raises(collect.ParserError):
        slots.guard(broken)()

    assert slots.busy == 0
    with slots.hold():
        assert slots.busy == 1


@pytest.mark.parametrize("urgent", [False, True])
def test_hung_browser_does_not_block_forever(urgent):
    """Браузер завис и держит место: следующий шаг падает с BrowserBusy, а не ждёт до перезапуска."""
    slots = browsers.Slots(1, kind="Браузер для сайтов", max_wait_seconds=0.05)
    with slots.hold():
        with pytest.raises(browsers.BrowserBusy, match="Браузер для сайтов занят дольше"):
            with slots.hold(urgent=urgent):
                pass
        assert (slots.busy, slots.waiting) == (1, 0)
    with slots.hold():  # счётчики не съехали: место снова занимается сразу
        assert slots.busy == 1


def test_real_limits_wait_longer_than_parser_runs():
    """Ждущий не падает раньше, чем отработает и будет убит parser-2gis того, кто держит место."""
    limits = browsers.limits_from_settings(load_settings({}))

    assert limits.gis.max_wait_seconds > collect.PARSER_TIMEOUT_SECONDS + collect.KILL_WAIT_SECONDS
    assert limits.gis.max_wait_seconds > pipeline.RESEARCH_PARSER_TIMEOUT_SECONDS + collect.KILL_WAIT_SECONDS
    assert limits.sites.max_wait_seconds > sites.SITE_TIMEOUT_S


def test_search_step_that_gives_up_does_not_hold_back_whatsapp():
    """Шаг поиска не дождался места и упал: срочная проверка, которая ждёт, всё равно получает место."""
    slots = browsers.Slots(1, max_wait_seconds=WAIT_SECONDS)
    got: list[str] = []
    with slots.hold():
        thread = threading.Thread(target=slots.guard(lambda: got.append("WhatsApp"), urgent=True), daemon=True)
        thread.start()
        wait_until(lambda: slots.waiting == 1)
        slots.max_wait_seconds = 0.05  # обычный шаг поиска ждёт недолго и сдаётся
        with pytest.raises(browsers.BrowserBusy):
            with slots.hold():
                pass
        slots.max_wait_seconds = WAIT_SECONDS
        assert slots.waiting == 1
    thread.join(WAIT_SECONDS)

    assert got == ["WhatsApp"] and (slots.busy, slots.waiting) == (0, 0)


@pytest.mark.parametrize(("env", "expected"), [({}, (1, 1)), ({"MAX_2GIS_BROWSERS": "2", "MAX_SITE_BROWSERS": " 4 "},
                                                                (2, 4))])
def test_limits_come_from_env_and_default_to_one(env, expected):
    limits = browsers.limits_from_settings(load_settings(env))

    assert (limits.gis.limit, limits.sites.limit) == expected


@pytest.mark.parametrize("value", ["0", "-1", "один", "1.5", "+2", "1_000", "5", "١"])
def test_bad_limit_stops_with_variable_name(value):
    with pytest.raises(ValueError, match="MAX_SITE_BROWSERS"):
        browsers.limits_from_settings(load_settings({"MAX_SITE_BROWSERS": value}))


def test_real_deps_take_shared_browser_places(monkeypatch):
    """default_deps поиска и проверки из WhatsApp занимают одни и те же места; проверка идёт вне очереди."""
    limits = browsers.BrowserLimits(gis=browsers.Slots(1), sites=browsers.Slots(1))
    seen: list[tuple[str, int, int, int]] = []
    modes: list[bool] = []
    gate = threading.Event()

    def fake_parser(url, out, n, parser_bin, *, timeout_seconds, headless):
        seen.append((url, limits.gis.busy, limits.sites.busy, timeout_seconds))
        modes.append(headless)
        if url == "first":
            gate.wait(WAIT_SECONDS)
        return out

    async def fake_crawl_site(url):
        seen.append((url, limits.gis.busy, limits.sites.busy, 0))
        return sites.SiteCrawl(start_url=url)

    monkeypatch.setattr(collect, "run_parser", fake_parser)
    monkeypatch.setattr(sites, "crawl_site", fake_crawl_site)
    settings = load_settings({"VENMART_ANTHROPIC_KEY": "sk-ant-test", "REACHER_SECRET": "test",
                              "PARSER_2GIS_HEADLESS": "true"})
    search = pipeline.default_deps(settings, limits)
    whatsapp = pipeline.default_deps(settings, limits, urgent=True)

    search.crawl("https://pel.kz")
    threads = [threading.Thread(target=search.run_parser, args=("first", Path("a.json"), 5), daemon=True)]
    threads[0].start()
    wait_until(lambda: limits.gis.busy == 1)
    threads.append(threading.Thread(target=search.run_parser, args=("next", Path("b.json"), 5), daemon=True))
    threads[1].start()
    wait_until(lambda: limits.gis.waiting == 1)
    threads.append(threading.Thread(target=whatsapp.run_parser, args=("whatsapp", Path("c.json"), 5), daemon=True))
    threads[2].start()
    wait_until(lambda: limits.gis.waiting == 2)
    gate.set()
    for thread in threads:
        thread.join(WAIT_SECONDS)

    assert not any(thread.is_alive() for thread in threads)
    full, short = collect.PARSER_TIMEOUT_SECONDS, pipeline.RESEARCH_PARSER_TIMEOUT_SECONDS
    assert seen == [("https://pel.kz", 0, 1, 0), ("first", 1, 0, full), ("whatsapp", 1, 0, short),
                    ("next", 1, 0, full)]
    assert modes == [True, True, True]  # PARSER_2GIS_HEADLESS и у поиска, и у проверки из WhatsApp


# ---------- проводка в сервере ----------


def test_serve_gives_search_and_whatsapp_the_same_browsers(monkeypatch):
    calls: dict[str, object] = {}

    class FakeQueue:
        def __init__(self, **kwargs):
            calls["queue"] = kwargs

        def kick(self):
            pass

    monkeypatch.setattr(web, "load_settings", lambda: load_settings({"DATABASE_URL": "postgresql://test"}))
    monkeypatch.setattr(web.db, "connect", lambda dsn: contextlib.nullcontext(object()))
    monkeypatch.setattr(web.db, "migrate", lambda conn: [])
    monkeypatch.setattr(web.pipeline, "recover_stale_runs", lambda conn: 0)
    monkeypatch.setattr(web.research, "recover_stale_jobs", lambda conn: 0)
    monkeypatch.setattr(web.research, "ResearchQueue", FakeQueue)
    monkeypatch.setattr(web, "create_app", lambda **kwargs: calls.setdefault("app", kwargs))
    monkeypatch.setattr(web.uvicorn, "run", lambda app, **options: calls.setdefault("uvicorn", options))
    monkeypatch.setattr(web.pipeline, "default_deps",
                        lambda settings, limits, *, urgent=False: calls.setdefault("deps", (limits, urgent)))
    monkeypatch.setattr(web.pipeline, "start_run",
                        lambda dsn, city, query, n, *, limits: calls.setdefault("run", limits))

    web.serve()
    calls["queue"]["deps_factory"]()
    calls["app"]["start_run"]("almaty", "склад", 1)

    research_limits, urgent = calls["deps"]
    assert isinstance(research_limits, browsers.BrowserLimits) and urgent is True
    assert calls["run"] is research_limits
    assert calls["uvicorn"]["host"] == "127.0.0.1"


def test_serve_stops_on_bad_headless_setting_before_database(monkeypatch):
    monkeypatch.setattr(web, "load_settings", lambda: load_settings({"DATABASE_URL": "postgresql://test",
                                                                     "PARSER_2GIS_HEADLESS": "да"}))
    monkeypatch.setattr(web.db, "connect", lambda dsn: pytest.fail("до базы дойти не должно"))

    with pytest.raises(ValueError, match="PARSER_2GIS_HEADLESS"):
        web.serve()


def test_serve_stops_on_bad_browser_limit_before_database(monkeypatch):
    monkeypatch.setattr(web, "load_settings", lambda: load_settings({"DATABASE_URL": "postgresql://test",
                                                                     "MAX_2GIS_BROWSERS": "10"}))
    monkeypatch.setattr(web.db, "connect", lambda dsn: pytest.fail("до базы дойти не должно"))

    with pytest.raises(ValueError, match="MAX_2GIS_BROWSERS"):
        web.serve()


@pytest.mark.db
def test_run_passes_shared_browsers_to_real_deps(db_conn, monkeypatch):
    db.migrate(db_conn)
    schema = db_conn.execute("SELECT current_schema()").fetchone()[0]
    dsn = make_conninfo(os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"],
                        options=f"-c search_path={schema}")
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 1)
    limits = browsers.BrowserLimits(gis=browsers.Slots(1), sites=browsers.Slots(1))
    seen = []

    def fake_deps(settings, given, *, urgent=False):
        seen.append((given, urgent))
        raise RuntimeError("дальше не идём")

    monkeypatch.setattr(pipeline, "default_deps", fake_deps)

    pipeline.execute_run(dsn, run_id, limits=limits)

    assert seen == [(limits, False)]
    assert db_conn.execute("SELECT status FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "failed"
