"""Поиск клиентов для Tanbala: 2ГИС, почты с сайтов, квалификация и черновики писем."""

import os
from pathlib import Path

__version__ = "0.1.0"

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# Всё, что crawl4ai и Playwright пишут на диск, держим в папке проекта, а не в профиле пользователя:
# рядом работают другие проекты со своими агентами, файлы не должны смешиваться.
# Задаётся до любого импорта crawl4ai и перекрывает чужие глобальные значения.
os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(PROJECT_ROOT / ".browsers")
# crawl4ai создаёт в этой папке global.yml и подпапку .crawl4ai с базой и кэшем.
os.environ["CRAWL4_AI_BASE_DIRECTORY"] = str(PROJECT_ROOT / ".crawl4ai")
os.environ["CRAWL4AI_NO_CLOUD_NOTICE"] = "1"
