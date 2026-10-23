"""Вызовы Claude API: модель из config/models.yaml, кэш документа о Tanbala, лог токенов."""

from anthropic import Anthropic

from tanbala_leads.settings import Settings


def make_client(settings: Settings) -> Anthropic:
    """Создать клиент Anthropic с ключом из VENMART_ANTHROPIC_KEY.

    Ключ передаётся явно: тогда SDK не ищет учётные данные в окружении и профилях.
    Без ключа останавливаемся сразу, иначе SDK сам подобрал бы чужие учётные данные.
    """
    return Anthropic(api_key=settings.require("anthropic_key"))


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
