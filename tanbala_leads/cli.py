"""Командная строка: `python -m tanbala_leads <команда>`.

    migrate                         создать или обновить таблицы
    web [--port 8000]               интерфейс на http://127.0.0.1:8000
    search --query склад [--city almaty] [--limit 5]   запуск поиска без интерфейса
"""

import argparse
import sys

from tanbala_leads import db, pipeline
from tanbala_leads.settings import SettingsError, load_settings
from tanbala_leads.steps.collect import CITIES


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m tanbala_leads", description="Tanbala: поиск клиентов")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("migrate", help="создать или обновить таблицы")
    web = commands.add_parser("web", help="интерфейс на http://127.0.0.1:<port>")
    web.add_argument("--port", type=int, default=8000)
    search = commands.add_parser("search", help="запуск поиска без интерфейса")
    search.add_argument("--query", required=True, help="что искать в 2ГИС, например «склад»")
    search.add_argument("--city", default="almaty", choices=sorted(CITIES))
    search.add_argument("--limit", type=int, default=5, help=f"сколько компаний, до {pipeline.MAX_COMPANIES_LIMIT}")
    return parser


def _search(dsn: str, city: str, query: str, limit: int) -> int:
    with db.connect(dsn) as conn:
        db.migrate(conn)
        pipeline.recover_stale_runs(conn)
        run_id = pipeline.create_run(conn, city, query, limit)
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

        serve(port=args.port)
        return 0
    try:
        dsn = load_settings().require("database_url")
        if args.command == "migrate":
            with db.connect(dsn) as conn:
                applied = db.migrate(conn)
            print(f"Применены миграции: {applied}" if applied else "Схема актуальна, миграций нет.")
            return 0
        return _search(dsn, args.city, args.query, args.limit)
    except (SettingsError, ValueError, pipeline.RunAlreadyActive) as exc:
        print(exc, file=sys.stderr)
        return 1
