"""Командная строка: `python -m tanbala_leads <команда>`.

Каждый шаг пайплайна запускается отдельной командой, поэтому любой шаг можно перезапустить.
"""


def main(argv: list[str] | None = None) -> int:
    """Разобрать аргументы и запустить команду. Вернуть код выхода.

    TODO: команды collect, crawl, qualify, verify, draft, review, approve, send (только --dry-run).
    """
    raise NotImplementedError
