"""Установка браузера crawl4ai и самопроверка, с файлами внутри папки проекта.

Запуск:
    .venv/Scripts/python scripts/crawl4ai_tools.py setup    # браузер в .browsers, данные в .crawl4ai
    .venv/Scripts/python scripts/crawl4ai_tools.py doctor   # тестовый обход crawl4ai.com

Штатные crawl4ai-setup и crawl4ai-doctor без этого скрипта пишут в профиль пользователя.
"""

import sys

import tanbala_leads  # noqa: F401  задаёт пути внутри проекта до импорта crawl4ai
from crawl4ai.install import doctor, post_install

COMMANDS = {"setup": post_install, "doctor": doctor}


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in COMMANDS:
        print(f"Использование: crawl4ai_tools.py {{{'|'.join(COMMANDS)}}}", file=sys.stderr)
        return 2
    COMMANDS[argv[0]]()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
