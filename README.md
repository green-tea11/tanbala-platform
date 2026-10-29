# Tanbala: почта и WhatsApp на одном сервере

| Папка | Что | Подробно |
| --- | --- | --- |
| `leads/` | поиск компаний, письма, внутренний API (проект B) | `leads/HANDOVER.md`, `leads/docs/SETUP.md` |
| `whatsapp/` | WhatsApp-бот и его панель (проект C) | `whatsapp/README.md`, `whatsapp/docs/DEPLOY.md` |
| `contract/` | контракт внутреннего API между ними | `contract/INTERNAL_API.md` |
| `handover/` | передача от проектов B и C, итог слияния | `handover/` |
| `deploy/` | всё для сервера | появится на этапе 3 |

Правила работы: [CLAUDE.md](CLAUDE.md).

История B и C сохранена (git subtree без squash), но в старых коммитах файлы лежат без префикса папки. История файла
до слияния: `git log 36f58c9 -- tanbala_leads/web/app.py` (B) или `git log 3b70cf0 -- src/main.ts` (C).

## Запуск на ПК (Windows)

Postgres и Reacher — уже работающие контейнеры проекта compose `tanbala-leads`, второй набор не поднимать.

```bash
# почта: интерфейс и API на http://127.0.0.1:8000
cd leads && PYTHONUTF8=1 .venv/Scripts/python -m tanbala_leads web
# бот: панель на http://127.0.0.1:3100
cd whatsapp && npm run build && npm start
```

Окружения в git не попадают. Как их собрать заново:

```bash
cd leads
python -m venv .venv && .venv/Scripts/python -m pip install -r requirements.lock.txt && .venv/Scripts/python -m pip install -e . --no-deps
python -m venv .venv-2gis && .venv-2gis/Scripts/python -m pip install -r requirements-2gis.lock.txt
.venv/Scripts/python scripts/crawl4ai_tools.py setup   # Chromium в .browsers (или скопировать .browsers и .crawl4ai)
cd ../whatsapp && npm ci
```

`leads/.env` и `whatsapp/.env` — копии из оригиналов B и C, в git не попадают.

Тесты:

```bash
cd leads && PYTHONUTF8=1 .venv/Scripts/python -m pytest -q   # нужен Postgres, тесты во временной схеме
cd whatsapp && npm run check                                 # типы, линтер, тесты с порогом покрытия
```

## Этапы слияния

| Этап | Что | Статус |
| --- | --- | --- |
| 0 | план | принят 29.10.2026 |
| 1 | сборка в этой папке, тесты обоих проектов | готов 29.10.2026: leads 1026 тестов, whatsapp 4508 |
| 2 | живая связка на ПК | |
| 3 | установка на сервер без QR | |
| 4 | переезд бота | |
| 5 | резервные копии, проверка «всё живо», `handover/MERGE.md` | |
