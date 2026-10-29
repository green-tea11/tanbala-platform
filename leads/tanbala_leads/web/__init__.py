"""Локальный веб-интерфейс: кнопка «Найти компании», список компаний и карточка с письмом.

Запуск: `python -m tanbala_leads web` вызывает serve(). Только 127.0.0.1.
"""

from tanbala_leads.web.app import create_app, serve

__all__ = ["create_app", "serve"]
