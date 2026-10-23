"""Вызовы Claude API: модель из config/models.yaml, кэш документа о Tanbala, лог токенов."""

from dataclasses import dataclass
from pathlib import Path

import yaml
from anthropic import Anthropic

from tanbala_leads.settings import Settings

TASKS = ("qualify", "first_email", "reply", "check", "classify_reply")
MODELS_CONFIG = Path(__file__).resolve().parents[1] / "config" / "models.yaml"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Без стриминга SDK держит ответы до этого размера в пределах HTTP-таймаута.
MAX_TOKENS_LIMIT = 16_000


class ModelsConfigError(ValueError):
    """Ошибка в config/models.yaml."""


@dataclass(frozen=True)
class TaskModel:
    model: str
    max_tokens: int
    effort: str | None = None


def _parse_task(task: str, entry: object) -> TaskModel:
    if not isinstance(entry, dict):
        raise ModelsConfigError(f"{task}: ожидались поля model и max_tokens")
    model = entry.get("model")
    max_tokens = entry.get("max_tokens")
    effort = entry.get("effort")
    if not isinstance(model, str) or not model.startswith("claude-"):
        raise ModelsConfigError(f"{task}: model должен быть id модели Claude, сейчас {model!r}")
    if not isinstance(max_tokens, int) or not 0 < max_tokens <= MAX_TOKENS_LIMIT:
        raise ModelsConfigError(f"{task}: max_tokens должен быть от 1 до {MAX_TOKENS_LIMIT}, сейчас {max_tokens!r}")
    if effort is not None and effort not in EFFORTS:
        raise ModelsConfigError(f"{task}: effort должен быть одним из {EFFORTS}, сейчас {effort!r}")
    return TaskModel(model=model, max_tokens=max_tokens, effort=effort)


def load_models_config(path: Path = MODELS_CONFIG) -> dict[str, TaskModel]:
    """Прочитать и проверить config/models.yaml. Каждая задача из TASKS обязательна."""
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, dict):
        raise ModelsConfigError(f"{path}: нет раздела tasks")
    missing = [task for task in TASKS if task not in tasks]
    if missing:
        raise ModelsConfigError(f"{path}: не описаны задачи {', '.join(missing)}")
    return {task: _parse_task(task, tasks[task]) for task in TASKS}


def task_config(task: str, *, path: Path = MODELS_CONFIG) -> TaskModel:
    """Модель, max_tokens и effort для задачи. Файл читается при каждом вызове, правки видны сразу."""
    if task not in TASKS:
        raise ModelsConfigError(f"Неизвестная задача {task!r}, допустимы: {', '.join(TASKS)}")
    return load_models_config(path)[task]


def make_client(settings: Settings) -> Anthropic:
    """Создать клиент Anthropic с ключом из VENMART_ANTHROPIC_KEY.

    Ключ передаётся явно: тогда SDK не ищет учётные данные в окружении и профилях.
    Без ключа останавливаемся сразу, иначе SDK сам подобрал бы чужие учётные данные.
    """
    return Anthropic(api_key=settings.require("anthropic_key"))


def complete(task: str, user_content: str, *, cached_context: str | None = None) -> str:
    """Один вызов модели для задачи. Вернуть текст ответа.

    TODO: модель, max_tokens и effort из task_config(task); cached_context (документ о Tanbala)
    в system с cache_control; проверять stop_reason (max_tokens, refusal);
    запись в LLM_LOG_PATH: задача, модель, input/output/cache токены.
    """
    raise NotImplementedError
