# API консоли для интерфейса (браузер → console)

30.10.2026, этап 2. Только то, что видит страница: `/api/*`, `/healthz`, статика. Как консоль ходит в почту и бота —
`contract/CONSOLE_API.md`. Поля данных почты и бота консоль отдаёт как есть (свежая копия JSON), их точный вид — в
примерах того же контракта («Реализация почты», «Реализация бота»).

## 1. Общие правила

**Адрес.** `https://panel.tanbala.kz` (за Caddy с паролем) или на ПК `http://127.0.0.1:3200`. Другой Host → 403
`bad_host`; домен по HTTP → 403 `https_required`.

**Вход.** Cookie сессии ставит `POST /api/login`: `__Host-tanbala_console` по HTTPS, `tanbala_console` на локальном
HTTP; HttpOnly, SameSite=Strict, 30 дней. Скрипту cookie не видна — fetch шлёт её сам (`credentials: 'same-origin'`).
Сессия живёт 30 дней от входа и 7 дней без активности.

**Изменяющие запросы** (`POST`): тело только JSON (`Content-Type: application/json`, даже пустое — `{}`), заголовок
`Origin` (браузер ставит сам), заголовок `X-CSRF-Token` со значением `csrfToken` из `GET /api/session` или из ответа
входа. Без JSON → 415, чужой Origin → 403 `bad_origin`, неверный токен → 403 `csrf`. Вход и выход токена CSRF не
требуют.

**Фоновые опросы** шлют `X-Console-Poll: 1`: такие запросы не продлевают сессию, и человек, оставивший вкладку
открытой, через 7 дней выйдет. Частота (`POLL_MS` в `web/src/lib/usePoll.ts`), только пока вкладка видна: ход поиска
раз в 2 с, пока поиск идёт; главная, чаты, открытый чат, компании, карточка компании, письма, прошлые запуски
и проверки из WhatsApp раз в 5 с; значки меню на других экранах, уведомления, «Кому писали», «не писать» и состояние
системы раз в 15 с; расход, журнал, пользователи и сессии раз в минуту. Ответ `unavailable` целиком (не в разделе)
после удачного чтения того же адреса не стирает экран: остаются прежние данные со строкой «показаны прежние данные»,
опрос реже, как при сбое сети.

**Ошибки.** Всегда JSON `{"error": "<код>", "message": "<текст по-русски>"}`, иногда с полями сверху. `message`
можно показывать как есть (текстом, не HTML).

| HTTP | `error` | Когда | Что делать странице |
| --- | --- | --- | --- |
| 400 | `bad_request` | неверный id, фильтр, тело; `message` называет поля | показать текст |
| 401 | `invalid_credentials` | только неверное имя или пароль при входе | показать текст |
| 403 | `no_session` | нет сессии, истекла, пользователь отключён | на вход, опросы стоп, набранное не терять |
| 403 | `forbidden` | маршрут не для этой роли | показать текст |
| 403 | `csrf`, `bad_origin` | страница устарела | перечитать `/api/session`, повторить после действия человека |
| 404 | `not_found` | нет чата, письма, компании, адреса | «Чат не найден.» и т. п.; опрос стоп |
| 409 | `conflict` | состояние не позволяет (у 409 запуска ещё `activeRunId`) | показать текст |
| 413 | `too_large` | тело больше 64 КБ (импорт 1.5 МБ) или больше предела приложения (16 КБ) | показать текст |
| 415 | `unsupported_media_type` | не JSON | ошибка кода страницы |
| 422 | `refused` | правило отказало (текст, длина заметки, закрытый режим, WhatsApp не подключён) | показать текст, набранное оставить |
| 429 | `rate_limited`, `busy` | вход: попытки кончились / идут другие проверки; `Retry-After` и `retryAfterSeconds` | показать текст |
| 429 | `budget_exhausted`, `test_limit` | лимиты почты | показать текст |
| 502 | `backend_auth` | почта или бот не приняли токен консоли (ошибка настройки) | «нужна настройка», опросы реже |
| 502 | `send_failed`, `return_failed` | бот не отправил / не вернул (текст говорит, что с чатом) | показать текст, кнопку «Вернуть боту» |
| 502 | `unknown_outcome` | действие ушло, ответа нет: **могло выполниться** | не повторять автоматически; обновить данные |
| 503 | `backend_unavailable` | приложение не запущено, действие **не** выполнено (`source`: `leads`/`wa`) | показать текст, можно повторить |
| 503 | `db_unavailable`, `whatsapp_unavailable`, `not_configured` | отказ приложения у действия | показать текст |

Сетевой сбой или 5xx без JSON — «Нет связи с сервером, пробую снова» с растущей паузой.

**«Недоступно» у чтения.** Если почта или бот не отвечают, чтение отвечает **200**:
`{"unavailable": true, "reason": "unavailable", "source": "wa"|"leads", "message": "Бот не запущен или недоступен."}`.
В составных ответах (главная, карточки) так выглядит отдельный раздел: `{"unavailable": true, "reason":
"unavailable" | "backend_auth"}`, остальные разделы на месте. Бот до привязки по QR не запущен — это обычное
состояние.

**Списки** приложений: `{"items": [...], "total": N, "page": P, "pages": M, "pageSize": S, ...}`, `page` с 1.

**Роли.** `owner` (владелец) и `manager` (менеджер). Ниже «М» — менеджер и владелец, «В» — только владелец.
Роль сервер читает из базы на каждом запросе.

## 2. Маршруты

### Вход

| Метод и путь | Роль | Тело / параметры | Ответ |
| --- | --- | --- | --- |
| `GET /api/session` | М | — | `{"user": {"name", "role"}, "csrfToken"}`; нет сессии → 403 `no_session` |
| `POST /api/login` | открыт | `{"name", "password"}` (имя без учёта регистра) | `{"user": {"name", "role"}, "csrfToken"}` + cookie |
| `POST /api/logout` | открыт | `{}` | `{"result": "logged_out", "message"}`, cookie стёрта |

Ограничение входа: 5 попыток за 10 минут с адреса, 10 за час на имя (адресу, с которого под этим именем уже входили,
окно имени не мешает), одна проверка сразу. Сверх — 429.

### Главная

`GET /api/home` (М) — всё для экрана «Требует внимания»:

```json
{
  "generatedAt": "2026-10-30T06:00:00.000Z",
  "mode": {
    "bot": {"code": "test", "text": "Закрытый режим: бот отвечает только номерам из списка (2)"},
    "leads": {"code": "test_address", "text": "Тестовые письма только на owner@example.kz", "testAddress": "owner@example.kz"},
    "lettersNote": "Компаниям письма не отправляются."
  },
  "botStatus": "<GET status бота> | раздел недоступно",
  "attention": "<attention бота> + handoffs[].seen + newHandoffs | недоступно",
  "leadsSummary": "<summary почты> | недоступно",
  "spend": {
    "day": "2026-10-30", "monthFrom": "2026-10-01", "pricesAsOf": "2026-10-06",
    "bot":   {"today": SpendTotal, "month": SpendTotal} | недоступно,
    "leads": {"today": SpendTotal, "month": SpendTotal} | недоступно,
    "leadsBudget": {"dailyUsd": 1.0 | null, "spentTodayUsd": 0.12, "leftUsd": 0.88 | null, "over": false} | недоступно,
    "botCalls": {"today": 12, "dailyLimit": 500, "left": 488} | недоступно
  },
  "afterLetter": {
    "items": [{"chatId", "companyId", "chatName", "companyName", "firstLetterAt", "firstClientMessageAt", "daysAfter", "seen"}],
    "total": 1, "newCount": 1, "linksTruncated": false,
    "note": "Настоящих отправок писем пока нет; у импортированных писем дата — день импорта…"
  } | недоступно
}
```

- `mode.bot.code`: `unavailable` («Бот не запущен или недоступен»), `disabled`, `disconnected` («WhatsApp не
  подключён»), `test`, `working`. `mode.leads.code`: `unavailable`, `test_address`, `test_off`. Полоса режима — из
  этих текстов плюс `lettersNote`.
- `SpendTotal` = `{"usd": число | null, "tokens", "unpricedTokens", "calls", "notCountedCalls"}`. Деньги бота и почты
  считаются по одной таблице цен почты (`pricesAsOf`). Модель без цены — в `unpricedTokens` («N токенов без цены»).
  `notCountedCalls` — расшифровки голосовых (OpenRouter): «не учтено». `usd: null` — цен нет (почта недоступна).
  Сутки и месяц — по Алматы. Бюджет почты (`leadsBudget`) — её собственный расчёт; красная полоска при `over`.
- «Писали после письма»: первое сообщение клиента в чате с подтверждённой компанией позже первого настоящего письма.
  Сейчас почти пусто (см. `note`). `linksTruncated` — бот отдал 1000 связей, часть могла не попасть.

`POST /api/seen` (М) — отметка «видел»: `{"kind": "handoff" | "after_letter" | "notification", "ids": [1..100 целых]}`
→ `{"result": "seen", "kind", "count"}`. Для передач — id передачи, для «писали после письма» — id чата, для
уведомлений — id уведомления. Отметки свои у каждого пользователя. В журнал действий не пишется.

### Чаты и клиент (бот)

| Метод и путь | Роль | Параметры / тело | Ответ |
| --- | --- | --- | --- |
| `GET /api/chats` | М | `status=bot\|manager`, `level=cold\|warm\|hot`, `company=confirmed\|candidate\|none`, `waiting=1`, `q` (имя или цифры номера, до 64 символов), `page` | список бота (30 на странице) |
| `GET /api/chats/:id` | М | — | карточка чата бота (`chat`, `profile`, `note`, `openHandoff`, `handoffs`, `lastNotification`, `company`, `rejected`, `messages`) |
| `GET /api/chats/:id/messages` | М | `before=<id сообщения>` | `{"items", "earlierBefore"}` |
| `GET /api/clients/:chatId` | М | — | единая карточка, ниже |
| `GET /api/notifications` | М | `status`, `page` | список уведомлений бота, у каждого ещё `seen` |
| `POST /api/chats/:id/reply` | М | `{"text"}` (до 4096) | `{"result": "sent" \| "duplicate", "message"}` |
| `POST /api/chats/:id/return` | М | `{"answer", "task"}` (оба необязательны) | `{"result": "returned" \| "returned_answering" \| "already_bot", "message", "resumed"?}` |

`GET /api/clients/:chatId`:

```json
{
  "chat": "<карточка чата бота, как GET /api/chats/:id>",
  "company": null | {
    "id": 345, "confirmed": true, "label": "подтверждена клиентом" | "не подтверждено",
    "leads": "<карточка компании почты>" | {"notFound": true, "message": "Компании нет в почтовой базе…"} | недоступно
  }
}
```

Компания — подтверждённая клиентом (`chat.company.confirmed.id`); если её нет, а есть кандидат — его карточка с
`confirmed: false` (показывать заметно «не подтверждено»). Блок «что знает бот» — `chat.company`, «данные почты» —
`company.leads`. Чата нет → 404; бот недоступен → 200 `{"unavailable": true, ...}`.

**Ответ клиенту.** Перед вызовом бота консоль проверяет текст (пусто, длиннее 4096 → 422) и состояние связи
WhatsApp: не `open` → 422 «WhatsApp не подключён (…): ответ не отправлен, статус чата не менялся.» (иначе бот сначала
отдал бы чат менеджеру, а потом не смог отправить). Состояние связи для выключенного поля ответа — `botStatus.whatsapp.state`
(`open`, `connecting`, `closed`, `disabled`). Тексты исхода: `sent` «Сообщение отправлено клиенту», `duplicate` «Это
сообщение уже отправлено». 502 `send_failed` — текст бота: «Не отправлено. Чат уже у менеджера, бот в нём молчит.»
(показать кнопку «Вернуть боту») или «Не отправлено. Статус чата не менялся.».

**«Вернуть боту».** Консоль склеивает поля: `Ответ клиенту: <answer>` и `Задание боту: <task>` через пустую строку,
пустые пропускаются, пробелы по краям и `\r\n` убираются. Предел — 1000 символов Unicode у **итоговой** заметки
(эмодзи = 1): счётчик на странице считать так же, по склейке с подписями. Больше → 422 `refused` с `noteLength`.
Тексты исхода: `returned` «Чат возвращён боту», `returned_answering` «Чат возвращён боту: бот ответит на сообщения
клиента без ответа», `already_bot` «Чат уже ведёт бот: заметка не сохранена». 502 `return_failed` — возврат не прошёл.

### Компании, письма, поиск (почта)

| Метод и путь | Роль | Параметры / тело | Ответ |
| --- | --- | --- | --- |
| `GET /api/companies` | М | `status` (9 статусов почты и `no_email` — «Нет почты»), `query` (отрасль, до 60), `run`, `q` (название/рубрика, до 100), `via=whatsapp\|regular`, `wa=1`, `blocked=1`, `letter=1`, `sort=new\|score\|letter`, `page` | список почты (50) с `facets` |
| `GET /api/companies/:id` | М | — | `{"company": <карточка почты>, "chats": {"items": [связи чат→компания]} \| недоступно}` |
| `POST /api/companies/:id/block` | В | `{}` | `{"result": "blocked", "message"}` |
| `POST /api/companies/:id/whatsapp-clear` | В | `{}` | `{"result": "cleared", "wasRequestedVia", "message"}` |
| `GET /api/letters` | М | `status=pending\|approved\|rejected\|all`, `run`, `page` | список почты (100) с `filters` |
| `GET /api/letters/:id` | М | — | письмо целиком (`canApprove`, `canSendTest`, `sendTestBlockedReason`…) |
| `POST /api/letters/:id/approve` | В | `{}` | `{"result": "approved", "message"}` |
| `POST /api/letters/:id/reject` | В | `{}` | `{"result": "rejected", "message"}` |
| `POST /api/letters/:id/edit` | В | `{"subject", "body"}` | `{"result": "saved", "checksTotal", "checksFailed", "message"}` |
| `POST /api/letters/:id/send-test` | В | `{}` | `{"result": "sent", "sentTo", "at", "message": "Тест отправлен на … в ЧЧ:ММ."}` |
| `GET /api/runs` | М | `page` | прошлые запуски (20) с расходом |
| `GET /api/runs/active` | М | — | запуск или `null` |
| `GET /api/runs/:id` | М | — | запуск с этапами (опрос раз в 2 с, пока `finished` false, потом раз в 15 с) |
| `GET /api/search/options` | М | — | города, подсказки, лимиты, `usdPerCompany`, `usdFirstRun` |
| `POST /api/runs` | В | `{"query", "city", "count"}` (отрасли через запятую или с новой строки, до 620; `count` 1–20) | `{"result": "started", "runId", "message"}`; 409 с `activeRunId`; 429 `budget_exhausted` |
| `GET /api/research-jobs` | М | `status`, `page` | проверки из WhatsApp (50) |
| `GET /api/history` | М | `page` | история писем (50) |
| `GET /api/blocked` | М | `page` | «не писать» (50) |
| `POST /api/history/import` | В | `{"kind": "written" \| "refused", "text"?, "fileBase64"?}` (файл до 1 МБ, тело до 1.5 МБ) | `{"result": "imported", "added", "existing", "invalid", "invalidMore", "message"}` |

Тексты действий — как в старом интерфейсе почты: «Письмо одобрено. Компаниям письма пока не отправляются.»,
«Письмо отклонено. Компания вернулась к статусу «Почта проверена».», «Изменения сохранены, проверки пройдены
заново.», «Готово: компания и её домен в списке «не писать». Письма им не уйдут.», «Отметки WhatsApp сняты: …».

Почта принимает тело действия до 16 КБ: правка письма длиннее (около 8 000 символов кириллицы) получает 413 от
консоли до отправки. Подтверждение листом снизу перед каждым опасным действием — дело страницы (`PLAN.md`, раздел 3).

### Система (только владелец)

| Метод и путь | Ответ |
| --- | --- |
| `GET /api/system` | `{"botStatus": <status бота> \| недоступно, "leadsSummary": <summary почты> \| недоступно}` |
| `GET /api/system/spend?from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД` | по умолчанию последние 30 дней, не больше 62: `{"from", "to", "pricesAsOf", "prices", "bot": {"days": [{"day", ...SpendTotal}], "total": SpendTotal} \| недоступно, "leads": то же}` |
| `GET /api/system/audit?page=` | журнал действий, 50 на странице: `items [{"id", "at", "actor", "action", "target", "outcome", "ip"}]` |
| `GET /api/system/users` | `{"items": [{"name", "role", "active", "createdAt", "updatedAt", "sessions"}]}` (только чтение) |
| `GET /api/system/sessions` | `{"items": [{"id", "user", "role", "device", "ip", "createdAt", "lastSeenAt", "current"}]}` |
| `POST /api/system/sessions/:id/revoke` `{}` | `{"result": "revoked", "message": "Сессия закрыта."}`; нет → 404 |
| `POST /api/system/sessions/revoke-all` `{}` | «выйти везде»: закрыть все сессии всех, кроме текущей: `{"result": "revoked", "count", "message"}` |

Журнал: `actor` — имя пользователя, «неизвестное имя» (неудачный вход с несуществующим именем) или «командная
строка»; `action` — `login`, `login_failed`, `logout`, `chat_reply`, `chat_return`, `letter_approve`,
`letter_reject`, `letter_edit`, `letter_send_test`, `company_block`, `company_whatsapp_clear`, `run_start`,
`history_import_written|refused`, `session_revoke`, `session_revoke_all`, `user_add|passwd|role|disable|enable|revoke`;
`target` — `chat:12`, `draft:5`, `company:7`, `session:3`, `user:name`; `outcome` — итог (`sent`, `approved`,
`run:42`…) или код отказа. Хранится 180 дней. Пользователей заводит только команда на сервере (`README.md`).

### Прочее

- `GET /healthz` — только с локальным Host (`127.0.0.1:3200`), без сессии: `{"console": true, "leads": true|false,
  "wa": true|false}`. Снаружи — 404.
- Любой другой `GET` без расширения (`/`, `/chats/12`, `/leads/companies/5`) — `index.html` из `web/dist` без сессии,
  `no-store`. Файлы `/assets/*` — `immutable` (имена с хэшем). Типы файлов — `.html .js .mjs .css .json .webmanifest
  .svg .png .jpg .webp .ico .woff2 .woff .txt`, прочие — 404. Нет `web/dist` — страница-заглушка.
- Неизвестный `/api/...`: без сессии 403 `no_session`, с сессией 404.

## 3. Заголовки ответа

На каждом ответе: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self';
img-src 'self' data:; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self';
object-src 'none'` (никаких inline-скриптов и inline-стилей: в сборке Vite стили отдельными файлами), `nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Permissions-Policy`, COOP и CORP `same-origin`, HSTS по
HTTPS, `Cache-Control: no-store` у данных.
