# Источники данных для единой консоли Tanbala (бот WhatsApp и почтовая система)

Все пути указаны от корня `D-Email+WhatsApp/`. Работа шла только на чтение. `.env` я не открывал, значения по умолчанию взяты из кода и `.env.example`.

---

## 1. База бота WhatsApp (SQLite, `whatsapp/data/tanbala.db`)

Общее устройство:
- Таблицы STRICT. Всё время хранится как INTEGER, миллисекунды UTC (`whatsapp/src/db/migrations.ts:4`).
- Режим WAL, `busy_timeout` 5 с (`whatsapp/src/db/connection.ts:17-24`).
- Версия схемы хранится в `PRAGMA user_version`, сейчас 12 (`migrations.ts:279-292`).

**chats** (`migrations.ts:24-42`, дополнения V7 `:204-206` и V8 `:215-217`)
- `id`. Адреса: `reply_jid`, `lid_jid`, `pn_jid` (`:26-28`).
- `phone` (`:29`): цифры из `pn_jid`. У чатов, где есть только адрес `@lid`, поле NULL (`chat-merge.ts:188`).
- `push_name` (`:30`).
- `status`: `bot` или `manager` (`:31`). `status_by`: `bot`, `phone` или `panel` (`:32`). `status_changed_at` (`:33`).
- `interest_level`: `cold`, `warm` или `hot` (`:34`). Каждая оценка перезаписывает уровень (`db/repos/chats.ts:306-308`), так что он может и понизиться. При слиянии чатов остаётся самый горячий (`chat-merge.ts:203-208`).
- `last_inbound_at` (`:35`). **Внимание:** это время записи в базу (`nowMs` при upsert), а не время сообщения. Его же ставит создание чата по нашему собственному сообщению (`chat-merge.ts:193`, `pipeline/recorder.ts:201-210`). Для «неотвеченных» это поле не годится.
- `created_at` (`:36`).
- Ход разговора о цене: `price_asks`, `refused_answers` (`:204-206`).
- Заметка для бота: `bot_note`, `bot_note_at_ms` (`:215-217`).

**messages** (`:44-53`, `answered` в `:78`, индекс `(chat_id, ts_ms)` в `:176`)
- Поля: `chat_id`, `wa_id`, `author` (`client`, `bot`, `human_phone`, `human_panel`; `:48`), `kind` (`text`, `voice`, `other`), `text`, `ts_ms`.
- У голосового без расшифровки `text` равен NULL.
- Откуда берётся `ts_ms`:
  - у сообщений клиента и `human_phone` это время самого WhatsApp (`pipeline/takeover.ts:46`);
  - у `bot` и `human_panel` это `clock.now()` в момент отправки (`messaging/outbox.ts:307-314`, `:340-347`).
- `answered` ставит только конвейер бота (`pipeline/handle-inbound.ts:518-526`). Ответ менеджера с телефона или из панели флаг не меняет. Старая переписка этапа 2 так и осталась с `answered=0` (`migrations.ts:69-70`).
- Фраза бота о передаче менеджеру записывается как обычное сообщение `author='bot'`. Отличить её можно только через `outbound_ids.origin='handoff_notice'` (так делает `db/repos/messages.ts:165-192`).

**outbound_ids** (`:80-92`): `wa_id`, `chat_id`, `origin` (`bot_reply`, `handoff_notice`, `voice_notice`, `manager_notify`, `panel`), `text`, `status` (`pending`, `sent`, `failed`), `created_at`.

**handoffs** (`:135-149`)
- `id`, `chat_id`.
- `reason` (`:138-140`): `hot`, `no_answer`, `check_failed`, `asked_human`, `complaint`, `human_took_over`, `llm_error`, `limit`.
- `level`: уровень интереса на момент передачи.
- `snapshot`: JSON выжимки ClientProfile на момент передачи (`handoff/handoff.ts:203-205`).
- `opened_at_ms`, `resolved_at_ms`. NULL в `resolved_at_ms` значит, что передача открыта.
- Закрывает передачу только кнопка «Вернуть боту» в панели (`db/repos/handoffs.ts:42-45`).
- Открытая передача на чат одна (`:149`).
- **Отметки «менеджер видел» нет.**

**manager_notifications** (`:151-168`)
- `kind`: `handoff`, `limit` или `backlog`.
- `chat_id`: NULL только у `backlog`.
- `text`: полный текст уведомления.
- `status`: `pending`, `sent`, `no_manager`, `skipped_limit` или `failed`.
- Также `wa_id`, `attempts`, `created_at_ms`, `updated_at_ms`.
- Повторов не больше 5 (`handoff/notifier.ts:13`). Статусы `no_manager` и `skipped_limit` не повторяются.
- **Ссылки на `handoff_id` нет.**

**client_profiles** (`:108-119`, V7 `:201-203`, V11 `:258-264`, V12 `:272`)
- Поля выжимки: `business`, `items`, `packaging`, `material`, `city`, `premises`, `area`, `scope`, `item_count`, `turnover`, `current_tracking`, `has_1c`, `one_c_name`, `problem`, `specifics`, `problem_agreed`.
- `inferred`: JSON-список полей, выведенных «вероятно».
- `reason`: почему модель выбрала этот уровень интереса.
- `updated_at_ms`: время последней оценки.

**rejected_drafts** (`:238-249`): `chat_id`, `attempt` (1 или 2), `source` (`code` или `review`), `draft`, `remarks` (JSON-массив замечаний), `at_ms`. Хранятся 30 дней (`pipeline/services.ts:28`, `:212`).

**chat_companies** (`:186-190`): `chat_id`, `state` (JSON, подробно в разделе 4), `updated_at`.

**api_usage** (`:94-99`)
- `day`: дата по Алматы `ГГГГ-ММ-ДД`.
- `chat_id`: 0 значит общий счётчик бота.
- `count`: **число вызовов, не токены и не деньги.**

Остальные таблицы:
- **backlog_chats** (`:55-59`): `chat_id`, `marked_at_ms`, `notified_at_ms`. Чаты с сообщениями, пришедшими за время простоя.
- **known_chats** (`:61-65`, `:227-228`): `jid`, `last_activity_ms`, `source`, `held_for_manager`.
- **app_state** (`:14-17`): ключи `linked_at_ms`, `history_incomplete_at_ms`, `working_since_ms` (`db/repos/app-state.ts:6-12`).

Вне базы лежит лог расхода `TOKEN_LOG_PATH`, по умолчанию `./data/token-usage.jsonl` (`src/config/env.ts:111`, `:295`).

---

## 2. База почтовой системы (Postgres)

Схема описана в коде: `leads/tanbala_leads/db.py`, миграции 1–7 (`db.py:346-354`), применённые лежат в `schema_migrations`. Время хранится как `timestamptz`.

**companies** (`db.py:47-68`, плюс `:226`, `:260`, `:285`, `:343`)
- `id`, `name`, `city`, `rubric`, `address`.
- `phones text[]`: в формате 2ГИС, например `+7727…`.
- `website`, `website_domain`, `source`, `source_id`, `source_url`, `branches_count`, `raw`, `site_text`.
- `status` (`:62-64`): от `new` до `sent` и `replied`. Статус `replied` никто не ставит.
- `last_error`, `created_at`, `updated_at`, `run_id`, `search_query`.
- `requested_via = 'whatsapp'`: компанию создала проверка по запросу бота. Триггеры запрещают ей черновики и письма (`:288-316`).
- `whatsapp_contacted_at` (`:340-343`): дата **первого запроса справки ботом после ответа клиента «да, это мы»**.
  - Ставит `internal/brief.py:53-56`, вызов в `web/internal.py:160-168`.
  - Снимает кнопка «чужая компания» вместе с `requested_via` (`brief.py:59-66`).

**contacts** (`:77-90`): `company_id`, `email`, `source_page`, `verify_result` (`safe`, `risky`, `invalid`, `unknown`; NULL значит «не проверяли»), `verify_raw` (сырой ответ Reacher), `is_catch_all`, `is_role`, `verified_at`.

**qualifications** (`:94-104`, `pains` в `:251`)
- Оценка: `fit` (`yes`, `no`, `maybe`), `score` от 0 до 100, `reason`, `segment`, `model`, `created_at`.
- `pains` jsonb, элементы вида `{pain, evidence, source: 2gis|site, verified}`.
- Действует последняя строка по компании (`web/queries.py:206-209`).

**drafts** (`:107-134`)
- `company_id`, `contact_id`, `kind` (`first_email` или `reply`), `subject`, `body`, `model`.
- `check_result` jsonb: результаты проверок черновика.
- `review_status` (`pending`, `approved`, `rejected`), `approved_by`, `approved_at`.
- `sent_at`: **сейчас всегда NULL.** Настоящей отправки нет, `send_draft` всегда отказывает (`steps/send.py:1-9`, `:136`).
- `reply_status`: не используется.
- `created_at`, `updated_at`.

**contact_history** (`:140-160`, `source` в `:254-255`)
- `company_id`, `email`, `domain` (вычисляемое), `direction` (`out` или `in`), `kind`, `draft_id`, `subject`, `note`, `occurred_at`, `source` (`pipeline`, `import` или `manual`).
- **Внимание:** `record_message` не принимает время (`contact_policy.py:89-97`). Поэтому у импортированных писем `occurred_at` равен **моменту импорта, а не дате письма**. Темы у импорта тоже нет (`contract/INTERNAL_API.md:130`).
- Записи `direction='in'` и `source='manual'` сейчас никто не пишет: разбор ответов пока заглушки (`steps/replies.py`).

**do_not_contact** (`:165-177`, триггер `:181-198`): ровно одна цель из `email`, `domain`, `company_id`. Также `reason` (`refused`, `complaint`, `bounce`, `manual`), `note`, `created_at`.

**test_sends** (`:269-279`): `draft_id`, `sent_to` (только адрес владельца), `real_to`, `status` (`sent` или `failed`), `message_id`, `error`, `created_at`. Письмом компании не считаются.

**runs** (`:203-224`, `stage_detail` в `:262`)
- `city`, `query` (отрасли через запятую), `max_companies` (на одну отрасль).
- `status` (`queued`, `running`, `done`, `failed`), `stage`, `stage_detail`.
- Счётчики: `found`, `new_companies`, `crawled`, `qualified`, `rejected`, `verified`, `drafted`, `errors`.
- `error`, `created_at`, `started_at`, `finished_at`.
- Активный запуск одновременно только один (`:224`).

**llm_calls** (`:230-244`)
- `task`, `model` (в том виде, как вернул API).
- `run_id`: NULL у проверок по запросу бота. `company_id`.
- Токены: `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`. Также `stop_reason`, `created_at`.
- Индексы только по `run_id` и `company_id`, **по `created_at` индекса нет.**

**research_jobs** (`:319-336`)
- `id uuid`, `name`, `city` (код 2ГИС), `phone`, `domain`: то, что прислал бот. Телефон клиента бот присылает только у бизнес-аккаунта (`whatsapp/src/company/research.ts:218-219`).
- `status` (`queued`, `running`, `done`, `failed`), `reason` (`not_in_2gis`, `city_unsupported`, `budget_exhausted`, `error`), `company_id`.
- `error`: подробности, наружу не отдаются.
- `created_at`, `started_at`, `finished_at`.
- **Поля `chat_id` нет.**
- Отказ по лимиту при запуске (ответ 429) строку не создаёт (`internal/research.py:159-162`).

---

## 3. Пункты главного экрана

Про часовой пояс в целом:
- В боте всё в мс UTC. Сутки по Алматы считаются как фиксированный сдвиг UTC+5 (`db/repos/call-budget.ts:9-10`, `:70-72`; `panel/format.ts:13`, `:63`). Начало суток по Алматы = 19:00 UTC предыдущего дня.
- Почтовая система использует `'Asia/Almaty'` внутри Postgres (`pipeline.py:55`, `research.py:38`, `send.py:31`).

### 3.1 Новые передачи менеджеру
Данные: бот.

```sql
SELECT h.id, h.chat_id, h.reason, h.level, h.opened_at_ms, h.snapshot,
       c.push_name, c.phone, c.status_by,
       (SELECT n.status FROM manager_notifications n
         WHERE n.chat_id = h.chat_id AND n.kind IN ('handoff','limit')
           AND n.created_at_ms >= h.opened_at_ms
         ORDER BY n.created_at_ms, n.id LIMIT 1) AS notify_status
FROM handoffs h JOIN chats c ON c.id = h.chat_id
WHERE h.resolved_at_ms IS NULL AND h.reason <> 'human_took_over'
ORDER BY h.opened_at_ms DESC;
```

- Уведомление пишется после записи передачи (`handoff/handoff.ts:171-186`), поэтому условие `created_at_ms >= opened_at_ms` верное.
- Если `notify_status` равен `no_manager`, `skipped_limit` или `failed`, менеджер о передаче не узнал. Такую передачу стоит выделить отдельно.
- Время `opened_at_ms` хранится в UTC, показывать нужно в UTC+5.

Чего не хватает:
- Нет отметки «просмотрено», поэтому «новые» сейчас можно определить только по времени, например за последние 24 часа. Небольшая добавка: колонка `handoffs.seen_at_ms` (миграция V13) или своя таблица консоли.
- Нет `handoff_id` в `manager_notifications`, связь только по чату и времени.
- Чаты, отданные менеджеру при переходе в рабочий режим (`status='manager'`, `by='phone'`; `pipeline/working-mode.ts:69`, `recorder.ts:226`, `:278`), строки в `handoffs` не имеют. Это не передача от бота, но такие чаты у менеджера.

### 3.2 Горячие клиенты
Данные: бот.

```sql
SELECT c.id, c.push_name, c.phone, c.status, p.reason, p.updated_at_ms,
       (SELECT max(ts_ms) FROM messages m WHERE m.chat_id = c.id) AS last_msg_ms
FROM chats c LEFT JOIN client_profiles p ON p.chat_id = c.id
WHERE c.interest_level = 'hot'
ORDER BY last_msg_ms DESC;
```

- Дополнительно можно показать историю `handoffs.reason='hot'` с полем `opened_at_ms`.
- Можно обогатить данными почты через связь из раздела 4: `qualifications.fit` и `score` подтверждённой компании.

Ограничения:
- Пока чат у менеджера, бот не оценивает интерес, и уровень замирает.
- Не хранится время, когда клиент стал горячим. Есть только время последней оценки `client_profiles.updated_at_ms`. Небольшая добавка: `chats.level_changed_at_ms`.

### 3.3 Неотвеченные клиенты
Данные: бот. Определение строится по времени сообщений. Флаг `answered` и поле `last_inbound_at` для этого не годятся (см. раздел 1).

Две группы:
- **«Ждёт человека»**: `status='manager'`, и последнее сообщение клиента позже последнего сообщения `human_phone` или `human_panel`. Фраза бота о передаче ответом **не считается**: клиент написал, бот передал чат, человек ещё не ответил. Это и есть «неотвеченный».
- **«Бот молчит»**: `status='bot'`, последнее сообщение в чате от клиента, и оно старше примерно 5 минут. Для сравнения: пачка сообщений собирается 4–15 секунд (`pipeline/responder-setup.ts:31-32`), ответ модели ждётся до 60 секунд (`llm/anthropic.ts:50`). Значит, произошёл сбой, сработала квота или ответ упёрся в границу рабочего режима.

```sql
WITH lc AS (SELECT chat_id, max(ts_ms) at FROM messages WHERE author='client' GROUP BY chat_id),
     lh AS (SELECT chat_id, max(ts_ms) at FROM messages WHERE author IN ('human_phone','human_panel') GROUP BY chat_id),
     lo AS (SELECT chat_id, max(ts_ms) at FROM messages WHERE author <> 'client' GROUP BY chat_id)
SELECT c.id, c.push_name, c.phone, c.status, lc.at AS last_client_ms,
       (SELECT min(ts_ms) FROM messages m WHERE m.chat_id=c.id AND m.author='client'
          AND m.ts_ms > coalesce(CASE WHEN c.status='manager' THEN lh.at ELSE lo.at END, 0)) AS waiting_since_ms
FROM chats c JOIN lc ON lc.chat_id=c.id
LEFT JOIN lh ON lh.chat_id=c.id LEFT JOIN lo ON lo.chat_id=c.id
WHERE (c.status='manager' AND lc.at > coalesce(lh.at,0))
   OR (c.status='bot' AND lc.at > coalesce(lo.at,0) AND lc.at < :now_ms - 300000);
```

Особые случаи:
- Если последняя передача в чате имеет причину `complaint` (клиент жаловался или просил больше не писать), такой чат лучше показывать отдельной пометкой.
- В закрытом режиме (TEST_MODE) чаты не из списка разрешённых в базу не попадают. Видна только запись `known_chats.last_activity_ms`.

### 3.4 Писали в WhatsApp после нашего письма
Данные: обе базы. Письмо знает почтовая система, переписку знает бот.

Нужное определение: **первое сохранённое сообщение клиента в чате, подтверждённо связанном с компанией, пришло позже первого настоящего исходящего письма этой компании.** Тестовые отправки не считаются.

Шаг 1, бот:
```sql
SELECT c.id chat_id, json_extract(cc.state,'$.confirmed.id') company_id,
       json_extract(cc.state,'$.confirmed.confirmedAtMs') confirmed_at_ms,
       (SELECT min(ts_ms) FROM messages m WHERE m.chat_id=c.id AND m.author='client') first_client_ms
FROM chats c JOIN chat_companies cc ON cc.chat_id=c.id
WHERE CASE WHEN json_valid(cc.state) THEN json_type(cc.state,'$.confirmed.id')='integer' ELSE 0 END;
```

Шаг 2, почтовая система. Письма сопоставляются с компанией так же, как в `internal/lookup.py:41-52`:
```sql
SELECT c.id, min(h.occurred_at) first_letter_at, max(h.occurred_at) last_letter_at, array_agg(DISTINCT h.source) sources
FROM companies c JOIN contact_history h ON h.direction='out' AND (
     h.company_id=c.id OR h.email IN (SELECT email FROM contacts WHERE company_id=c.id)
  OR h.domain=c.website_domain
  OR (h.domain IN (SELECT split_part(email,'@',2) FROM contacts WHERE company_id=c.id)
      AND NOT h.domain = ANY(%(free_mail)s)))
WHERE c.id = ANY(%(ids)s) GROUP BY c.id;
```

Условие: `first_client_ms > first_letter_at` (в мс эпохи). Можно показывать, через сколько дней после письма клиент написал.

Упрощённый вариант только по почтовой базе: `companies.whatsapp_contacted_at > first_letter_at`. Он грубее:
- отметка ставится при запросе справки после «да, это мы», то есть позже первого сообщения клиента;
- она есть только у подтверждённых компаний;
- её снимает кнопка «чужая компания».

Чего не хватает:
- Настоящих отправок пока нет: `drafts.sent_at` всегда NULL. Сейчас в выборку попадёт только импорт писем владельца, и **дата у него — день импорта**. Нужна добавка: дата письма при импорте (параметр `occurred_at` в `record_message`).
- Бот знает только флаг `emailed` из справки, без даты: `emailedAt` в базу не пишется (`db/repos/chat-companies.ts:67-74`).
- Сообщения, пришедшие до привязки бота или из чатов вне списка разрешённых в TEST_MODE, не сохранены. Первое сохранённое сообщение может быть позже настоящего первого контакта.

### 3.5 Что идёт сейчас
Данные: почтовая система. Кроме проверок новых компаний: их запрашивает бот.

**Поиск компаний.**
```sql
SELECT id, city, query, max_companies, status, stage, stage_detail, found, new_companies, crawled, qualified,
       rejected, verified, drafted, errors, started_at
FROM runs WHERE status IN ('queued','running') ORDER BY id DESC LIMIT 1;
```
(`web/queries.py:125-126`)
- Цель запуска = `max_companies` × число отраслей (`pipeline.py:288`, `:301`).
- Этапы: «Подготовка», «Поиск в 2ГИС», «Сайты», «Квалификация», «Проверка почт», «Письма», «Готово» (`pipeline.py:287-400`).
- Запуск, «зависший» после перезапуска приложения, получает статус failed при старте (`pipeline.py:156-162`).

**Проверки новых компаний (research).**
```sql
SELECT id, name, city, status, created_at, started_at FROM research_jobs
WHERE status IN ('queued','running') ORDER BY created_at;
```
- Связь с чатом есть только у бота, и только пока проверка идёт: `chat_companies.state.$.research.jobId = research_jobs.id`.
- После завершения бот хранит только `$.research.companyId` (`chat-companies.ts:108-121`), так что связь задачи с чатом пропадает.
- Бот ждёт проверку не дольше 15 минут (`whatsapp/src/company/research.ts:24`).

**Проверки почт.** Отдельной очереди нет: они идут только внутри запуска, на этапе `stage='Проверка почт'`, прогресс в счётчике `runs.verified`.
- Ждут проверки: `SELECT count(*) FROM contacts ct JOIN companies c ON c.id=ct.company_id WHERE ct.verify_result IS NULL AND c.status='qualified'`.
- Проверено сегодня: условие `contacts.verified_at >= начало суток по Алматы`.
- Сбой самого Reacher не сохраняется (`steps/verify.py:79-82`). Он виден только косвенно: в `companies.last_error` и в счётчике `runs.errors`, и только если сбой был по всем адресам компании (`verify.py:93-94`, `pipeline.py:231-235`).

У бота пачки сообщений живут в памяти и в базе не видны. Видно только `backlog_chats` с `notified_at_ms IS NULL`.

### 3.6 Расход Claude API за день и месяц
Подробно в разделе 5. Коротко:
- у почты есть таблица с токенами, и сумма считается одним SQL;
- у бота доллары в базе не хранятся, есть только лог в файле `token-usage.jsonl`;
- общего денежного лимита на оба проекта нет.

---

## 4. Связь чата с компанией

Что хранит бот: id компании из почтовой базы лежит внутри JSON в `chat_companies.state` (схема в `db/repos/chat-companies.ts:79-141`, типы в `domain/company.ts:131-229`).

| Путь в JSON | Что значит |
|---|---|
| `$.confirmed.id` | Клиент сказал «да, это мы» (`company/transitions.ts:77-92`). Рядом лежат `name`, `city`, `confirmedAtMs`. В `brief` хранятся `id`, `name`, `city`, `rubric`, `pains` и `emailed` на момент справки, плюс `briefAtMs`. Если API было недоступно, `brief` равен null. |
| `$.candidate.id` | Компания найдена, но клиент её **не подтвердил**. Рядом `source` (`profile_domain`, `phone`, `profile_name`, `message`, `logo`, `research`), `askedAtMs`, `awaitingAnswer`. |
| `$.rejectedIds[]` | Клиент ответил «нет, это не мы» (`transitions.ts:98-111`). |
| `$.research.jobId` | Связь с `research_jobs.id`, пока проверка в статусе `queued` или `running`. |
| `$.research.companyId` | Проверка завершилась (`done`). |
| `$.statedName`, `$.statedCity`, `$.profileDomain` | Что клиент сказал сам и домен из бизнес-профиля. |

Обратной связи в почтовой базе нет: ни `chat_id`, ни телефона клиента. Есть только `whatsapp_contacted_at` и `requested_via`.

Как консоли их соединить:
1. Основной ключ: `json_extract(state,'$.confirmed.id') = companies.id`. Базы разные, поэтому соединять нужно в коде консоли, без общего SQL. Неверный JSON надо обходить через `CASE WHEN json_valid(...)`, как в `chat-companies.ts:190-198`.
2. Кандидат (`$.candidate.id`) показывать только с пометкой «не подтверждено».
3. Запасной поиск без связи от бота:
   - `chats.phone` (формат `7XXXXXXXXXX`) против `companies.phones` с той же нормализацией, что в `lookup.py:30-37`;
   - `$.profileDomain` против `website_domain` и доменов почт (`lookup.py:20-27`).
   Автоматически связывать только при однозначном совпадении, по правилу `company/pick-candidate.ts:18-29`.
4. От карточки компании к чатам: придётся просматривать все строки `chat_companies` в JSON. Для сотен чатов это нормально. Небольшая добавка: колонка `confirmed_company_id INTEGER` с индексом, которую заполняет `save()`.
5. Ссылка на карточку компании: `EMAIL_UI_URL/companies/{id}` (`company/summary.ts:22-25`).

Особые случаи:
- **Кандидат не подтверждён.** Для «писали после письма» он не годится. Брифа нет, `whatsapp_contacted_at` не поставлен.
- **Подтверждена, но `brief` пуст.** API было недоступно, `whatsapp_contacted_at` ещё нет. После трёх постоянных сбоев справку больше не запрашивают (`company/brief.ts:8-28`).
- **Компания удалена из почтовой базы.** Сам код компании не удаляет. Удалить её при наличии истории писем нельзя (`ON DELETE RESTRICT`), `llm_calls` и `research_jobs` получат NULL. Консоли нужен LEFT JOIN с пометкой «удалена», данные можно брать из сохранённого у бота `brief`.
- **Нажата кнопка «чужая компания»** (`brief.py:59-66`). У бота подтверждение остаётся, `brief` уже сохранён, повторного запроса справки не будет, и отметка не вернётся. Консоль должна показать это расхождение.
- **Слияние чатов** (`db/repos/chat-merge.ts:135-151`). id поглощённого чата исчезает, состояние компании переходит к оставшемуся (`company-state-merge.ts`). Старые `chatId` в `token-usage.jsonl` ни на что не указывают.
- **Чат без компании, функция выключена или JSON испорчен.** Сводка `unknown` или `off`, показать `statedName`. Испорченная запись читается как пустое состояние (`chat-companies.ts:200-208`).
- **Несколько чатов на одну компанию** (сотрудники одной фирмы): связь «многие к одному».
- **`brief` у бота — снимок на момент справки.** Боли и «писали» нужно брать свежими из Postgres.

Ограничение доступа на сервере: сервисы работают под разными пользователями `tanbala-wa` и `tanbala-leads` с `ProtectSystem=strict` (`deploy/systemd/tanbala-*.service:18-19`, `:51-64`).
- База SQLite получает права 600 (`tanbala-whatsapp.service:26`), логи расхода создаются с правами 0600 (`deploy/logrotate/tanbala:12`, `:23`).
- Консоль под другим пользователем ничего из этого не прочтёт. Чтобы читать базу в режиме WAL, нужен доступ ещё и к файлам `-wal` и `-shm`.
- Варианты: выдать права группе или сделать в каждом проекте маленькие эндпоинты только для чтения на 127.0.0.1 с токеном, по образцу `leads/tanbala_leads/web/internal.py`.

---

## 5. Расход API

### Бот
- **Каждый вызов** пишется строкой JSON в `TOKEN_LOG_PATH`. На сервере это `/opt/tanbala/whatsapp/data/token-usage.jsonl`.
- Формат (`llm/token-log.ts:25-37`, `domain/types.ts:483-511`):
  `{"ts":"ISO UTC","provider":"anthropic|openrouter","purpose":"reply|review|interest|logo|transcribe","model","input","output","cacheRead","cacheWrite","chatId","ok"}`.
- Неудачные вызовы тоже пишутся, с нулями (`llm/anthropic.ts:53`, `:240-256`).
- Модели (`whatsapp/config/models.json`): `reply`, `review` и `interest` на claude-sonnet-5-5, `logo` на claude-haiku-5-5.
- **В долларах бот ничего не считает.** У OpenRouter (расшифровка голосовых) токенов почти нет, а настоящая цена `usage.cost` уходит только в лог приложения, то есть journald (`voice/transcriber.ts:222-238`).
- Таблица `api_usage` даёт только число попыток за сутки по Алматы. Попытка засчитывается до отправки, включая неудачные; строка `chat_id=0` — общий счётчик (`call-budget.ts:43-51`).

### Почта
- Каждый ответ модели записывается в `llm_calls` (`llm.py:161-162` → `pipeline.py:244-257` → `llm.py:185-192`).
- Тот же вызов дублируется в `LLM_LOG_PATH`, по умолчанию `logs/llm_calls.jsonl` (`settings.py:17`, `:37`; `llm.py:175-182`).
- Не записываются вызовы, упавшие исключением без ответа, и внутренние повторы SDK (`max_retries=2`, `llm.py:23`, `:87-88`).
- Модели задачи берут из `config/models.yaml`, везде haiku.

### Цены и формула
- Таблица цен есть только у почтовой системы, «примерно на 06.10.2026» (`llm.py:25-29`): Haiku 5.5 и Sonnet 5.5, то есть обе модели бота.
- Формула (`llm.py:91-99`): `(input·in + output·out + cache_read·cr + cache_write·cw) / 1e6`. В обоих проектах «input» — это токены без кэша, так что считать можно одинаково.
- Модель без цены два места считают по-разному:
  - `spent_today_usd` берёт самую дорогую известную цену (`pipeline.py:60-68`);
  - `cost_from_rows` откладывает такие токены в «без цены» (`web/format.py:57-69`).
  
  Консоли нужно выбрать одно правило.

### Как дёшево посчитать день и месяц
- **Почта, день**: готовый `SPENT_TODAY_SQL` (`pipeline.py:52-57`).
- **Почта, месяц**: тот же запрос с `date_trunc('month', now() AT TIME ZONE 'Asia/Almaty') AT TIME ZONE 'Asia/Almaty'`. Пока таблица маленькая, хватит и так. Небольшая добавка: индекс `llm_calls (created_at)`.
- **Бот**: только чтением файла.
  - При полном дневном лимите файл растёт примерно на 100 КБ в сутки (`whatsapp/docs/DEPLOY.md:300`), за месяц выходит до 3 МБ.
  - Ротация раз в месяц со сжатием на шаг позже (`deploy/logrotate/tanbala:15-24`). Записи за первые часы нового месяца, до ротации, лежат в несжатом `.1`. Сумма за месяц = текущий файл + строки из `.1` с `ts` не раньше начала месяца по Алматы, то есть 19:00 UTC последнего дня прошлого месяца.
  - Дёшево: кэшировать позицию в файле и дочитывать только новые строки.
  - Правильнее (небольшая добавка): таблица `api_calls` в SQLite с теми же полями и индексом по времени, писать в неё рядом с jsonl. Туда же записывать `costUsd` расшифровки.

### Дневные лимиты для экрана (остаток)

| Лимит | Где хранится | Как посчитать |
|---|---|---|
| `API_DAILY_LIMIT`, по умолчанию 500 вызовов бота в сутки (`env.ts:112`) | `api_usage` | `SELECT count FROM api_usage WHERE day=:today_almaty AND chat_id=0` |
| `API_DAILY_LIMIT_PER_CHAT`, по умолчанию 100 | `api_usage` | самые расходные чаты: `chat_id>0 ORDER BY count DESC` |
| Проверки новых компаний со стороны бота: 10 за скользящие 24 часа (`company/research.ts:27-32`, `:246-247`) | `chat_companies` | запрос как в `chat-companies.ts:190-198` с `sinceMs = now − 24 ч` |
| `DAILY_API_BUDGET_USD`, по умолчанию 1.00 (`settings.py:38`). **Учитывает только почту.** Блокирует новые поиски и проверки (`pipeline.py:103-109`; `research.py:161-162`, `:258-260`) | `llm_calls` | бюджет − `spent_today_usd` |
| `RESEARCH_PER_DAY`, по умолчанию 20, сутки по Алматы, без `city_unsupported` (`research.py:36-40`) | `research_jobs` | `TODAY_JOBS_SQL` |
| Тестовые отправки: 30 в сутки (`send.py:24`, `:28-32`) | `test_sends` | `TODAY_SENDS_SQL` |

Сами числа лимитов лежат в `.env` каждого проекта. Это не секреты, но консоли нужна их копия или эндпоинт, который их отдаёт.

Сверка часовых поясов: бот считает сутки фиксированным UTC+5, а Postgres через `'Asia/Almaty'`. Это совпадает, только если в образе `postgres:17-alpine` база часовых поясов не старше версии 2024a. Проверить один раз: `SELECT (now() AT TIME ZONE 'Asia/Almaty') - (now() AT TIME ZONE 'UTC')` должно вернуть 05:00. Либо в консоли везде использовать фиксированное `+05`.

---

## 6. Что хранится, но не показывает ни один интерфейс

**Бот** (панель показывает только открытую передачу, последнее уведомление, заметку, отклонённые черновики и сводку о компании; `panel/chat-model.ts:31-54`):
- **История передач:** закрытые передачи, их причины, уровень и снимок выжимки (`handoffs.snapshot`).
- Ход разговора о цене: `price_asks`, `refused_answers`.
- Почему модель поставила такой уровень и когда: `client_profiles.reason`, `updated_at_ms`.
- Счётчики `api_usage`: всего и по чатам. Весь лог `token-usage.jsonl`, который сейчас смотрят только через `tail` по SSH (`DEPLOY.md:300`).
- Цена расшифровок OpenRouter: есть только в journald.
- Неудачные и зависшие отправки клиенту: `outbound_ids.status IN ('failed','pending')`.
- Чаты простоя (`backlog_chats`) и отметка `known_chats.held_for_manager`.
- Подробности поиска компании: `rejectedIds`, `profileKind`, `profileDomain`, `briefFailures`, `adoptFailures`, `candidate.askedAtMs`, `awaitingAnswer`, `confirmedAtMs`, `briefAtMs`.
- Служебное: `app_state` (`linked_at_ms`, `working_since_ms`, `history_incomplete_at_ms`).

**Почта:**
- **Таблица `research_jobs` целиком.** В интерфейсе её нет: какие компании запросил бот, причины неудач, ошибки, сколько проверок сделано за день из `RESEARCH_PER_DAY`.
- Разбивка `llm_calls` по задачам и моделям и расход за месяц. Сейчас видны только итог, сегодняшний день, отдельный запуск и отдельная компания.
- Подробности проверки почт: `contacts.verify_raw` (ошибка SMTP от Reacher) и `verified_at`.
- История оценок компании: показывается только последняя `qualifications`. Черновики по компании: только последний.

**Связь двух систем:**
- Черновик письма зовёт клиента в WhatsApp (`steps/draft.py:51`, `:146-147`), но ни один интерфейс не показывает, что чат пришёл после письма.
- Почтовая система не знает, в каком чате клиент и что он там говорил. Бот не знает дату письма.