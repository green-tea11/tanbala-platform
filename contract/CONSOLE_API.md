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
- Плюс `facets`: `cards` (все, письмо готово, одобрено, не подходит, нет почты — с числами), `statuses` (10 статусов
  с числами), `industries` (`query`, `count`), `runs` (последние 50: `id, city, cityName, query, createdAt`), `run` —
  выбранный запуск, если задан `run`, даже если он старше 50.
- «Нет почты» (01.11.2026): `status` строки, карточки и фильтра — 9 статусов базы и `no_email` («Нет почты», тон
  `muted`). Это компания, которую пайплайн отсеял без Claude, потому что почты нет ни в 2ГИС, ни на сайте: в базе она
  `rejected` без единой оценки. `rejected` («Не подходит») — только те, кого оценил Claude. У `no_email` `hadError`
  всегда `false` (это итог отбора, а не сбой); причина в `lastError` карточки. `digest` отдаёт статус базы.

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

### Реализация почты (30.10.2026): уточнения и отличия

Код: `leads/tanbala_leads/web/console.py` (маршруты и проверки), `console_views.py` (ответы), `console_queries.py`
(SQL), `actions.py` (действия, общие со старыми кнопками), `ports.py` (порты). Тесты: `leads/tests/test_console_api.py`,
`test_console_actions.py`, `test_ports.py`.

Отличия от текста выше (поля только добавлены, ни одно не убрано и не переименовано):

- Ошибка 500 `internal` («Внутренняя ошибка почты. Подробности в журнале сервера.») на любое непойманное исключение,
  без текста исключения. В таблице раздела 1 её нет.
- Неверный метод (405 фреймворка) отвечает 400 `bad_request`, как у API бота; нет пути — 404 `not_found`. Оба после
  токена и проверки браузера.
- Текст 409 на триггер базы — ровно «Компания пришла из WhatsApp: письмо ей одобрить нельзя» (без точки, как в
  контракте). Старый интерфейс по-прежнему пишет «У компании уже есть другое активное письмо.».
- `reviewer` при «Отклонить» ядро не хранит (`steps/approve.reject` его не записывает, так было и раньше); в журнал
  пользователь попадает.
- Предел тела у `POST /drafts/{id}/edit` — 32 КБ (32 768 байт), а не 16: письмо до 10 000 символов, кириллица в UTF-8
  по 2 байта, тема 200 и текст 10 000 символов — около 20,6 КБ. Остальные действия — 16 КБ, импорт — 1.5 МБ. Текст
  слать как есть в UTF-8 (так делает `JSON.stringify`); с экранированием `\uXXXX` письмо в 32 КБ не войдёт.
- Повторное «Одобрить» уже одобренного письма из консоли — 409 «Письмо уже одобрено.», чтобы не перезаписать, кто и
  когда одобрил. Старая кнопка повтор допускает, как раньше.
- 503 `not_configured` — только на ошибку настроек (`SettingsError`: нет `SMTP_*`, `AGENT_*`, `SMTP_PORT` не число).
  Любая другая ошибка при тестовой отправке — 500 `internal`.
- Номер в пути (`/companies/{id}`, `/letters/{id}`, `/runs/{id}`, `/drafts/{id}/…`) — до 19 цифр; длиннее — 404
  `not_found` после токена. Номер больше 9223372036854775807 — тоже 404.

Уточнения:

- Порядок проверок: Host и заголовки прокси (400 `bad_request`, JSON) → токен (401) → `Origin` или `Sec-Fetch-Site`
  с любым значением (403) → у `POST` `X-Console-User` (400) → `Content-Type: application/json` и тело потоком до 16 КБ
  (правка письма до 32 КБ, импорт до 1.5 МБ = 1 572 864 байт; 413 и по `Content-Length`, и по факту) → JSON-объект
  (400) → поля (лишние и
  неверного типа — 400) → база. `Sec-Fetch-Mode` (его шлёт fetch из Node) не мешает.
- Действия без полей принимают ровно `{}`; пустое тело — 400.
- Время — ISO 8601 в UTC с секундами: `"2026-10-30T07:37:41+00:00"`.
- Страница: целое от 1, иначе 400; за последней — пустой `items`. `pages` не меньше 1.
- Неизвестные значения фильтров (`status`, `via`, `sort`, `wa`, `blocked`, `letter`, `run`) — 400, а не тихий сброс,
  как в старом списке. `q` (до 100) и `query` (до 60) чистятся как в старом списке. `wa`, `blocked`, `letter`:
  `1` — фильтр, `0` или пусто — без фильтра.
- `blocked` у строки списка, в `digest` и в карточке — одно правило: сама компания или её домен в «не писать», либо
  адрес или домен получателя последнего письма компании.
- `letter=1` — у компании есть хоть одно письмо (и отклонённое). `sort=score` — оценка последней квалификации, без
  оценки в конце; `sort=letter` — дата последнего письма, без письма в конце; при равенстве новые сверху.
- `facets.cards[].code`: `all`, `drafted`, `approved`, `rejected`, `no_email`. Числа у карточек и статусов — при всех фильтрах,
  кроме статуса; у отраслей — при всех, кроме отрасли.
- `spend`: `from` и `to` обязательны, включительно, годы 2000–2100, сутки по UTC+5 (постоянный сдвиг, как у бота); ответ ещё отдаёт
  `from` и `to`. Модель без цены в `prices` отсутствует. `summary.budget.spentTodayUsd` — ровно `spent_today_usd`
  (сутки Postgres `Asia/Almaty`, сейчас тоже +05:00), модель без цены там считается по самой дорогой.
- `summary.budget.over` = `dailyUsd` задан и `spentTodayUsd >= dailyUsd` (при бюджете 0 тоже `true`: запуск всё
  равно откажет). `research.perDay` и `budget.dailyUsd` — `null`, если не настроены (на сервере всегда заданы).
- `GET /runs/active` — `200` и тело `null`, если ничего не идёт.
- `POST /runs` 409: `message` «Идёт запуск №N. Новый можно начать, когда он закончится.» и поле `activeRunId`.
  Неверный `count` (не целое, `true`) — 400 «Число компаний должно быть от 1 до 20», как у формы.
- `canApprove` — `false` и у компании из WhatsApp (одобрить не даст триггер базы). `approveBlocked` — письмо ждёт
  решения, но одобрить нельзя; причина в новом поле `approveBlockedReason`: «Компания в списке «не писать»: письмо
  нельзя одобрить.» или «Компания пришла из WhatsApp: письмо ей одобрить нельзя»; иначе `null`.
- `canSendTest` = письмо можно отправить в тест и `testAddress` не `null`. `sendTestBlockedReason`: «Тестовая отправка
  выключена: DRY_RUN_TO не настроен.», «Отклонённое письмо не отправляется даже в тест.» или «Письмо уже
  отправлено.». 429 `test_limit` — «Дневной лимит тестовых отправок 30 исчерпан».
- `wasRequestedVia` — прежнее значение `requested_via`: `"whatsapp"` или `null`.
- Импорт: `invalid` — до 20 строк по 100 символов, остальные числом в `invalidMore`; `fileBase64` не base64 — 400;
  пустой список — 400 «Список пуст: вставьте адреса или выберите файл.»; неизвестный `kind` — 400 «Неизвестный
  список.».
- `digest`: id без повторов, в порядке запроса; больше 100 — 400.
- Лог действия — одна строка INFO: `Консоль: approve, письмо 12, пользователь ivan: ok` (при отказе вместо `ok` код
  ошибки; у импорта ещё числа). В access-логе путь консоли без строки запроса; неизвестный путь `/internal/[скрыто]`.

### Примеры ответов почты (точные, тестовая схема)

Ошибки:

```json
{"error": "unauthorized", "message": "Нужен верный токен консоли в заголовке X-Console-Token."}
{"error": "not_found", "message": "Такого адреса нет."}
{"error": "bad_request", "message": "Нужен заголовок X-Console-User: строчная латиница, цифры, «.», «_» или «-», от 1 до 32 символов."}
{"error": "conflict", "message": "Компания в списке «не писать»: письмо нельзя одобрить."}
{"error": "conflict", "message": "Идёт запуск №7. Новый можно начать, когда он закончится.", "activeRunId": 7}
{"error": "refused", "message": "Тема и текст письма не должны быть пустыми."}
```

`GET /internal/console/summary`

```json
{"testMode": {"testAddress": "bogdansm2000@gmail.com"},
 "budget": {"dailyUsd": 1.0, "spentTodayUsd": 0.003263, "over": false},
 "spend": {"totalUsd": 0.003263, "totalTokens": 38300, "unpricedTokens": 0},
 "overview": {"companiesFound": 1, "companiesFit": 1, "avgScoreFit": 86, "lettersPending": 1, "lettersApproved": 0,
              "whatsappCompanies": 1},
 "activeRun": null,
 "research": {"today": 1, "perDay": 20, "active": []},
 "testSends": {"today": 0, "perDay": 30}}
```

Элемент `research.active` — как строка `GET /research-jobs` (ниже).

`GET /internal/console/spend?from=2026-10-30&to=2026-10-30`

```json
{"from": "2026-10-30", "to": "2026-10-30",
 "rows": [{"day": "2026-10-30", "model": "claude-haiku-5-5", "task": "first_email", "calls": 1, "input": 3500,
           "output": 2250, "cacheRead": 9500, "cacheWrite": 9500},
          {"day": "2026-10-30", "model": "claude-haiku-5-5", "task": "qualify", "calls": 1, "input": 3300,
           "output": 150, "cacheRead": 10100, "cacheWrite": 0}],
 "prices": {"claude-haiku-5-5": {"input": 0.1, "output": 0.5, "cacheRead": 0.01, "cacheWrite": 0.125},
            "claude-sonnet-5-5": {"input": 2.0, "output": 10.0, "cacheRead": 0.2, "cacheWrite": 2.5}},
 "pricesAsOf": "2026-10-06"}
```

`GET /internal/console/companies?sort=score` (статусы сокращены: всегда 10, в порядке старого фильтра)

```json
{"items": [
   {"id": 1, "name": "ТОО «Степь Склад»", "rubric": "Складские услуги", "city": "almaty", "cityName": "Алматы",
    "searchQuery": "склад", "status": "drafted", "statusLabel": "Письмо готово", "statusTone": "accent",
    "hadError": false, "fit": "yes", "fitLabel": "подходит", "score": 86, "segment": "склады 3PL",
    "contact": {"email": "info@step-sklad.kz", "verifyResult": "safe", "verifyLabel": "Существует",
                "isCatchAll": null, "isRole": true},
    "draft": {"id": 1, "subject": "Инвентаризация 12 000 паллетомест за часы", "reviewStatus": "pending",
              "reviewLabel": "Ждёт проверки", "checksTotal": 2, "checksFailed": 1},
    "requestedVia": null, "whatsappContactedAt": null, "blocked": false, "createdAt": "2026-10-30T07:37:41+00:00"},
   {"id": 2, "name": "ТОО «Рахат»", "rubric": "Оптовая торговля", "city": "almaty", "cityName": "Алматы",
    "searchQuery": null, "status": "qualified", "statusLabel": "Подходит", "statusTone": "neutral",
    "hadError": false, "fit": null, "fitLabel": null, "score": null, "segment": null, "contact": null, "draft": null,
    "requestedVia": "whatsapp", "whatsappContactedAt": "2026-10-28T12:00:00+00:00", "blocked": false,
    "createdAt": "2026-10-30T07:37:41+00:00"}],
 "total": 2, "page": 1, "pages": 1, "pageSize": 50,
 "facets": {
   "cards": [{"code": "all", "label": "Все", "count": 2}, {"code": "drafted", "label": "Письмо готово", "count": 1},
             {"code": "approved", "label": "Одобрено", "count": 0}, {"code": "rejected", "label": "Не подходит", "count": 0},
             {"code": "no_email", "label": "Нет почты", "count": 0}],
   "statuses": [{"code": "new", "label": "Найдена", "count": 0}, {"code": "qualified", "label": "Подходит", "count": 1},
                {"code": "drafted", "label": "Письмо готово", "count": 1}, "…"],
   "industries": [{"query": "склад", "count": 1}],
   "runs": [{"id": 1, "city": "almaty", "cityName": "Алматы", "query": "склад, логистика",
             "createdAt": "2026-10-30T07:37:41+00:00"}],
   "run": null}}
```

`GET /internal/console/companies/1`

```json
{"company": {"id": 1, "name": "ТОО «Степь Склад»", "rubric": "Складские услуги", "city": "almaty",
             "cityName": "Алматы", "address": "Алматы, ул. Рыскулова, 57", "phones": ["+7 727 355 10 20"],
             "website": "https://step-sklad.kz", "websiteDomain": "step-sklad.kz",
             "sourceUrl": "https://2gis.kz/almaty/firm/70000001", "branchesCount": 3, "status": "drafted",
             "statusLabel": "Письмо готово", "statusTone": "accent", "lastError": null, "requestedVia": null,
             "whatsappContactedAt": null, "runId": 1, "searchQuery": "склад", "createdAt": "2026-10-30T07:37:41+00:00"},
 "qualification": {"fit": "yes", "fitLabel": "подходит", "score": 86, "segment": "склады 3PL",
                   "reason": "Склад на 12 000 паллетомест, инвентаризация вручную.", "model": "claude-haiku-5-5",
                   "createdAt": "2026-10-30T07:37:41+00:00"},
 "pains": [{"pain": "Инвентаризация занимает дни", "evidence": "пересчёт раз в квартал", "source": "site",
            "sourceLabel": "сайт", "verified": true}],
 "contacts": [{"id": 1, "email": "info@step-sklad.kz", "sourcePage": "https://step-sklad.kz/kontakty",
               "verifyResult": "safe", "verifyLabel": "Существует", "isCatchAll": null, "isRole": true,
               "verifiedAt": null}],
 "draft": "… как GET /letters/1 …",
 "history": [{"id": 1, "occurredAt": "2026-10-30T07:37:41+00:00", "email": "director@step-sklad.kz",
              "direction": "out", "directionLabel": "отправлено", "kind": "first_email", "kindLabel": "первое письмо",
              "whatLabel": "отправлено, первое письмо", "source": "import", "sourceLabel": "импорт", "subject": null,
              "note": "импорт прошлых писем", "draftId": null}],
 "blocked": false,
 "testSends": [{"id": 1, "sentTo": "bogdansm2000@gmail.com", "status": "failed", "statusLabel": "не ушло",
                "ok": false, "error": "SMTP: SMTPAuthenticationError", "createdAt": "2026-10-30T07:37:41+00:00"}],
 "siteText": {"text": "Ответственное хранение, 12 000 паллетомест.", "length": 43, "truncated": false},
 "cost": {"usd": 0.003263, "tokens": 38300, "unpricedTokens": 0}}
```

`GET /internal/console/companies/digest?ids=1,2,999`

```json
{"items": [
   {"id": 1, "name": "ТОО «Степь Склад»", "city": "almaty", "cityName": "Алматы", "rubric": "Складские услуги",
    "fit": "yes", "score": 86, "segment": "склады 3PL", "status": "drafted", "requestedVia": null,
    "whatsappContactedAt": null, "blocked": false, "emailed": true, "firstLetterAt": "2026-10-30T07:37:41+00:00",
    "lastLetterAt": "2026-10-30T07:37:41+00:00"},
   {"id": 2, "name": "ТОО «Рахат»", "city": "almaty", "cityName": "Алматы", "rubric": "Оптовая торговля",
    "fit": null, "score": null, "segment": null, "status": "qualified", "requestedVia": "whatsapp",
    "whatsappContactedAt": "2026-10-28T12:00:00+00:00", "blocked": false, "emailed": false, "firstLetterAt": null,
    "lastLetterAt": null}]}
```

`GET /internal/console/letters`

```json
{"items": [{"id": 1, "companyId": 1, "companyName": "ТОО «Степь Склад»", "kind": "first_email",
            "subject": "Инвентаризация 12 000 паллетомест за часы", "reviewStatus": "pending",
            "reviewLabel": "Ждёт проверки", "checksTotal": 2, "checksFailed": 1, "score": 86, "verifiedPains": 1,
            "searchQuery": "склад", "blocked": false, "createdAt": "2026-10-30T07:37:41+00:00",
            "updatedAt": "2026-10-30T07:37:41+00:00", "sentAt": null}],
 "total": 1, "page": 1, "pages": 1, "pageSize": 100, "status": "pending",
 "filters": [{"code": "pending", "label": "Ждут проверки", "count": 1}, {"code": "approved", "label": "Одобрены", "count": 0},
             {"code": "rejected", "label": "Отклонены", "count": 0}, {"code": "all", "label": "Все", "count": 1}],
 "run": null}
```

`run` при фильтре — `{"id", "city", "cityName", "query", "createdAt"}`, как `facets.run` у компаний.

`GET /internal/console/letters/1`

```json
{"id": 1, "companyId": 1, "kind": "first_email", "subject": "Инвентаризация 12 000 паллетомест за часы",
 "body": "[Проверить: число паллетомест с сайта]\nЗдравствуйте!\n\nПишу по поводу склада.\n\nАрман",
 "notes": [{"kind": "Проверить", "text": "число паллетомест с сайта"}],
 "textLines": [{"text": "Здравствуйте!", "note": false}, {"text": "", "note": false},
               {"text": "Пишу по поводу склада.", "note": false}, {"text": "", "note": false},
               {"text": "Арман", "note": false}],
 "model": "claude-haiku-5-5", "createdAt": "2026-10-30T07:37:41+00:00", "updatedAt": "2026-10-30T07:37:41+00:00",
 "sentAt": null, "reviewStatus": "pending", "reviewLabel": "Ждёт проверки", "approvedBy": null, "approvedAt": null,
 "checks": [{"code": "length", "label": "Длина", "passed": false, "details": ["длиннее 120 слов"]},
            {"code": "dashes", "label": "Тире", "passed": true, "details": []}],
 "checksTotal": 2, "checksFailed": 1,
 "contact": {"email": "info@step-sklad.kz", "verifyResult": "safe", "verifyLabel": "Существует", "isCatchAll": null,
             "isRole": true},
 "testAddress": "bogdansm2000@gmail.com", "canApprove": true, "approveBlocked": false,
 "approveBlockedReason": null, "canReject": true,
 "canEdit": true, "canSendTest": true, "sendTestBlockedReason": null, "blocked": false,
 "testSends": [{"id": 1, "sentTo": "bogdansm2000@gmail.com", "status": "failed", "statusLabel": "не ушло",
                "ok": false, "error": "SMTP: SMTPAuthenticationError", "createdAt": "2026-10-30T07:37:41+00:00"}],
 "company": {"id": 1, "name": "ТОО «Степь Склад»", "rubric": "Складские услуги", "city": "almaty",
             "cityName": "Алматы", "fit": "yes", "fitLabel": "подходит", "score": 86, "segment": "склады 3PL",
             "reason": "Склад на 12 000 паллетомест, инвентаризация вручную.",
             "pains": [{"pain": "Инвентаризация занимает дни", "evidence": "пересчёт раз в квартал", "source": "site",
                        "sourceLabel": "сайт", "verified": true}],
             "sourceUrl": "https://2gis.kz/almaty/firm/70000001", "whatsappContactedAt": null, "requestedVia": null,
             "searchQuery": "склад"}}
```

`body` — текст как в базе (для правки), `notes` и `textLines` — как показывает старая страница (`textLines[].note` —
заметка посреди текста, она уйдёт клиенту).

`GET /internal/console/runs/1` (элемент `GET /runs` и `summary.activeRun` — то же)

```json
{"id": 1, "city": "almaty", "cityName": "Алматы", "query": "склад, логистика", "industries": ["склад", "логистика"],
 "maxCompanies": 5, "status": "done", "statusLabel": "Готово", "statusTone": "pos", "stage": "Готово",
 "stageLabel": "Готово", "stageDetail": null, "found": 10, "newCompanies": 8, "crawled": 8, "qualified": 3,
 "rejected": 3, "noEmail": 2, "verified": 3, "drafted": 2, "errors": 1, "error": null,
 "createdAt": "2026-10-30T07:37:41+00:00",
 "startedAt": "2026-10-30T07:17:41+00:00", "finishedAt": "2026-10-30T07:32:41+00:00",
 "cost": {"usd": 0.003263, "tokens": 38300, "unpricedTokens": 0, "priced": true, "text": "≈ $0,0033"},
 "stages": [{"code": "collect", "label": "Поиск в 2ГИС", "state": "done", "stateLabel": "готово",
             "hint": "компании по запросу", "counters": [{"field": "found", "label": "найдено", "value": 10},
                                                       {"field": "new_companies", "label": "новых", "value": 8}]},
            "… crawl, qualify, verify, draft …"],
 "finished": true, "lettersPending": 1, "pendingTotal": 1, "showReview": true}
```

`GET /internal/console/runs` — `{"items": [как выше], "total": 1, "page": 1, "pages": 1, "pageSize": 20}`.

`noEmail` (01.11.2026) — компании без почты, отсеянные без Claude; раньше они входили в `rejected`, у старых запусков
`noEmail` 0. У этапа `qualify` три счётчика: `qualified` «подходят», `rejected` «не подходят», `no_email` «без почты».

`GET /internal/console/search/options`

```json
{"cities": [{"code": "almaty", "name": "Алматы"}, {"code": "astana", "name": "Астана"}, "… всего 8 …"],
 "quickQueries": ["склад", "логистика", "производство", "магазин одежды", "оборотная тара", "строительная компания"],
 "limits": {"maxQueries": 10, "maxQueryLength": 60, "maxQueryTextLength": 620, "maxPerIndustry": 20, "maxTotal": 60},
 "defaults": {"city": "almaty", "count": 5}, "usdPerCompany": 0.003311, "usdFirstRun": 0.00245}
```

`GET /internal/console/history`, `GET /internal/console/blocked`, `GET /internal/console/research-jobs`

```json
{"items": [{"id": 1, "occurredAt": "2026-10-30T07:37:41+00:00", "email": "director@step-sklad.kz", "direction": "out",
            "directionLabel": "отправлено", "kind": "first_email", "kindLabel": "первое письмо",
            "whatLabel": "отправлено, первое письмо", "source": "import", "sourceLabel": "импорт", "subject": null,
            "note": "импорт прошлых писем", "draftId": null, "companyId": null, "companyName": null}],
 "total": 1, "page": 1, "pages": 1, "pageSize": 50}
{"items": [{"id": 1, "email": null, "domain": "spam.example.kz", "companyId": null, "companyName": null,
            "reason": "refused", "reasonLabel": "отказ", "note": "импорт", "createdAt": "2026-10-30T07:37:41+00:00"}],
 "total": 1, "page": 1, "pages": 1, "pageSize": 50}
{"items": [{"id": "3f2c9e0a-0000-4000-8000-000000000001", "name": "Рахат", "city": "almaty", "cityName": "Алматы",
            "domain": "rahat.kz", "status": "done", "statusLabel": "Готово", "reason": null, "reasonLabel": null,
            "companyId": 2, "createdAt": "2026-10-30T05:00:00+00:00", "startedAt": "2026-10-30T05:00:01+00:00",
            "finishedAt": "2026-10-30T05:00:40+00:00"}],
 "total": 1, "page": 1, "pages": 1, "pageSize": 50}
```

`reasonLabel`: `not_in_2gis` «В 2ГИС не нашлась», `city_unsupported` «Город не поддерживается», `budget_exhausted`
«Дневной бюджет API исчерпан», `error` «Ошибка при проверке». `statusLabel`: «В очереди», «Идёт», «Готово»,
«Не удалось». Телефон клиента бота не отдаётся.

Действия (успех):

```json
{"runId": 2}
{"result": "approved"}
{"result": "rejected"}
{"result": "saved", "checksTotal": 10, "checksFailed": 1}
{"result": "sent", "sentTo": "bogdansm2000@gmail.com", "at": "2026-10-30T07:37:42+00:00"}
{"result": "blocked"}
{"result": "cleared", "wasRequestedVia": "whatsapp"}
{"added": 2, "existing": 0, "invalid": ["не адрес"], "invalidMore": 0}
```

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

- `chat`: имя, номер, статус, кто решил и подпись, когда, уровень, создан, `priceAsks, refusedAnswers, handedOff`,
  `toldFacts [{id, label}]` (с 31.10.2026).
- `profile`: `fields [{key, label, value, inferred}]` (14 полей), `calc {known, missing}` (с 31.10.2026),
  `problemAgreed`, `levelReason`, `updatedAt`.
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

### Реализация бота (30.10.2026): точные примеры и отличия

Код: `whatsapp/src/panel/console-*.ts`, действия `whatsapp/src/panel/chat-actions.ts` (их же зовут кнопки старой панели),
выборки `whatsapp/src/db/repos/console-*.ts`. Примеры ниже сняты с работающего кода (тестовый стенд), время в UTC.

**Запуск и настройки.** `WA_CONSOLE_TOKEN` пуст — сервер 3101 не собирается и не слушает, а `CONSOLE_API_PORT` не
проверяется вовсе (неверный порт без токена бота не останавливает). Токен не по формату (не 32–512 видимых ASCII),
равен `INTERNAL_API_TOKEN`, `CONSOLE_API_PORT` не целое от 1 до 65535 или равен `PANEL_PORT` — бот не стартует
(ошибка конфигурации без значений), как с неверным `INTERNAL_API_TOKEN`. Сервер стартует после панели (внутри
`Panel.start`) и закрывается перед ней. Порт занят (или любой другой отказ `listen`) — бот останавливается целиком,
как при занятом порте панели: в лог одна строка ERROR `ConsoleApiStartError` «API консоли не запустился на
127.0.0.1:3101 (EADDRINUSE): бот остановлен, чтобы токен консоли не ушёл чужому серверу на этом порту…» (без токена),
код выхода 1, systemd перезапускает бота. Так токен не уходит тому, кто занял порт.

**Порядок проверок** на любом пути и методе: сокет не 127.0.0.1/::1 → 403 `forbidden`; токен → 401 `unauthorized`;
Host не `127.0.0.1:<порт>`/`localhost:<порт>` → 400; `X-Forwarded-*`, `Forwarded`, `Via` → 400; `Origin` или
`Sec-Fetch-Site` → 403; у POST `X-Console-User` → 400. Потом тело (только `application/json`, объект, до 16 КБ:
больше → 413 `too_large`, другой тип или не объект → 400), потом параметры (неверное значение → 400, пустое
`status=` — «не задано»), потом база. Неизвестный путь или метод с верным токеном → 404 `not_found` (405 у Fastify
нет). Ошибка SQLite → 503 `db_unavailable`, прочая → 500 `internal`.

**Отличия и добавления к тексту выше** (ничего не убрано и не переименовано):

- Новые коды ошибок: `return_failed` (502, возврат боту не прошёл: «Не удалось вернуть чат боту. Подробности записаны
  в лог бота.»), `log_too_large` (503, лог расхода больше 32 МБ, см. «Расход») и `internal` (500).
- Ответ клиенту, 502 `send_failed`: текст по настоящему статусу после сбоя — «Не отправлено. Чат уже у менеджера, бот
  в нём молчит.» или, если не прошла сама передача, «Не отправлено. Статус чата не менялся.».
- 422 `refused` у ответа: тексты старой панели (пустой, длиннее 4096, закрытый режим или WhatsApp не подключён,
  отказ `PanelSendError`). Если отказ отправки (`PanelSendError`) пришёл уже после передачи чата менеджеру, к тексту
  дописано «Чат уже у менеджера, бот в нём молчит.» (только в консоли, старая панель пишет как раньше). Поле `text`
  не строка или его нет → 400. У возврата поле `note` необязательно (нет → без заметки), не строка → 400.
- 429 `rate_limited` у ответа (только ответы через API консоли, кнопки старой панели не считаются): скользящий час в
  памяти бота, не больше 20 ответов в один чат и 100 во все. Считаются только ушедшие ответы (отказ, сбой и дубль
  места не занимают); при отказе ничего не вызывается, чат не передаётся. Порядок: нет чата → 404, затем предел, затем
  та же логика, что у кнопки. Тексты: «Из консоли в этот чат уже отправлено 20 ответов за последний час: подождите
  или ответьте с телефона.» и «Из консоли уже отправлено 100 ответов за последний час: подождите или ответьте с
  телефона.». После перезапуска бота счёт с нуля.
- Добавлены поля: `levelLabel` рядом с каждым `level`; `phoneHidden` в строке списка и в `chat`;
  `statusChangedAt`; `resumed` в ответе возврата; `message` у `already_bot`; `from`, `to`, `skippedLines` у расхода;
  `lastNotification` — уведомление целиком (ещё `id`, `updatedAt`, `chatId`); у компании `stateLabel`, `cardUrl`
  (только http/https), `research {status, reason?, label, startedAt, finishedAt}`.
- Передача чата менеджеру (решение владельца 30.10.2026, добавлено 31.10.2026, ничего не убрано и не переименовано):
  - `levelReason` (в карточке и в `attention.hot`): когда чат передаёт бот (горячий клиент, просьба о человеке, жалоба,
    нет ответа в документах), это причина передачи своими словами с цитатой последнего сообщения клиента, например
    «Третий раз спрашивает цену. Клиент: «Так сколько?»». Тексты: «Всё для расчёта известно, клиент готов к
    расчёту.», «Спрашивает цену, сроки или договор, задача понятна.», «Третий раз спрашивает цену.», «Дважды подряд
    уходит от вопросов.», «Просит живого человека.», «Жалуется.», «Ответа нет в документах.», затем «Клиент: «…»»
    (цитата одной строкой до 150 знаков). При технических причинах (`check_failed`, `llm_error`, лимит) и без передачи
    это по-прежнему причина оценки интереса.
  - `profile.calc`: что нужно для расчёта (чем занимается клиент, что лежит на хранении, сколько этого, сколько нового
    в месяц, сколько проходов, есть ли 1С и какая, город) по порядку разговора: `known [{key, label, inferred}]` —
    известно (`inferred: true` — вывод из слов клиента, консоль пишет «вероятно»), `missing [{key, label}]` — чего не
    хватает; пустой `missing` — для расчёта известно всё. Ключи: `business, items, itemCount, monthlyIntake, passages,
    has1C, city`. Значения полей — в `fields`.
  - `chat.toldFacts`: сильные стороны, уже рассказанные клиенту, по порядку F1…F10: `id` и короткое название
    («метка читается по радио», «сотни меток за секунду», «антенны на входе и выходе», «ручной сканер», «в метку
    записан товар», «интеграция с 1С», «своя веб-платформа», «под ключ», «лучше штрихкода», «не госмаркировка»).
  - Уведомление менеджеру (`lastNotification.text`, `notifications`): строка «Причина: …» сразу после заголовка;
    вместо строк о минимуме для оценки цены — «Для расчёта известно: …», «Для расчёта не хватает: …» и «Рассказано
    клиенту: …».
- `name` — имя из профиля WhatsApp без скрытых символов, нет имени → `null` (подпись «без имени» ставит консоль).
  `phone` — цифры без «+», только `@lid` → `null`.
- Скрытые символы: в JSON консоли имена, сообщения, выжимка, причина уровня, заметка, черновики и замечания,
  уведомления, названия компаний и модели в расходе проходят `cleanText` старой панели и ещё теряют U+200B–U+200F,
  U+061C, U+2028, U+2029, U+FEFF и U+00AD. Старая панель чистит как раньше.
- Выжимка: `value` — слова клиента без пометки «вероятно», `inferred: true` — значение выведено, консоль пишет
  «вероятно». Ключи по порядку старой карточки: `business, items, packaging, material, city, premises, area,
  itemCount, turnover, scope, currentTracking, problem, oneC, specifics`. `refusedAnswers` — `true`/`false`.
- Сообщения: `text: null` у голосового без расшифровки, у «другого вида» и у пустого; текст не обрезается.
  В списке чатов `lastMessage.text` до 140 символов, длиннее — 139 и «…».
- «Ждут ответа» (`waitingSince`, `attention.waiting`, `waiting=1`): `manager` — после последнего ответа (человека или
  бота, кроме фразы о передаче) клиент написал, ждёт с первого такого сообщения; `bot` — после последнего сообщения
  не клиента клиент написал, и `waitingSince`, и порог 5 минут считаются от ПЕРВОГО неотвеченного сообщения клиента
  (а не от последнего, как в черновом SQL `data-sources.md`): клиент, дописавший минуту назад, но ждущий полчаса, в
  списке.
- `attention`: каждый список не длиннее 200, `handoffs` и `hot` свежие сверху, `waiting` — дольше всех ждущие сверху.
  В `waiting` только чаты, где последнее сообщение клиента не старше 30 дней (список чатов с `waiting=1` и
  `waitingSince` в строках окно не применяют). Добавлено поле `counts`: у каждого списка `total` (сколько всего, без
  предела) и `truncated` (`true` — список обрезан пределом 200), у `waiting` ещё `staleExcluded` — сколько ждущих
  отброшено окном 30 дней. Списки и числа читаются одной транзакцией.
- `company` в строке списка и фильтр `company=` — по записи бота (`$.confirmed.id`, иначе `$.candidate.id`;
  испорченная запись — `none`), `name` — как записал бот.
- `company-links` (с `companyId` и без): свежие сверху — по последнему сообщению чата (без сообщений — по времени
  подтверждения), при равенстве больший `companyId`, затем `chatId`; не больше 1000, так что отбрасываются самые
  старые связи. Добавлены `total` (сколько всего) и `truncated` (`true` — обрезано пределом 1000).
- Список чатов: `total` и страница читаются одной транзакцией; последнее сообщение, «ждёт с», передача и компания
  считаются только для строк страницы (для всех чатов — только при фильтре `waiting=1` или `company=`). Замер на
  500 чатах по 50 сообщений: список с числом 1–4 мс, `attention` около 5 мс.
- Поиск `q` (до 64 символов): имя без учёта регистра в любом сочетании (кириллица тоже: «аЛиЯ» находит «АлИя») и без
  скрытых символов в имени и запросе, или цифры номера (от 3, без пробелов, `+`, скобок, дефисов, точек).
- Расход: `from` и `to` обязательны, до 62 дней включительно; читаются `TOKEN_LOG_PATH.1` и `TOKEN_LOG_PATH`;
  строки по дню, провайдеру, модели, виду вызова; неразобранные строки считаются в `skippedLines`. Файлы читаются
  кусками; строка длиннее 4096 байт не копится в памяти, пропускается и тоже считается в `skippedLines`; строка, чей
  `ts` в начале записи вне периода, отбрасывается без разбора (и не считается). Файл больше 32 МБ — 503
  `log_too_large` («Лог расхода TOKEN_LOG_PATH, текущий файл, больше 32 МБ: расход не посчитан. Проверьте ротацию лога
  на сервере (deploy/logrotate).»), а не нули. Файл пропал при ротации (ENOENT при открытии) — считается, что его нет.
  Одновременно идёт один расчёт, остальные ждут; ответ для тех же `from`, `to` и тех же файлов (размер и время
  изменения) 60 с отдаётся из памяти.
- Журнал действий: строки старой панели (`reply`, `reply_duplicate`, `reply_blocked`, `reply_failed`,
  `return_to_bot`, `return_to_bot_failed`, `resume_failed`) с `module: "console-api"`, `user` и `chatId`; отказы,
  которые старая панель не пишет, — `reply_refused`, `reply_rate_limited`, `return_refused`, `return_already_bot`,
  `chat_not_found`, `spend_log_too_large`.
  Отказы проверок — `peer_rejected`, `token_rejected`, `host_rejected`, `proxy_rejected`, `browser_rejected`,
  `user_rejected`. Без текстов, имён, номеров, токена и строки запроса.

#### Примеры

`GET /internal/console/status` → 200

```json
{
  "whatsapp": {"enabled": true, "state": "open", "since": "2026-10-26T10:00:00.000Z"},
  "testMode": true, "allowlistSize": 2, "managerConfigured": true, "companyFeature": true, "llmConfigured": true,
  "apiCalls": {"today": 12, "dailyLimit": 500, "perChatLimit": 100},
  "research24h": {"count": 0, "limit": 10},
  "pairingAttempts24h": 0, "linkedAt": "2026-10-25T10:00:00.000Z", "workingSince": null, "historyIncomplete": false
}
```

При `WA_ENABLED=false`: `"whatsapp": {"enabled": false, "state": "disabled", "since": null}`.

`GET /internal/console/attention` → 200

```json
{
  "handoffs": [{"id": 7, "chatId": 12, "name": "Алия", "phone": "77010000001", "reason": "hot",
    "reasonLabel": "горячий клиент", "level": "hot", "levelLabel": "горячий", "openedAt": "2026-10-26T10:03:00.000Z",
    "notification": {"status": "no_manager", "statusLabel": "номер менеджера не задан, только в панели", "attempts": 1}}],
  "hot": [{"chatId": 12, "name": "Алия", "phone": "77010000001", "status": "manager",
    "levelReason": "Спросил цену после рассказа о складе", "levelUpdatedAt": "2026-10-26T10:02:50.000Z",
    "lastMessageAt": "2026-10-26T10:02:00.000Z"}],
  "waiting": [{"chatId": 12, "name": "Алия", "phone": "77010000001", "status": "manager", "group": "manager",
    "waitingSince": "2026-10-26T10:02:00.000Z", "lastClientAt": "2026-10-26T10:02:00.000Z", "complaint": false}],
  "backlog": {"pending": 0},
  "counts": {"handoffs": {"total": 1, "truncated": false}, "hot": {"total": 1, "truncated": false},
    "waiting": {"total": 1, "truncated": false, "staleExcluded": 0}}
}
```

`GET /internal/console/chats?status=manager&page=1` → 200

```json
{
  "items": [{"id": 12, "name": "Алия", "phone": "77010000001", "phoneHidden": false, "status": "manager",
    "statusBy": "bot", "statusLabel": "Ведёт менеджер (передал бот)", "level": "hot", "levelLabel": "горячий",
    "lastMessageAt": "2026-10-26T10:02:00.000Z", "lastMessage": {"author": "client", "kind": "voice", "text": null},
    "openHandoff": {"reason": "hot", "reasonLabel": "горячий клиент", "level": "hot", "levelLabel": "горячий",
      "openedAt": "2026-10-26T10:03:00.000Z"},
    "company": {"state": "confirmed", "id": 345, "name": "ТОО Склад-Сервис"},
    "waitingSince": "2026-10-26T10:02:00.000Z"}],
  "total": 1, "page": 1, "pages": 1, "pageSize": 30
}
```

`GET /internal/console/chats/12` → 200 (404 `not_found`, если чата нет или ID не число)

```json
{
  "chat": {"id": 12, "name": "Алия", "phone": "77010000001", "phoneHidden": false, "status": "manager",
    "statusBy": "bot", "statusLabel": "Ведёт менеджер (передал бот)", "statusChangedAt": "2026-10-26T10:03:00.000Z",
    "level": "hot", "levelLabel": "горячий", "createdAt": "2026-10-26T09:59:00.000Z", "priceAsks": 1,
    "refusedAnswers": false, "handedOff": true,
    "toldFacts": [{"id": "F4", "label": "ручной сканер"}, {"id": "F6", "label": "интеграция с 1С"}]},
  "profile": {
    "fields": [
      {"key": "business", "label": "Бизнес", "value": "Магазин одежды", "inferred": false},
      {"key": "items", "label": "Вещи", "value": "одежда", "inferred": false},
      {"key": "packaging", "label": "В чём лежат", "value": null, "inferred": false},
      {"key": "material", "label": "Материал", "value": "ткань", "inferred": false},
      {"key": "city", "label": "Город", "value": "Алматы", "inferred": false},
      {"key": "premises", "label": "Помещение", "value": "склад", "inferred": false},
      {"key": "area", "label": "Площадь", "value": null, "inferred": false},
      {"key": "itemCount", "label": "Число вещей", "value": "около 5000", "inferred": false},
      {"key": "turnover", "label": "Как часто движутся", "value": null, "inferred": false},
      {"key": "scope", "label": "Что отмечать", "value": null, "inferred": false},
      {"key": "currentTracking", "label": "Учёт сейчас", "value": null, "inferred": false},
      {"key": "problem", "label": "Что мешает", "value": "пересорт", "inferred": false},
      {"key": "oneC", "label": "1С", "value": "есть, конфигурация не выяснена", "inferred": true},
      {"key": "specifics", "label": "Особенности", "value": null, "inferred": false}
    ],
    "calc": {
      "known": [{"key": "business", "label": "чем занимается клиент", "inferred": false},
        {"key": "items", "label": "что лежит на хранении", "inferred": false},
        {"key": "itemCount", "label": "сколько этого примерно", "inferred": false},
        {"key": "has1C", "label": "есть ли 1С и какая", "inferred": true},
        {"key": "city", "label": "город", "inferred": false}],
      "missing": [{"key": "monthlyIntake", "label": "сколько нового приходит в месяц"},
        {"key": "passages", "label": "сколько проходов нужно учитывать"}]
    },
    "problemAgreed": true,
    "levelReason": "Спрашивает цену, сроки или договор, задача понятна. Клиент: «Так сколько будет стоить?»",
    "updatedAt": "2026-10-26T10:02:50.000Z"
  },
  "note": null,
  "openHandoff": {"reason": "hot", "reasonLabel": "горячий клиент", "level": "hot", "levelLabel": "горячий",
    "openedAt": "2026-10-26T10:03:00.000Z"},
  "handoffs": [{"id": 7, "reason": "hot", "reasonLabel": "горячий клиент", "level": "hot", "levelLabel": "горячий",
    "openedAt": "2026-10-26T10:03:00.000Z", "resolvedAt": null}],
  "lastNotification": {"id": 55, "at": "2026-10-26T10:03:00.000Z", "updatedAt": "2026-10-26T10:03:00.000Z",
    "kind": "handoff", "kindLabel": "передача чата", "status": "no_manager",
    "statusLabel": "номер менеджера не задан, только в панели", "attempts": 1, "chatId": 12,
    "text": "Передача чата: Алия, +77010000001..."},
  "company": {"state": "confirmed", "stateLabel": "подтверждена клиентом", "candidate": null,
    "confirmed": {"id": 345, "name": "ТОО Склад-Сервис", "city": "Алматы", "rubric": "Склады", "emailed": true,
      "pains": [{"pain": "учёт вручную", "evidence": "ведём остатки в Excel", "source": "site", "sourceLabel": "сайт"}]},
    "research": null, "confirmedPains": ["пересорт при приёмке"], "statedName": null,
    "cardUrl": "https://leads.tanbala.kz/companies/345"},
  "rejected": {"items": [{"at": "2026-10-26T10:00:50.000Z", "attempt": 1, "source": "code",
    "sourceLabel": "проверка кодом", "draft": "Понятно. Сколько у вас вещей?",
    "remarks": ["ответ начинается с «Понятно»"]}], "total": 1},
  "messages": {"items": [
    {"id": 101, "author": "client", "authorLabel": "Клиент", "kind": "text",
      "text": "Здравствуйте, нужен учёт на складе", "at": "2026-10-26T10:00:00.000Z"},
    {"id": 102, "author": "bot", "authorLabel": "Бот", "kind": "text",
      "text": "Здравствуйте! Что вы храните на складе?", "at": "2026-10-26T10:01:00.000Z"},
    {"id": 103, "author": "client", "authorLabel": "Клиент", "kind": "voice", "text": null,
      "at": "2026-10-26T10:02:00.000Z"}], "earlierBefore": null}
}
```

Другие виды `company`: кандидат — `"state": "candidate", "stateLabel": "кандидат, клиент не подтвердил",
"candidate": {"id": 7, "name": "ИП Кандидат", "city": null, "source": "phone", "sourceLabel": "по номеру"}`;
не определена — `"unknown"`, «не определена»; функция выключена — `"off"`, «функция выключена»; сводка не прочитана —
`"not_read"`, «данные не прочитаны». Проверка новой компании: `{"status": "running", "label": "идёт", "startedAt":
"…", "finishedAt": null}`, `{"status": "done", "label": "завершена, компания найдена", …}`, `{"status": "failed",
"reason": "not_in_2gis", "label": "не найдена в 2ГИС", …}`.

`GET /internal/console/chats/12/messages?before=103` → 200: `{"items": [{"id": 101, …}, {"id": 102, …}],
"earlierBefore": null}` (по 50, старые сверху; `earlierBefore` — ID для следующего `before`).

`GET /internal/console/notifications?status=no_manager` → 200

```json
{"items": [{"id": 55, "at": "2026-10-26T10:03:00.000Z", "updatedAt": "2026-10-26T10:03:00.000Z", "kind": "handoff",
  "kindLabel": "передача чата", "status": "no_manager", "statusLabel": "номер менеджера не задан, только в панели",
  "attempts": 1, "chatId": 12, "text": "Передача чата: Алия, +77010000001...", "chatName": "Алия"}],
 "total": 1, "page": 1, "pages": 1, "pageSize": 30}
```

`GET /internal/console/company-links?companyId=345` → 200

```json
{"items": [{"chatId": 12, "companyId": 345, "name": "Алия", "phone": "77010000001", "status": "manager",
  "level": "hot", "confirmedAt": "2026-10-26T10:01:30.000Z", "firstClientMessageAt": "2026-10-26T10:00:00.000Z",
  "lastMessageAt": "2026-10-26T10:02:00.000Z"}], "total": 1, "truncated": false}
```

`GET /internal/console/spend?from=2026-10-30&to=2026-10-30` → 200

```json
{"from": "2026-10-30", "to": "2026-10-30", "rows": [
  {"day": "2026-10-30", "provider": "anthropic", "model": "claude-sonnet-5-5", "purpose": "reply", "calls": 1,
   "failed": 0, "input": 3200, "output": 410, "cacheRead": 18000, "cacheWrite": 0},
  {"day": "2026-10-30", "provider": "anthropic", "model": "claude-sonnet-5-5", "purpose": "review", "calls": 1,
   "failed": 1, "input": 2100, "output": 90, "cacheRead": 0, "cacheWrite": 0}], "skippedLines": 0}
```

Лог больше 32 МБ — 503 `{"error": "log_too_large", "message": "Лог расхода TOKEN_LOG_PATH, текущий файл, больше 32 МБ:
расход не посчитан. Проверьте ротацию лога на сервере (deploy/logrotate)."}` (у прошлого файла — «прошлый файл после
ротации (.1)»).

`POST /internal/console/chats/12/reply` с `{"text": "Добрый день"}`: 200 `{"result": "sent"}`; тот же текст в тот же
чат в течение 10 с (из консоли или из старой панели) — 200 `{"result": "duplicate"}`; `{"text": ""}` — 422
`{"error": "refused", "message": "Пустое сообщение не отправляется"}`; сбой отправки после передачи — 502
`{"error": "send_failed", "message": "Не отправлено. Чат уже у менеджера, бот в нём молчит."}`; отказ отправки после
передачи — 422 `{"error": "refused", "message": "Закрытый режим: этот чат не из TEST_ALLOWLIST. Чат уже у менеджера,
бот в нём молчит."}`; 21-й ответ в чат за час — 429 `{"error": "rate_limited", "message": "Из консоли в этот чат уже
отправлено 20 ответов за последний час: подождите или ответьте с телефона."}`.

`POST /internal/console/chats/12/return` с `{"note": "Ответ клиенту: ориентир от X\n\nЗадание боту: узнай 1С"}`: 200
`{"result": "returned", "resumed": 0}` (бот ответит на неотвеченное — `{"result": "returned_answering", "resumed": 2}`);
чат уже у бота — 200 `{"result": "already_bot", "message": "Чат уже ведёт бот: заметка не сохранена."}`; заметка
длиннее 1000 — 422 `{"error": "refused", "message": "Заметка длиннее 1000 символов: сократите её"}`.

Ошибки: без токена на любом пути — 401 `{"error": "unauthorized", "message": "Нет доступа: токен консоли не
передан или неверен."}`; неизвестный путь с токеном — 404 `{"error": "not_found", "message": "Такого адреса в API бота
нет."}`.
