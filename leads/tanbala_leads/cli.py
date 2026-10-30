"""Командная строка: `python -m tanbala_leads <команда>`.

    migrate                         создать или обновить таблицы
    web [--port 8000] [--ui-port 8001]   API для бота и консоли на :8000 (/internal), интерфейс на :8001
    search --query склад [--city almaty] [--limit 5]   запуск поиска без интерфейса
"""

import argparse
import sys

from tanbala_leads import db, pipeline
from tanbala_leads.settings import SettingsError, load_settings
from tanbala_leads.steps import collect
from tanbala_leads.steps.collect import CITIES


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tanbala_leads", description="Tanbala: поиск клиентов")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="создать или обновить таблицы")
    web = commands.add_parser("web", help="API на 127.0.0.1:<port>, интерфейс на 127.0.0.1:<ui-port>")
    web.add_argument("--port", type=int, default=8000, help="внутренний API /internal для бота и консоли")
    web.add_argument("--ui-port", type=int, default=8001,
                     help="интерфейс с кнопками; на сервере к нему пускается только Caddy")
    search = commands.add_parser("search", help="запуск поиска без интерфейса")
    search.add_argument("--query", required=True, help="что искать в 2ГИС, например «склад»")
    search.add_argument("--city", default="almaty", choices=sorted(CITIES))
    search.add_argument("--limit", type=int, default=5, help=f"сколько компаний, до {pipeline.MAX_COMPANIES_LIMIT}")
    return parser


def _search(dsn: str, city: str, query: str, limit: int, budget: float) -> int:
    with db.connect(dsn) as conn:
        db.migrate(conn)
        pipeline.recover_stale_runs(conn)
        run_id = pipeline.create_run(conn, city, query, limit, daily_budget_usd=budget)
    pipeline.execute_run(dsn, run_id)
    with db.connect(dsn) as conn:
        status, error, found, drafted = conn.execute(
            "SELECT status, error, found, drafted FROM runs WHERE id = %s", (run_id,)
        ).fetchone()
    print(f"Запуск {run_id}: {status}. Найдено {found}, писем {drafted}." + (f" Ошибка: {error}" if error else ""))
    return 0 if status == "done" else 1


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.command == "web":
        from tanbala_leads.web.app import serve

        serve(port=args.port, ui_port=args.ui_port)
        return 0
    try:
        settings = load_settings()
        dsn = settings.require("database_url")
        if args.command == "migrate":
            with db.connect(dsn) as conn:
                applied = db.migrate(conn)
            print(f"Применены миграции: {applied}" if applied else "Схема актуальна, миграций нет.")
            return 0
        # parser-2gis должен запуститься, иначе запуск создался бы и сразу упал (как проверка в serve()).
        collect.check_parser_setup(settings.parser_2gis_bin, collect.parse_headless(settings.parser_2gis_headless))
        return _search(dsn, args.city, args.query, args.limit, pipeline.daily_budget(settings))
    except (SettingsError, ValueError, pipeline.RunAlreadyActive) as exc:
        print(exc, file=sys.stderr)
        return 1
