# VenMart — AI-поиск клиентов для RFID

Oct 22, 2026 · @autevincere

## Цель

На выходе каждый день — таблица казахстанских компаний, которым может быть нужен RFID: проверенная почта, причина «почему им подходит» и готовый черновик письма. Человек одобряет письмо одной кнопкой, после этого оно уходит.

Принцип: собираем из готовых open-source частей, свой код — только «клей» между ними и логика квалификации. Источник компаний — 2ГИС, потому что западные базы (LinkedIn, Apollo) почти не покрывают бизнес Казахстана.

Подробное ТЗ для разработки: ТЗ для Claude Code

## Схема пайплайна

&#91;embedded content: пайплайн поиска клиентов · 8 шагов\]

Компании, которые Claude отсеял на шаге 3, получают статус `rejected` и дальше не идут — так Reacher и Sonnet тратятся только на подходящих. Каждый шаг пишет результат в базу и меняет статус компании, поэтому любой шаг можно перезапустить отдельно.

## Стек и готовые репозитории

Язык — Python: на нём написаны парсер 2ГИС, crawl4ai и официальный SDK Anthropic. Хранилище — PostgreSQL, всё крутится в Docker на одном VPS.

| Шаг | Что берём | Лицензия / условие |
| --- | --- | --- |
| Поиск компаний | [interlark/parser-2gis](https://github.com/interlark/parser-2gis) — поддерживает Казахстан, CSV/XLSX/JSON, `pip install parser-2gis` | Бесплатный, нужен Chrome |
| Запасной источник | [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper) — флаг `-email` сам заходит на сайты | MIT |
| Почты с сайтов | [crawl4ai](https://pypi.org/project/crawl4ai/) + логика из skill [find-emails](https://www.remoteopenclaw.com/skills/lukem121/find-emails): обход страниц «контакты / о нас» | Open source |
| Проверка почт | [reacherhq/check-if-email-exists](https://github.com/reacherhq/check-if-email-exists) — `docker run -p 8080:8080 reacherhq/backend:latest` | AGPL v3, нужен открытый порт 25 |
| AI-квалификация и письма | [Anthropic Python SDK](https://platform.claude.com/docs/en/api/overview) напрямую | Оплата API (см. ниже) |
| Отправка и ответы (позже) | [xyluxx/openoutbound](https://github.com/xyluxx/openoutbound) — REST API, MCP, принимает CSV | Проверить лицензию |
| Одобрение писем | Своя мини-страница или Google Sheets | — |

OpenOutbound на старте не обязателен: первые 2–3 недели письма можно отправлять вручную из почты после одобрения. Так проще понять, какие тексты работают.

## Модель данных

Четыре таблицы в PostgreSQL. У каждой компании есть поле `status` — по нему видно, на каком шаге пайплайна она застряла.

| Таблица | Главные поля | Зачем |
| --- | --- | --- |
| `companies` | id, name, city, rubric, address, phones, website, source\_url, branches\_count, status | Одна строка на компанию. Дедупликация по сайту и телефону |
| `contacts` | company\_id, email, source\_page, verify\_result, is\_catch\_all, is\_role (info@, sales@) | Все найденные почты + результат Reacher |
| `qualifications` | company\_id, fit (yes/no/maybe), score 0–100, reason, segment | Ответ Claude: подходит ли компания под RFID и почему |
| `drafts` | company\_id, contact\_id, subject, body, approved\_by, sent\_at, reply\_status | Черновик письма, одобрение и результат |

Статусы компании по порядку: `new` → `crawled` → `qualified` / `rejected` → `verified` → `drafted` → `approved` → `sent` → `replied`.

## Claude API: оплата и модели

Подписка Max уже включает ежемесячные кредиты на API: $100 на Max 5x и $200 на Max 20x. Ими можно платить за Claude API, Agent SDK, `claude -p` и Managed Agents, но не за Claude Code ([документация](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)).

Как включить:

1. Создать организацию в [Claude Console](https://platform.claude.com/).
2. На claude.ai: Settings → Billing → раздел API credits → привязать эту организацию. Привязка одна, поменять можно только через поддержку.
3. В Console создать API-ключ и отдельный workspace для этого проекта с лимитом расходов.

Правила кредитов: доступны через 7 дней после начала подписки, сгорают в конце месяца без переноса. Когда закончатся, запросы просто остановятся — с подписки ничего не спишется, докупить можно в Console.

Выбор моделей под задачи:

| Задача | Модель | Почему |
| --- | --- | --- |
| Квалификация компании (подходит / нет) | `claude-haiku-5-5` | Много однотипных коротких запросов, важна цена |
| Черновик письма | `claude-sonnet-5-5` | Нужен качественный текст на русском / казахском |

Экономия: квалификацию гонять через Batch API — он на 50% дешевле и подходит для работы, которой не нужен мгновенный ответ. Описание VenMart и инструкции повторяются в каждом запросе — их кэшировать через prompt caching. Ответ квалификации просить строго в JSON, чтобы сразу писать в таблицу `qualifications`.

## План разработки

Первый результат — 50 компаний из одной рубрики в Алматы с письмами, одобренными вручную. Масштабировать только после того, как придут первые ответы.

**Этап 1 — данные**

- [ ] Поставить parser-2gis, выгрузить одну рубрику по Алматы в JSON
- [ ] Поднять PostgreSQL в Docker, создать 4 таблицы, загрузить выгрузку с дедупликацией

**Этап 2 — почты**

- [ ] Скрипт на crawl4ai: обойти сайт компании, собрать почты со страниц «контакты / о нас»
- [ ] Поднять Reacher, прогнать все найденные почты, сохранить результат в `contacts`
- [ ] Проверить, открыт ли исходящий порт 25 у выбранного VPS

**Этап 3 — AI**

- [ ] Подключить API-кредиты Max и получить ключ
- [ ] Промпт квалификации на Haiku: вход — карточка 2ГИС + текст сайта, выход — JSON fit / score / reason / segment
- [ ] Промпт письма на Sonnet: короткое письмо с конкретной причиной из `reason`, без выдуманных фактов

**Этап 4 — одобрение и отправка**

- [ ] Простая страница или Google Sheets: черновик, кнопки «одобрить» / «отклонить» / «править»
- [ ] Отправка одобренных писем с отдельного домена, ручной учёт ответов

**Этап 5 — автоматизация**

- [ ] Запуск пайплайна по расписанию (cron)
- [ ] Подключить OpenOutbound для цепочек follow-up и разбора ответов

## Риски и что проверить

| Риск | Что делать |
| --- | --- |
| Reacher под лицензией AGPL v3: для закрытого коммерческого использования нужна платная лицензия | Для внутреннего инструмента уточнить условия; альтернатива — своя проверка MX + SMTP (пример в [gist irazasyed](https://gist.github.com/irazasyed/02d6530b83c3ba2fe3682caaff4c0222)) |
| Многие VPS закрывают порт 25, многие почтовые серверы блокируют SMTP-проверки | Выбрать хостинг с открытым портом 25, ставить паузы между проверками |
| Домены catch-all принимают почту на любой адрес — SMTP-проверка там бесполезна | Помечать такие почты как «не проверено» и слать на них осторожнее |
| Условия использования площадок: README lead-scraper прямо пишет, что скрапинг Google Maps без входа нарушает условия Google | Правила 2ГИС не проверены — прочитать до запуска |
| Закон РК о рекламных рассылках и персональных данных | Не проверено — уточнить у юриста до массовой отправки |
| Основной домен попадёт в спам | Слать с отдельного домена, настроить SPF / DKIM / DMARC, начинать с малых объёмов |
| AI придумывает факты о компании | Писать письмо только по фактам из карточки 2ГИС и сайта, одобрять вручную |

## Открытые вопросы

- [ ] Целевые сегменты: какие рубрики 2ГИС парсить (магазины одежды, аптеки, склады, логистика, производство?) и с какого числа филиалов компания интересна
- [ ] Язык писем: только русский или ещё казахский
- [ ] Нужен ли второй канал — WhatsApp по телефонам из 2ГИС

## Источники

- [interlark/parser-2gis](https://github.com/interlark/parser-2gis)
- [blind0/2gis-parser](https://github.com/blind0/2gis-parser)
- [gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
- [find-emails skill на crawl4ai](https://www.remoteopenclaw.com/skills/lukem121/find-emails)
- [reacherhq/check-if-email-exists](https://github.com/amaurymartiny/check-if-email-exists)
- [xyluxx/openoutbound](https://github.com/xyluxx/openoutbound)
- [JamesUgbanu/agent-sdr](https://github.com/JamesUgbanu/agent-sdr) — идея «каждый факт в письме со ссылкой на источник»
- [Varun86/lead-scraper](https://github.com/varun86/lead-scraper) — предупреждение про условия Google Maps
- [API-кредиты для Max и Team](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
- [Agent SDK с подпиской Claude](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Почему API оплачивается отдельно от подписки](https://support.claude.com/en/articles/9876003-how-am-i-billed-for-my-enterprise-plan)
