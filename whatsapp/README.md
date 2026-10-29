# Tanbala WhatsApp

WhatsApp-консультант Tanbala. Отвечает клиентам на отдельном номере, объясняет RFID-учёт, выясняет задачу и передаёт горячего клиента менеджеру с выжимкой разговора. План: [docs/PLAN.md](docs/PLAN.md).

Сейчас пройден этап 1: структура, зависимости, файлы знаний и заготовки модулей. Логики ещё нет, бот ничего не отправляет.

## Стек

Node.js 22, TypeScript 6, Baileys 7, Anthropic SDK (Claude Sonnet и Haiku), SQLite через better-sqlite3, Fastify, pino, zod, Vitest. Почему так: [ADR-0001](docs/adr/0001-stack.md).

## Как поставить на ПК

1. Node.js 22.12 или новее.
2. `npm ci`. Install-скрипты пакетов отключены в `.npmrc`.
3. Скопировать `.env.example` в `.env` (в PowerShell: `Copy-Item .env.example .env`) и вписать ключи.
4. Проверки: `npm run check`.

Бота пока не запускать: подключение к WhatsApp (`WA_ENABLED`) и вызовы API только с разрешения владельца.

## Структура

```
config/models.json   модели Claude для ответа, проверки и оценки интереса
knowledge/           знания агента: tanbala-agent.md (документ владельца) и whatsapp.md
docs/                план и решения (adr/)
src/cli.ts           точка входа
src/main.ts          сборка приложения
src/config/          .env и настройки: единственное место с process.env
src/domain/          общие типы и интерфейсы внешних систем
src/shared/          общее: notImplemented для заготовок, часы, логгер pino
src/whatsapp/        Baileys: подключение, разбор входящих, переподключение
src/messaging/       исходящие: единственный путь отправки
src/pipeline/        обработка входящих по шагам плана
src/agent/           знания, промпты, три вызова модели
src/llm/             Anthropic SDK и лог токенов
src/checks/          бесплатные проверки ответа кодом
src/handoff/         передача менеджеру и уведомление
src/voice/           расшифровка голосовых через OpenRouter (этап 7)
src/db/              SQLite: подключение, миграции, репозитории
src/panel/           веб-панель (этап 6)
tests/               тесты на моках, сеть в тестах заблокирована
data/                сессия WhatsApp, база и лог токенов (не в git)
```

## Безопасность

- `.env` и `data/` не попадают в git. Папка сессии `data/whatsapp-session/` даёт полный доступ к номеру: не копировать.
- Ключ Claude только из `VENMART_ANTHROPIC_KEY`, передаётся в SDK явно.
- Панель на ПК слушает только `127.0.0.1`.
