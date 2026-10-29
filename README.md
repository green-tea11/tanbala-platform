# Tanbala: почта и WhatsApp на одном сервере

| Папка | Что | Подробно |
| --- | --- | --- |
| `leads/` | поиск компаний, письма, внутренний API (проект B) | `leads/HANDOVER.md`, `leads/docs/SETUP.md` |
| `whatsapp/` | WhatsApp-бот и его панель (проект C) | `whatsapp/README.md`, `whatsapp/docs/DEPLOY.md` |
| `contract/` | контракт внутреннего API между ними | `contract/INTERNAL_API.md` |
| `handover/` | передача от проектов B и C, итог слияния | `handover/` |
| `deploy/` | всё для сервера | появится на этапе 3 |

Правила работы: [CLAUDE.md](CLAUDE.md).

## Запуск на ПК (Windows)

Postgres и Reacher — уже работающие контейнеры проекта compose `tanbala-leads`, второй набор не поднимать.

```bash
# почта: интерфейс и API на http://127.0.0.1:8000
cd leads && PYTHONUTF8=1 .venv/Scripts/python -m tanbala_leads web
# бот: панель на http://127.0.0.1:3100
cd whatsapp && npm run build && npm start
```

Тесты:

```bash
cd leads && PYTHONUTF8=1 .venv/Scripts/python -m pytest -q   # нужен Postgres, тесты во временной схеме
cd whatsapp && npm run check                                 # типы, линтер, тесты с порогом покрытия
```

## Этапы слияния

| Этап | Что | Статус |
| --- | --- | --- |
| 0 | план | принят 29.10.2026 |
| 1 | сборка в этой папке, тесты обоих проектов | в работе |
| 2 | живая связка на ПК | |
| 3 | установка на сервер без QR | |
| 4 | переезд бота | |
| 5 | резервные копии, проверка «всё живо», `handover/MERGE.md` | |
