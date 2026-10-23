import pytest

from tanbala_leads.llm import TASKS, ModelsConfigError, TaskModel, load_models_config, task_config

VALID_TASK = "    model: claude-haiku-5-5\n    max_tokens: 512\n"


def write_config(tmp_path, tasks: dict[str, str]):
    body = "tasks:\n" + "".join(f"  {name}:\n{fields}" for name, fields in tasks.items())
    path = tmp_path / "models.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def test_real_config_has_every_task_on_haiku_by_default():
    config = load_models_config()

    assert set(config) == set(TASKS)
    assert {entry.model for entry in config.values()} == {"claude-haiku-5-5"}


def test_task_config_reads_real_file():
    entry = task_config("qualify")

    assert isinstance(entry, TaskModel)
    assert entry.max_tokens > 0


def test_model_changes_only_in_config(tmp_path):
    tasks = dict.fromkeys(TASKS, VALID_TASK)
    tasks["first_email"] = "    model: claude-sonnet-5-5\n    max_tokens: 2048\n"
    path = write_config(tmp_path, tasks)

    assert task_config("first_email", path=path).model == "claude-sonnet-5-5"


def test_unknown_task_is_rejected():
    with pytest.raises(ModelsConfigError, match="send_spam"):
        task_config("send_spam")


def test_missing_task_is_rejected(tmp_path):
    tasks = dict.fromkeys(TASKS, VALID_TASK)
    del tasks["check"]
    path = write_config(tmp_path, tasks)

    with pytest.raises(ModelsConfigError, match="check"):
        load_models_config(path)


@pytest.mark.parametrize(
    "fields",
    [
        "    max_tokens: 512\n",
        "    model: gpt-4\n    max_tokens: 512\n",
        "    model: claude-haiku-5-5\n    max_tokens: 0\n",
        "    model: claude-haiku-5-5\n    max_tokens: 100000\n",
        "    model: claude-haiku-5-5\n    max_tokens: 512\n    effort: turbo\n",
    ],
)
def test_invalid_task_entry_is_rejected(tmp_path, fields):
    tasks = dict.fromkeys(TASKS, VALID_TASK)
    tasks["qualify"] = fields
    path = write_config(tmp_path, tasks)

    with pytest.raises(ModelsConfigError, match="qualify"):
        load_models_config(path)
