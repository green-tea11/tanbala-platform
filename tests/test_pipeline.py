import json
import os
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg.conninfo import make_conninfo

from tanbala_leads import db, pipeline
from tanbala_leads.settings import load_settings
from tanbala_leads.sites import PageText, SiteCrawl
from tanbala_leads.steps import collect, verify

pytestmark = pytest.mark.db

FIXTURE = Path(__file__).parent / "fixtures" / "2gis-almaty-sklad.json"
SETTINGS = load_settings({"AGENT_NAME": "Арман", "AGENT_WHATSAPP": "+77479597238"})
QUALIFY = {"fit": "yes", "score": 75, "segment": "Склад, логистика, дистрибуция", "reason": "Склад и филиалы."}
DRAFT_BODY = (
    "Здравствуйте!\n\nМеня зовут Арман, я из Tanbala. Мы ставим учёт вещей на RFID-метках под ключ.\n\n"
    "На каждую коробку клеится метка. Ридер видит сотни меток за секунду, и всё попадает в 1С. "
    "Пересчёт идёт обходом со сканером.\n\nВсё делаем сами: оборудование, тесты, связь с 1С и обучение.\n\n"
    "Если пересчёт у вас занимает много времени, напишите нам в WhatsApp: +77479597238. Расскажите о задаче."
)


class FakeClient:
    """Отвечает как Claude: квалификация или письмо, в зависимости от схемы запроса."""

    def __init__(self):
        self.calls = []
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        self.calls.append(kwargs)
        schema = kwargs["output_config"]["format"]["schema"]
        answer = QUALIFY if "fit" in schema["properties"] else {"subject": "Учёт склада", "body": DRAFT_BODY,
                                                                "notes": []}
        usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_read_input_tokens=9000,
                                cache_creation_input_tokens=0)
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=json.dumps(answer, ensure_ascii=False))],
                               stop_reason="end_turn", usage=usage, model="claude-haiku-5-5")


def fake_site(url: str) -> SiteCrawl:
    domain = url.split("//")[-1].split("/")[0].removeprefix("www.")
    return SiteCrawl(start_url=url, pages=(PageText(url=url, text="Складское хранение и логистика."),),
                     emails=frozenset({f"sales@{domain}"}), error=None)


def site_with_broken_aksenger(url: str):
    if "aksenger" in url:
        raise TimeoutError("сайт не ответил")
    return fake_site(url)


def fake_check(email: str):
    return verify.EmailCheck(email=email, result="unknown", is_catch_all=None, is_role=False, note=None, raw={})


@pytest.fixture(autouse=True)
def migrated(db_conn):
    db.migrate(db_conn)


@pytest.fixture
def dsn(db_conn):
    schema = db_conn.execute("SELECT current_schema()").fetchone()[0]
    base = os.environ.get("TEST_DATABASE_URL") or os.environ["DATABASE_URL"]
    return make_conninfo(base, options=f"-c search_path={schema}")


def make_deps(tmp_path, client=None, run_parser=None, crawl=fake_site):
    def copy_fixture(url, out, max_records):
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(FIXTURE, out)
        return out

    return pipeline.Deps(run_parser=run_parser or copy_fixture, crawl=crawl, check_email=fake_check,
                         client=client or FakeClient(), owner_doc="Документ о Tanbala", settings=SETTINGS,
                         exports_dir=tmp_path / "2gis", log_path=tmp_path / "llm.jsonl")


def test_full_run_finds_qualifies_and_drafts(db_conn, dsn, tmp_path):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)
    client = FakeClient()

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, client))

    run = db_conn.execute("SELECT status, found, new_companies, crawled, qualified, verified, drafted, errors"
                          " FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert run == ("done", 4, 3, 3, 3, 3, 3, 0)
    assert db_conn.execute("SELECT count(*) FROM drafts").fetchone()[0] == 3
    assert db_conn.execute("SELECT count(*) FROM llm_calls WHERE run_id = %s", (run_id,)).fetchone()[0] == 6
    assert len((tmp_path / "llm.jsonl").read_text(encoding="utf-8").splitlines()) == 6
    assert all(call["system"][0]["text"] == "Документ о Tanbala" for call in client.calls)


def test_one_broken_site_does_not_stop_the_run(db_conn, dsn, tmp_path):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 4)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, crawl=site_with_broken_aksenger))

    status, errors, drafted = db_conn.execute("SELECT status, errors, drafted FROM runs WHERE id = %s",
                                              (run_id,)).fetchone()
    assert (status, errors, drafted) == ("done", 1, 3)
    assert "сайт не ответил" in db_conn.execute(
        "SELECT last_error FROM companies WHERE name LIKE 'Аксенгер%%'").fetchone()[0]


def test_parser_failure_fails_the_run_with_message(db_conn, dsn, tmp_path):
    def broken_parser(url, out, max_records):
        raise collect.ParserError("Chrome не запустился")

    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)

    pipeline.execute_run(dsn, run_id, make_deps(tmp_path, run_parser=broken_parser))

    status, error = db_conn.execute("SELECT status, error FROM runs WHERE id = %s", (run_id,)).fetchone()
    assert status == "failed" and "Chrome не запустился" in error


def test_second_run_while_first_is_active_is_refused(db_conn):
    pipeline.create_run(db_conn, "almaty", "склад", 3)

    with pytest.raises(pipeline.RunAlreadyActive):
        pipeline.create_run(db_conn, "almaty", "логистика", 3)


@pytest.mark.parametrize(("city", "query", "limit"), [("moscow", "склад", 3), ("almaty", " ", 3),
                                                       ("almaty", "склад", 0), ("almaty", "склад", 21)])
def test_bad_run_parameters_are_refused(db_conn, city, query, limit):
    with pytest.raises(ValueError):
        pipeline.create_run(db_conn, city, query, limit)


def test_stale_runs_are_marked_failed(db_conn):
    run_id = pipeline.create_run(db_conn, "almaty", "склад", 3)

    assert pipeline.recover_stale_runs(db_conn) == 1
    assert db_conn.execute("SELECT status FROM runs WHERE id = %s", (run_id,)).fetchone()[0] == "failed"


@pytest.mark.parametrize(
    "secret",
    ["sk-ant-api03-AbCdEf1234567890_xyz", "postgresql://tanbala:p4ss@127.0.0.1:5432/tanbala"],
)
def test_error_text_hides_secrets(secret):
    text = pipeline.safe_error(RuntimeError(f"не вышло: {secret} конец"))

    assert secret not in text
    assert "[скрыто]" in text and "не вышло" in text
