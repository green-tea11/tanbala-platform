"""Вызовы Claude API: модель из config/models.yaml, кэш документа о Tanbala, лог токенов."""


def make_client():
    """Создать клиент Anthropic с ключом из VENMART_ANTHROPIC_KEY, переданным явно.

    TODO: Anthropic(api_key=...), без чтения стандартной переменной ключа из окружения.
    """
    raise NotImplementedError


def model_for(task: str) -> str:
    """Вернуть модель для задачи (qualify, first_email, reply, check, classify_reply).

    TODO: читать config/models.yaml.
    """
    raise NotImplementedError


def complete(task: str, user_content: str, *, cached_context: str | None = None) -> str:
    """Один вызов модели для задачи. Вернуть текст ответа.

    TODO: max_tokens из конфига, cached_context через prompt caching,
    запись в лог: модель, входные и выходные токены.
    """
    raise NotImplementedError
