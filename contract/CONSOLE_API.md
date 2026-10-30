# API для единой панели (console)

Статус: черновик 30.10.2026 для этапов 1–2 (`console/docs/PLAN.md`). Кто вызывает: только служба `console`
(127.0.0.1:3200). Кто отвечает: почта (`leads/`) и бот (`whatsapp/`). Контракт бота с почтой
(`contract/INTERNAL_API.md`) не меняется.

Исполнители могут добавлять поля, но не убирать и не переименовывать; каждое отклонение от этого текста — в отчёт.
Точные примеры ответов исполнитель вписывает в свой раздел после реализации.

## 1. Общее для обоих приложений

### Адреса и токены

| Приложение | Адрес | Токен в `.env` приложения | Токен в `.env` консоли |
| --- | --- | --- | --- |
| почта | `http://127.0.0.1:8000/internal/console/...` | `LEADS_CONSOLE_TOKEN` | `LEADS_CONSOLE_TOKEN` |
| бот | `http://127.0.0.1:3101/internal/console/...` | `WA_CONSOLE_TOKEN` | `WA_CONSOLE_TOKEN` |

- Заголовок `X-Console-Token`. Токен: 32–512 видимых символов ASCII. Пустой или неверного формата — API выключен,
  на любой запрос 401. Сравнение за постоянное время.
- Два токена разные. Почта не стартует, если `LEADS_CONSOLE_TOKEN` равен `INTERNAL_API_TOKEN`; бот не стартует, если
  `WA_CONSOLE_TOKEN` равен `INTERNAL_API_TOKEN`; консоль не стартует, если её два токена равны. Ошибка конфигурации
  без значений.
- Токен проверяется **первым** на любом пути под `/internal/console`, в том числе несуществующем, с неверным методом
  или неверным телом: 401 до чтения тела, до разбора параметров и до базы. Токен бота (`X-Internal-Token`) на
  `/internal/console/*` даёт 401; токен консоли на `/internal/lookup` и других путях бота даёт 401.

### Откуда можно звать

- `Host` только `127.0.0.1:<порт>` или `localhost:<порт>`. Заголовки прокси (`X-Forwarded-*`, `Forwarded`, `Via`) →
  400 `bad_request`. Запрос с `Origin` или `Sec-Fetch-Site` (так шлёт браузер, консоль не шлёт) → 403 `forbidden`.
  Это защита от DNS rebinding на ПК, где nftables нет.
- Бот на 3101: пир сокета только 127.0.0.1/::1, `trustProxy: false`.

### Запросы

- Чтение — `GET`, без побочных действий. Справку `brief` и отметку «писал в WhatsApp» эндпоинты консоли не
  вызывают никогда.
- Действия — `POST`, тело JSON-объект, `Content-Type: application/json`. Тело читается после проверки токена,
  потоком с пределом: 16 КБ, у импорта 1.5 МБ. Больше → 413 `too_large`. В почте у маршрутов консоли нет
  параметров тела Pydantic и multipart: тело читает зависимость после токена (как `read_research`).
- `X-Console-User` обязателен у `POST`: `^[a-z0-9._-]{1,32}$`, иначе 400. Это имя пользователя консоли, оно идёт в
  журнал и в `approved_by`. Права по нему не проверяются: роли проверяет консоль.
- Номера страниц `page` с 1. Ответ списка: `{"items": [...], "total": N, "page": P, "pages": M, "pageSize": S}`.
  Страница за последней — пустой `items` с верными `total` и `pages`, без ошибки.

### Ответы

- `application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Время — строка ISO 8601 в UTC. День — `ГГГГ-ММ-ДД` по Алматы (UTC+5).
- Ошибка: `{"error": "<код>", "message": "<понятный текст по-русски>"}`, без стека и текста исключения.

| HTTP | `error` | Когда |
| --- | --- | --- |
| 400 | `bad_request` | неверный параметр, тело, `X-Console-User`, заголовки прокси |
| 401 | `unauthorized` | нет токена, неверный, API выключен |
| 403 | `forbidden` | запрос из браузера (`Origin`, `Sec-Fetch-Site`) |
| 404 | `not_found` | нет такого чата, компании, письма, пути |
| 409 | `conflict` | состояние не позволяет: уже идёт запуск, письмо отклонено, компания в «не писать», компания из WhatsApp |
| 413 | `too_large` | тело больше предела |
| 422 | `refused` | правило отказало: текст ответа, закрытый режим, длина заметки, правка письма не прошла |
| 429 | `rate_limited`, `budget_exhausted`, `test_limit` | лимиты |
| 502 | `send_failed` | отправка в WhatsApp или тестовое письмо не ушло |
| 503 | `db_unavailable`, `whatsapp_unavailable`, `not_configured` | база недоступна, WhatsApp выключен, не настроен SMTP |

- Тексты `message` — как в старых панелях (они в `console/docs/FEATURES.md`), кроме неверных: на триггер базы для
  компании из WhatsApp — «Компания пришла из WhatsApp: письмо ей одобрить нельзя», а не «уже есть другое активное
  письмо».

### Чужие тексты

- Всё, что пришло с сайтов, из 2ГИС, от модели и из WhatsApp, отдаётся строкой как данные.
- Бот чистит имена, сообщения, выжимку, заметку, черновики и уведомления той же `cleanText`, что старая панель
  (управляющие символы и символы смены направления).
- Почта пропускает через `format.redact` все тексты ошибок (`runs.error`, `companies.last_error`, `test_sends.error`).
- Длины как в старых панелях.

### Логи

Без строки запроса и тела. Действия — одна строка INFO: действие, `X-Console-User`, id. Без текстов, номеров, почт.

## 2. Почта (leads)

### Порты

`python -m tanbala_leads web --port 8000 --ui-port 8001`:

- 8000: только `/internal/*` (бот и консоль). Любой другой путь → 404.
- 8001: только старый интерфейс. Любой путь, похожий на `/internal`, → 404 при любом `Host`.
- На сервере nftables пускает к 8001 только Caddy, `leads.tanbala.kz` → `127.0.0.1:8001`. Бот по-прежнему ходит на
  8000. Так взломанный бот не нажмёт кнопки старого интерфейса.

### Чтение

`GET /internal/console/summary`

```json
{
  "testMode": {"testAddress": "owner@example.kz"},
  "budget": {"dailyUsd": 1.0, "spentTodayUsd": 0.12, "over": false},
  "spend": {"totalUsd": 0.31, "totalTokens": 410000, "unpricedTokens": 0},
  "overview": {"companiesFound": 120, "companiesFit": 40, "avgScoreFit": 78, "lettersPending": 5,
               "lettersApproved": 3, "whatsappCompanies": 2},
  "activeRun": null,
  "research": {"today": 1, "perDay": 20, "active": [{"id": "uuid", "name": "…", "city": "almaty",
               "status": "running", "createdAt": "…", "startedAt": "…"}]},
  "testSends": {"today": 0, "perDay": 30}
}
```

- `testAddress` null — тестовая отправка выключена.
- `budget.spentTodayUsd` — ровно `pipeline.spent_today_usd` (так считает проверка бюджета при запуске).
- `overview` без компаний из WhatsApp (`requested_via = 'whatsapp'`), они отдельно в `whatsappCompanies`.
- `activeRun` — как `GET /runs/{id}`.

`GET /internal/console/spend?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД` (не больше 62 дней)

```json
{
  "rows": [{"day": "2026-10-30", "model": "claude-haiku-5-5", "task": "qualify", "calls": 3,
            "input": 1000, "output": 200, "cacheRead": 0, "cacheWrite": 0}],
  "prices": {"claude-haiku-5-5": {"input": 1.0, "output": 5.0, "cacheRead": 0.1, "cacheWrite": 1.25}},
  "pricesAsOf": "2026-10-06"
}
```

`prices` — USD за миллион токенов из `llm.py`. Консоль считает деньги бота и почты по этой одной таблице.

`GET /internal/console/companies?status=&query=&run=&q=&via=&wa=&blocked=&letter=&sort=&page=`

- Фильтры как в старом списке (`status`, `query` — отрасль, `run`, `q` — название или рубрика) и новые: `via=whatsapp|
  regular`, `wa=1` (писал в WhatsApp), `blocked=1`, `letter=1` (есть письмо). `sort=new|score|letter`.
- 50 на странице. Строка: `id, name, rubric, city, cityName, searchQuery, status, statusLabel, hadError, fit,
  fitLabel, score, segment, contact {email, verifyResult, verifyLabel, isCatchAll, isRole} | null, draft {id, subject,
  reviewStatus, reviewLabel, checksTotal, checksFailed} | null, requestedVia, whatsappContactedAt, blocked, createdAt`.
- Плюс `facets`: `cards` (все, письмо готово, одобрено, не подходит — с числами), `statuses` (9 статусов с числами),
  `industries` (`query`, `count`), `runs` (последние 50: `id, city, cityName, query, createdAt`), `run` — выбранный
  запуск, если задан `run`, даже если он старше 50.

`GET /internal/console/companies/{id}` — всё, что показывает старая карточка:

- `company`: название, рубрика, город, адрес, телефоны, сайт, ссылка 2ГИС (`sourceUrl`), филиалы, статус и подпись,
  `lastError` (через redact; подпись в консоли «Причина или ошибка»), `requestedVia`, `whatsappContactedAt`, запуск,
  отрасль, дата.
- `qualification` (`fit, fitLabel, score, segment, reason, model, createdAt`) или null; `pains`
  (`pain, evidence, source, verified`).
- `contacts` (адрес, страница-источник, результат проверки, флаги), `draft` (как `GET /letters/{id}`) или null,
  `history` (история писем), `blocked`, `testSends` (последние 10), `siteText` (`text` до 20 000, `length`,
  `truncated`), `cost` (`usd, tokens, unpricedTokens`).

`GET /internal/console/companies/digest?ids=1,2,3` (не больше 100 id) — для связки с чатами, без побочных действий:
`items: [{id, name, city, rubric, fit, score, segment, status, requestedVia, whatsappContactedAt, blocked, emailed,
firstLetterAt, lastLetterAt}]`. Письма сопоставляются с компанией как в `internal/lookup.py`, тестовые отправки не
считаются. Нет компании — её id нет в `items`.

`GET /internal/console/letters?status=pending|approved|rejected|all&run=&page=` — 100 на странице, порядок очереди как
сейчас (`QUEUE_ORDER`). Плюс `filters` (код, подпись, число) и `run`.

`GET /internal/console/letters/{draftId}` — письмо целиком: `id, companyId, kind, subject, body, notes` (заметки для
вас отдельно, как `split_letter`), `model, createdAt, reviewStatus, reviewLabel, approvedBy, approvedAt, checks [{code,
label, passed, details}], checksTotal, checksFailed, contact` (адрес компании с проверкой и флагами), `testAddress,
canApprove, approveBlocked, canReject, canEdit, canSendTest, sendTestBlockedReason, blocked, testSends` (последние 10),
`company` (`id, name, rubric, city, cityName, fit, fitLabel, score, segment, reason, pains, sourceUrl,
whatsappContactedAt, requestedVia, searchQuery`).

`GET /internal/console/runs?page=` — 20 на странице, как «Прошлые запуски», с расходом. `GET /internal/console/runs/
active` — запуск или `null`. `GET /internal/console/runs/{id}` — те же поля, что `/api/runs/{id}` сейчас (`run_json`).

`GET /internal/console/search/options` — города (`code, name`), подсказки отраслей, лимиты (на отрасль, отраслей,
длина), значения по умолчанию, `usdPerCompany`, `usdFirstRun`.

`GET /internal/console/history?page=` и `GET /internal/console/blocked?page=` — по 50, поля как в старых таблицах
плюс тема письма.

`GET /internal/console/research-jobs?status=&page=` — проверки из WhatsApp, по 50: `id, name, city, cityName, domain,
status, reason, reasonLabel, companyId, createdAt, startedAt, finishedAt`. Поле `error` не отдаётся.

### Действия

| Запрос | Тело | Успех | Отказы |
| --- | --- | --- | --- |
| `POST /internal/console/runs` | `{query, city, count}` | 202 `{runId}` | 400, 409 (идёт запуск №N), 429 `budget_exhausted` |
| `POST /internal/console/drafts/{id}/approve` | `{}` | `{result: "approved"}` | 404, 409 |
| `POST /internal/console/drafts/{id}/reject` | `{}` | `{result: "rejected"}` | 404, 409 |
| `POST /internal/console/drafts/{id}/edit` | `{subject, body}` | `{result: "saved", checksTotal, checksFailed}` | 404, 409, 422 |
| `POST /internal/console/drafts/{id}/send-test` | `{}` | `{result: "sent", sentTo, at}` | 404, 409, 429 `test_limit`, 502, 503 `not_configured` |
| `POST /internal/console/companies/{id}/block` | `{}` | `{result: "blocked"}` | 404 |
| `POST /internal/console/companies/{id}/whatsapp-clear` | `{}` | `{result: "cleared", wasRequestedVia}` | 404 |
| `POST /internal/console/history/import` | `{kind: "written"\|"refused", text?, fileBase64?}` | `{added, existing, invalid: [до 20 строк до 100 символов], invalidMore}` | 400 (файл не UTF-8, больше 1 МБ), 413 |

Действия вызывают ту же логику, что кнопки старого интерфейса (общий модуль для обоих), со всеми проверками и
триггерами базы. `approved_by` и `reviewer` — `X-Console-User`. Ошибки настроек SMTP — 503, а не голый 500.

## 3. Бот (whatsapp)

- Отдельный fastify в процессе бота на `127.0.0.1:${CONSOLE_API_PORT}` (по умолчанию 3101), стартует и
  останавливается вместе с панелью. Без `WA_CONSOLE_TOKEN` не стартует вовсе. Старая панель на 3100 не меняется.
- Логгер на уровне warn, без строки запроса.

### Чтение

`GET /internal/console/status`

```json
{
  "whatsapp": {"enabled": true, "state": "open", "since": "…"},
  "testMode": true, "allowlistSize": 2, "managerConfigured": true, "companyFeature": true, "llmConfigured": true,
  "apiCalls": {"today": 12, "dailyLimit": 500, "perChatLimit": 100},
  "research24h": {"count": 0, "limit": 10},
  "pairingAttempts24h": 0, "linkedAt": "…", "workingSince": null, "historyIncomplete": false
}
```

`whatsapp.state`: `open`, `connecting`, `closed` (по событиям сокета, а не по наличию объекта подключения) или
`disabled` (`WA_ENABLED=false`).

`GET /internal/console/attention`

- `handoffs`: открытые передачи, кроме `human_took_over`: `id, chatId, name, phone, reason, reasonLabel, level,
  openedAt, notification {status, statusLabel, attempts} | null` (первое уведомление после открытия).
- `hot`: `interest_level = 'hot'`: `chatId, name, phone, status, levelReason, levelUpdatedAt, lastMessageAt`.
- `waiting`: ждут ответа (`console/docs/research/data-sources.md`, раздел 3.3): `chatId, name, phone, status, group
  ("manager" — клиент написал после последнего ответа человека; "bot" — клиент ждёт бота дольше 5 минут),
  waitingSince, lastClientAt, complaint` (последняя передача — жалоба).
- `backlog`: `{pending: N}` — чаты простоя без уведомления.

`GET /internal/console/chats?status=bot|manager&level=cold|warm|hot&company=confirmed|candidate|none&waiting=1&q=&page=`
— 30 на странице, свежие сверху. `q` — имя или цифры номера. Строка: `id, name, phone` (null, если только @lid),
`phoneHidden, status, statusBy, statusLabel, level, lastMessageAt, lastMessage {author, kind, text до 140} | null,
openHandoff {reason, reasonLabel, level, openedAt} | null, company {state, id, name} | null, waitingSince | null`.

`GET /internal/console/chats/{id}` — всё, что показывает старая карточка, и больше:

- `chat`: имя, номер, статус, кто решил и подпись, когда, уровень, создан, `priceAsks, refusedAnswers, handedOff`.
- `profile`: `fields [{key, label, value, inferred}]` (14 полей), `problemAgreed`, `levelReason`, `updatedAt`.
- `note {text, at} | null`; `openHandoff`; `handoffs` (история: `id, reason, reasonLabel, level, openedAt,
  resolvedAt`); `lastNotification {kind, kindLabel, status, statusLabel, attempts, at, text} | null`.
- `company` — сводка бота целиком: состояние («подтверждена», «кандидат», «не определена», «функция выключена»,
  «данные не прочитаны»), кандидат (`id, name, city, source, sourceLabel`), подтверждённая (`id, name, city, rubric,
  emailed, pains`), проверка новой компании (состояние и подпись), боли, подтверждённые клиентом, название со слов
  клиента.
- `rejected {items (до 20: at, attempt, source, sourceLabel, draft, remarks), total}`.
- `messages {items [{id, author, authorLabel, kind, text, at}], earlierBefore}` — последние 50, старые сверху.
  Голосовое без расшифровки и «сообщение другого вида» — `text: null` и свой `kind`.

`GET /internal/console/chats/{id}/messages?before=<id>` — `{items, earlierBefore}`.

`GET /internal/console/notifications?status=&page=` — 30 на странице: `id, at, updatedAt, kind, kindLabel, status,
statusLabel, attempts, chatId, chatName, text`.

`GET /internal/console/company-links?companyId=` — подтверждённые связи чат → компания (без `companyId` — все, до
1000): `items [{chatId, companyId, name, phone, status, level, confirmedAt, firstClientMessageAt, lastMessageAt}]`.

`GET /internal/console/spend?from=&to=` (не больше 62 дней) — из `token-usage.jsonl` и прошлого файла после ротации:
`rows [{day, provider, model, purpose, calls, failed, input, output, cacheRead, cacheWrite}]`. Цена расшифровок
OpenRouter не учитывается.

### Действия

| Запрос | Тело | Успех | Отказы |
| --- | --- | --- | --- |
| `POST /internal/console/chats/{id}/reply` | `{text}` | `{result: "sent"}` или `{result: "duplicate"}` | 404, 422 `refused` (текст, закрытый режим, WhatsApp выключен), 502 `send_failed` («Не отправлено. Чат уже у менеджера, бот в нём молчит.») |
| `POST /internal/console/chats/{id}/return` | `{note}` | `{result: "returned"}`, `"returned_answering"` или `"already_bot"` | 404, 422 (заметка длиннее 1000), 502 |

- Та же логика и порядок, что у кнопок старой панели (общий модуль `panel/chat-actions.ts`), то же окно дубля 10 с.
- `already_bot`: заметка не сохранена, `message` это говорит.
- «Вернуть боту» с двумя полями склеивает консоль: `Ответ клиенту: …` и `Задание боту: …` через пустую строку,
  пустые части пропускаются. Предел 1000 символов — у итоговой заметки.
