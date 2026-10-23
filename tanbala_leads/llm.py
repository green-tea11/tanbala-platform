"""Вызовы Claude API: модель из config/models.yaml, кэш документа о Tanbala, лог токенов."""

import json
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml
from anthropic import Anthropic

from tanbala_leads.settings import Settings

TASKS = ("qualify", "first_email", "reply", "check", "classify_reply")
# Задаётся явно: иначе SDK возьмёт адрес из ANTHROPIC_BASE_URL и отправит ключ туда.
API_BASE_URL = "https://api.anthropic.com"
MODELS_CONFIG = Path(__file__).resolve().parents[1] / "config" / "models.yaml"
EFFORTS = ("low", "medium", "high", "xhigh", "max")
# Без стриминга SDK держит ответы до этого размера в пределах HTTP-таймаута.
MAX_TOKENS_LIMIT = 16_000
# Зависший вызов не должен держать единственный запуск: таймаут на запрос, SDK повторит его дважды.
API_TIMEOUT_SECONDS = 120.0
API_MAX_RETRIES = 2

# Цены на 06.10.2026, примерно. Доллары за миллион токенов; запись в кэш по цене 5-минутного кэша.
MODEL_PRICES_USD_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50, "cache_read": 0.01, "cache_write": 0.125},
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00, "cache_read": 0.20, "cache_write": 2.50},
}
TOKENS_PER_MTOK = 1_000_000


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
    if type(max_tokens) is not int or not 0 < max_tokens <= MAX_TOKENS_LIMIT:
        raise ModelsConfigError(f"{task}: max_tokens должен быть от 1 до {MAX_TOKENS_LIMIT}, сейчас {max_tokens!r}")
    if effort is not None and effort not in EFFORTS:
        raise ModelsConfigError(f"{task}: effort должен быть одним из {EFFORTS}, сейчас {effort!r}")
    return TaskModel(model=model, max_tokens=max_tokens, effort=effort)


def load_models_config(path: Path = MODELS_CONFIG) -> dict[str, TaskModel]:
    """Прочитать и проверить config/models.yaml. Каждая задача из TASKS обязательна."""
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        raise ModelsConfigError(f"{path}: не удалось прочитать: {exc}") from exc
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
    return Anthropic(api_key=settings.require("anthropic_key"), base_url=API_BASE_URL,
                     timeout=API_TIMEOUT_SECONDS, max_retries=API_MAX_RETRIES)


def call_cost_usd(model: str, input_tokens: int, output_tokens: int,
                  cache_read_tokens: int = 0, cache_write_tokens: int = 0) -> float | None:
    """Примерная цена вызовов одной модели в долларах. Неизвестная модель: None."""
    prices = MODEL_PRICES_USD_PER_MTOK.get(model)
    if prices is None:
        return None
    total = (input_tokens * prices["input"] + output_tokens * prices["output"]
             + cache_read_tokens * prices["cache_read"] + cache_write_tokens * prices["cache_write"])
    return total / TOKENS_PER_MTOK


class LLMError(RuntimeError):
    """Модель не дала пригодного ответа: обрезан, отказ или не JSON."""


@dataclass(frozen=True)
class LLMUsage:
    task: str
    model: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    stop_reason: str | None


def _usage_of(task: str, response) -> LLMUsage:
    usage = response.usage
    return LLMUsage(
        task=task,
        model=response.model,
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        cache_read_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        cache_write_tokens=getattr(usage, "cache_creation_input_tokens", 0) or 0,
        stop_reason=response.stop_reason,
    )


def complete_json(
    client: Anthropic,
    task: str,
    *,
    instructions: str,
    user_content: str,
    schema: dict,
    cached_context: str | None = None,
    on_usage: Callable[[LLMUsage], None] | None = None,
) -> dict:
    """Один вызов модели для задачи с ответом строго по JSON-схеме.

    cached_context (документ о Tanbala) идёт первым блоком system с cache_control: он одинаковый
    во всех запросах и читается из кэша. on_usage получает токены каждого вызова, даже неудачного.
    """
    config = task_config(task)
    system = []
    if cached_context:
        system.append({"type": "text", "text": cached_context, "cache_control": {"type": "ephemeral"}})
    system.append({"type": "text", "text": instructions})
    output_config: dict = {"format": {"type": "json_schema", "schema": schema}}
    if config.effort:
        output_config["effort"] = config.effort

    response = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
        output_config=output_config,
    )
    if on_usage is not None:
        on_usage(_usage_of(task, response))

    if response.stop_reason == "refusal":
        raise LLMError(f"{task}: модель ответила отказом")
    if response.stop_reason == "max_tokens":
        raise LLMError(f"{task}: ответ обрезан по max_tokens, увеличьте его в config/models.yaml")
    text = next((block.text for block in response.content if block.type == "text"), "")
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise LLMError(f"{task}: ответ не JSON") from exc


def append_usage_log(log_path: Path, usage: LLMUsage, *, run_id: int | None = None,
                     company_id: int | None = None) -> None:
    """Дописать строку в лог вызовов: только модель и токены, без текста промптов."""
    log_path.parent.mkdir(parents=True, exist_ok=True)
    line = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "run_id": run_id,
            "company_id": company_id, **asdict(usage)}
    with log_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(line, ensure_ascii=False) + "\n")


def save_usage(conn, usage: LLMUsage, *, run_id: int | None = None, company_id: int | None = None) -> None:
    """Записать вызов в таблицу llm_calls: по ней интерфейс считает расходы."""
    conn.execute(
        "INSERT INTO llm_calls (task, model, run_id, company_id, input_tokens, output_tokens,"
        " cache_read_tokens, cache_write_tokens, stop_reason) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (usage.task, usage.model, run_id, company_id, usage.input_tokens, usage.output_tokens,
         usage.cache_read_tokens, usage.cache_write_tokens, usage.stop_reason),
    )
