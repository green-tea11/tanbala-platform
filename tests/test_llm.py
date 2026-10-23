import json
from types import SimpleNamespace

import pytest

from tanbala_leads import llm

SCHEMA = {
    "type": "object",
    "properties": {"fit": {"type": "string"}},
    "required": ["fit"],
    "additionalProperties": False,
}


class FakeMessages:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


def fake_client(text='{"fit": "yes"}', stop_reason="end_turn"):
    usage = SimpleNamespace(input_tokens=1200, output_tokens=80, cache_read_input_tokens=9000,
                            cache_creation_input_tokens=0)
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text=text)], stop_reason=stop_reason,
                               usage=usage, model="claude-haiku-5-5")
    return SimpleNamespace(messages=FakeMessages(response))


def test_complete_json_uses_task_config_and_caches_context():
    client = fake_client()

    result = llm.complete_json(client, "qualify", instructions="Оцени.", user_content="Компания",
                               schema=SCHEMA, cached_context="Документ о Tanbala")

    call = client.messages.calls[0]
    config = llm.task_config("qualify")
    assert result == {"fit": "yes"}
    assert call["model"] == config.model
    assert call["max_tokens"] == config.max_tokens
    assert call["system"][0] == {"type": "text", "text": "Документ о Tanbala", "cache_control": {"type": "ephemeral"}}
    assert call["system"][1]["text"] == "Оцени."
    assert call["output_config"]["format"] == {"type": "json_schema", "schema": SCHEMA}
    assert call["output_config"].get("effort") == config.effort
    assert "temperature" not in call


def test_usage_is_reported_even_when_answer_is_cut():
    seen = []
    client = fake_client(text='{"fit": "ye', stop_reason="max_tokens")

    with pytest.raises(llm.LLMError, match="max_tokens"):
        llm.complete_json(client, "qualify", instructions="x", user_content="y", schema=SCHEMA, on_usage=seen.append)

    assert seen[0].input_tokens == 1200
    assert seen[0].cache_read_tokens == 9000
    assert seen[0].task == "qualify"


def test_refusal_is_an_error():
    with pytest.raises(llm.LLMError, match="отказ"):
        llm.complete_json(fake_client(stop_reason="refusal"), "qualify", instructions="x", user_content="y",
                          schema=SCHEMA)


def test_invalid_json_is_an_error():
    with pytest.raises(llm.LLMError):
        llm.complete_json(fake_client(text="не json"), "qualify", instructions="x", user_content="y", schema=SCHEMA)


def test_usage_log_line_has_no_prompt_text(tmp_path):
    usage = llm.LLMUsage(task="qualify", model="claude-haiku-5-5", input_tokens=10, output_tokens=5,
                         cache_read_tokens=0, cache_write_tokens=0, stop_reason="end_turn")
    log_path = tmp_path / "logs" / "llm_calls.jsonl"

    llm.append_usage_log(log_path, usage, run_id=3, company_id=7)

    line = json.loads(log_path.read_text(encoding="utf-8"))
    assert line["model"] == "claude-haiku-5-5"
    assert line["input_tokens"] == 10 and line["output_tokens"] == 5
    assert line["run_id"] == 3 and line["company_id"] == 7
    assert set(line) == {"at", "task", "model", "run_id", "company_id", "input_tokens", "output_tokens",
                         "cache_read_tokens", "cache_write_tokens", "stop_reason"}


@pytest.mark.db
def test_usage_is_saved_to_llm_calls(db_conn):
    from tanbala_leads import db

    db.migrate(db_conn)
    usage = llm.LLMUsage(task="first_email", model="claude-haiku-5-5", input_tokens=900, output_tokens=300,
                         cache_read_tokens=8000, cache_write_tokens=0, stop_reason="end_turn")

    llm.save_usage(db_conn, usage)

    row = db_conn.execute("SELECT task, input_tokens, output_tokens, cache_read_tokens FROM llm_calls").fetchone()
    assert row == ("first_email", 900, 300, 8000)
