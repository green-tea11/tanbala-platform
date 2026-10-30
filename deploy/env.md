# Настройки на сервере

Здесь только названия переменных и несекретные значения (адреса, пути). Секреты владелец переносит сам: `.env` из
`leads/` и `whatsapp/` на ПК. `.env` консоли на ПК не берётся: он собирается на сервере, токены консоли создаются
там же (раздел «Токены консоли»). Образцы со всеми переменными: `leads/.env.example`, `whatsapp/.env.example`,
`console/.env.example`.

## Перенос `.env` с ПК

scp кладёт файл с правами 644, поэтому сначала в домашнюю папку `ubuntu`, потом на место, копия в домашней папке
стирается. `.env` почты принадлежит root и группе службы (640): служба его только читает, а root берёт из него
`compose.env`. `.env` бота принадлежит самому боту (600), как и вся его папка:

```powershell
# ПК, PowerShell, из папки D-Email+WhatsApp
scp .\leads\.env ubuntu@91.201.215.210:~/leads.env
scp .\whatsapp\.env ubuntu@91.201.215.210:~/whatsapp.env
```

```bash
# сервер
sudo install -m 640 -o root -g tanbala-leads ~/leads.env /opt/tanbala/leads/.env
sudo install -m 600 -o tanbala-wa -g tanbala-wa ~/whatsapp.env /opt/tanbala/whatsapp/.env
shred -u ~/leads.env ~/whatsapp.env
```

## `/etc/tanbala/compose.env` (root, права 600)

Для `docker compose` (его запускает root): только строки `POSTGRES_*` и `REACHER_*` из `.env` почты, без остальных
секретов. Делает шаг `db` из `install.sh`; после смены этих строк в `.env` почты повторить
`sudo /opt/tanbala/deploy/scripts/install.sh db`.

## `/opt/tanbala/leads/.env` (root, группа `tanbala-leads`, права 640)

Что поменять после переноса с ПК:

| Переменная | На сервере |
| --- | --- |
| `PARSER_2GIS_BIN` | `.venv-2gis/bin/parser-2gis` (на ПК путь Windows) |
| `PARSER_2GIS_HEADLESS` | `true`: Chrome для 2ГИС без окна. Если 2ГИС без окна не заработает — `false` и Xvfb |
| `PUBLIC_UI_HOST` | `leads.tanbala.kz`: имя интерфейса за Caddy (интерфейс на 127.0.0.1:8001) |
| `MAX_2GIS_BROWSERS`, `MAX_SITE_BROWSERS` | `1` и `1` |
| `REACHER_HELLO_NAME`, `REACHER_FROM_EMAIL` | после PTR 91.201.215.210 → `leads.tanbala.kz`: имя `leads.tanbala.kz`, адрес на этом домене (решает владелец). Исходящий порт 25 открыт (29.10.2026: Gmail, mail.ru, Яндекс отвечают 220); PTR просит владелец у PS.KZ |
| `LEADS_CONSOLE_TOKEN` | секрет, тот же, что в `.env` консоли; не равен `INTERNAL_API_TOKEN` (иначе почта не стартует). Создаётся на сервере (раздел «Токены консоли») |

Без изменений (секреты, как на ПК): `VENMART_ANTHROPIC_KEY`, `POSTGRES_PASSWORD`, `DATABASE_URL`, `REACHER_SECRET`,
`SMTP_PASSWORD`, `IMAP_PASSWORD`, `INTERNAL_API_TOKEN`. Пароль Postgres должен совпадать с тем, с которым на сервере
создаётся том `tanbala-leads_pgdata` (первый `docker compose up`). Остальное как на ПК: `POSTGRES_DB`,
`POSTGRES_USER`, `POSTGRES_PORT`, `REACHER_URL`, `REACHER_PORT`, `REACHER_SMTP_TIMEOUT`, `REACHER_MAX_PER_MINUTE`,
`AGENT_*`, `DRY_RUN_TO`, `SMTP_*`, `IMAP_*`, `DAILY_API_BUDGET_USD`, `RESEARCH_PER_DAY`, `LLM_LOG_PATH`.

## `/opt/tanbala/whatsapp/.env` (пользователь `tanbala-wa`)

| Переменная | На сервере |
| --- | --- |
| `ADMIN_PASSWORD` | секрет, не короче 16 символов (иначе панель за Caddy не откроется). Вписывает владелец |
| `PANEL_HOST`, `PANEL_PORT` | `127.0.0.1` и `3100` |
| `PANEL_ALLOWED_HOSTS` | `wa.tanbala.kz` |
| `WA_ENABLED` | `false` до привязки по QR; `true` ставит `pair-whatsapp.sh` (этап 4, только по команде владельца) |
| `TEST_MODE` | `true`, пока владелец отдельно не скажет |
| `EMAIL_API_URL` | `http://127.0.0.1:8000` |
| `EMAIL_UI_URL` | `https://leads.tanbala.kz` (ссылка на карточку компании для менеджера; после переключения на panel — `deploy/README.md`) |
| `INTERNAL_API_TOKEN` | секрет, тот же, что в `leads/.env` |
| `WA_CONSOLE_TOKEN` | секрет, тот же, что в `.env` консоли; не равен `INTERNAL_API_TOKEN` и `LEADS_CONSOLE_TOKEN`. Без него API для консоли не стартует. Создаётся на сервере (раздел «Токены консоли») |
| `CONSOLE_API_PORT` | `3101` (по умолчанию, строку можно не писать): API бота для консоли на 127.0.0.1 |

Без изменений: `VENMART_ANTHROPIC_KEY`, `OPENROUTER_API_KEY` (секреты), `MANAGER_WHATSAPP`, `TEST_ALLOWLIST`,
`API_DAILY_LIMIT`, `API_DAILY_LIMIT_PER_CHAT`, `BACKLOG_MAX_AGE_HOURS`. Пути `WHATSAPP_SESSION_DIR`, `DATABASE_PATH`,
`TOKEN_LOG_PATH` остаются внутри `data/` (по умолчанию). `TEST_MODE`, `TEST_ALLOWLIST`, `WA_ENABLED` задавать только
в `.env`, не в службе systemd: при разных значениях бот не запустится.

## `/opt/tanbala/console/.env` (root, группа `tanbala-console`, права 640)

Создаётся на сервере, с ПК не переносится. Служба его только читает. Полный список — `console/.env.example`
(имена задаёт консоль, `console/src/config/env.ts`; если там другие, верны они). Обязательны токены и
`CONSOLE_ALLOWED_HOSTS`, остальное по умолчанию совпадает с сервером.

| Переменная | На сервере |
| --- | --- |
| `CONSOLE_HOST`, `CONSOLE_PORT` | `127.0.0.1` и `3200` (по умолчанию) |
| `CONSOLE_ALLOWED_HOSTS` | `panel.tanbala.kz` |
| `LEADS_API_URL` | `http://127.0.0.1:8000` (по умолчанию; именно 127.0.0.1, не localhost) |
| `LEADS_CONSOLE_TOKEN` | секрет, тот же, что в `.env` почты |
| `WA_API_URL` | `http://127.0.0.1:3101` (по умолчанию) |
| `WA_CONSOLE_TOKEN` | секрет, тот же, что в `.env` бота; не равен `LEADS_CONSOLE_TOKEN` (иначе консоль не стартует) |
| `CONSOLE_DATABASE_PATH` | `data/console.db` (по умолчанию; пользователи, сессии, журнал действий; копия каждую ночь) |
| `LOG_LEVEL` | `info` (по умолчанию) |

Сроки сессии (30 дней, без активности 7 дней) заданы в самой консоли, в `.env` их нет.

## Токены консоли

Три разных токена, каждый — свои 32 случайных байта:

| Токен | В каких `.env` | Кто кого пускает |
| --- | --- | --- |
| `INTERNAL_API_TOKEN` (уже есть) | почта, бот | бот → внутренний API почты |
| `LEADS_CONSOLE_TOKEN` (новый) | почта, консоль | консоль → API почты для консоли |
| `WA_CONSOLE_TOKEN` (новый) | бот, консоль | консоль → API бота для консоли |

Совпадать они не должны: бот по nftables ходит в почту, и с общим токеном взломанный бот получил бы права консоли
(одобрять письма, запускать платный поиск). Приложения с одинаковыми токенами не стартуют. Новые токены создаются
на сервере и сразу пишутся в файлы, на экран не выводятся. После `install.sh all` (папка консоли уже есть):

```bash
# сервер
# 1. Строк с новыми токенами ещё нет (обе команды печатают 0):
sudo grep -c '^LEADS_CONSOLE_TOKEN=' /opt/tanbala/leads/.env
sudo -u tanbala-wa grep -c '^WA_CONSOLE_TOKEN=' /opt/tanbala/whatsapp/.env
# 2. .env консоли: создать (если нет) и вписать несекретные строки из таблицы выше, без токенов
sudo test -e /opt/tanbala/console/.env || sudo install -m 640 -o root -g tanbala-console /dev/null /opt/tanbala/console/.env
sudo nano /opt/tanbala/console/.env
# 3. Два новых токена в три файла (в .env бота — от имени бота)
L=$(openssl rand -hex 32) W=$(openssl rand -hex 32)
printf '\nLEADS_CONSOLE_TOKEN=%s\n' "$L" | sudo tee -a /opt/tanbala/leads/.env >/dev/null
printf '\nWA_CONSOLE_TOKEN=%s\n' "$W" | sudo -u tanbala-wa tee -a /opt/tanbala/whatsapp/.env >/dev/null
printf '\nLEADS_CONSOLE_TOKEN=%s\nWA_CONSOLE_TOKEN=%s\n' "$L" "$W" | sudo tee -a /opt/tanbala/console/.env >/dev/null
unset L W
# 4. Службы читают .env при старте
sudo systemctl restart tanbala-leads
sudo systemctl enable tanbala-console && sudo systemctl restart tanbala-console
systemctl is-active --quiet tanbala-whatsapp && sudo systemctl restart tanbala-whatsapp   # бот, если уже работает
```

Сменить токен (утёк или сотрудник видел файл): те же шаги 3–4 для одного токена, старую строку в обоих файлах
удалить (`sudo nano`, в `.env` бота — `sudo -u tanbala-wa nano`).

## Пароли Caddy (basic auth) и открытие панелей

Пока паролей нет, Caddy работает по `Caddyfile.closed`: wa.tanbala.kz и leads.tanbala.kz отвечают 503, до приложений
запрос не доходит, сертификаты HTTPS уже получены. Открывает панели владелец, в своём сеансе SSH:

1. Сделать два разных пароля, длинных и случайных (не короче 24 символов), и сохранить в менеджер паролей. Например,
   на сервере: `openssl rand -base64 18` (печатает 24 символа), два раза.
2. Одна команда:

   ```bash
   ssh ubuntu@91.201.215.210
   sudo /opt/tanbala/deploy/scripts/open-panels.sh
   ```

   Скрипт спросит для wa.tanbala.kz, затем для leads.tanbala.kz имя (латиницей) и пароль дважды (ввод не виден,
   пароль короче 20 символов не примет). В `/etc/caddy/auth/wa.caddy` и `leads.caddy` (root:caddy, права 640)
   ляжет одна строка «имя хэш bcrypt», самого пароля на сервере нет. Потом скрипт ставит рабочий `Caddyfile`,
   перезагружает Caddy и проверяет, что без пароля оба сайта отвечают 401.

Хэш с ценой 10, а не 14, как у `caddy hash-password` (0.7 с процессора на попытку): пароль длинный и случайный,
подбор безнадёжен и так, а неверная попытка стоит серверу в 16 раз меньше. Неверные попытки ещё и блокирует fail2ban.

Сменить пароль: `sudo /opt/tanbala/deploy/scripts/open-panels.sh wa` (или `leads`); старый действует, пока новый не
записан. Закрыть панели обратно: `sudo rm /etc/caddy/auth/*.caddy && sudo /opt/tanbala/deploy/scripts/install.sh caddy`
(файлы паролей руками не удалять без этой второй команды: после перезапуска Caddy не нашёл бы их и не поднялся).

Панель бота за паролем Caddy заработает после этапа 4 (до него там 502). Её второй пароль — `ADMIN_PASSWORD`
в `/opt/tanbala/whatsapp/.env`, не короче 16 символов: с коротким бот не пускает в панель по имени wa.tanbala.kz
(403). Сменить (новый пароль, например `openssl rand -base64 18`):

```bash
ssh -t ubuntu@91.201.215.210 sudo -u tanbala-wa nano /opt/tanbala/whatsapp/.env   # строка ADMIN_PASSWORD=...
ssh ubuntu@91.201.215.210 sudo systemctl restart tanbala-whatsapp                  # если бот уже работает
```

### panel.tanbala.kz (консоль)

Режим свой: panel. открыт, когда есть `/etc/caddy/auth/panel.caddy`, иначе отвечает 503; wa. и leads. от него не
зависят, и наоборот. Пароль Caddy — по строке на человека (не короче 20 символов, ввод не виден, дважды):

```bash
sudo /opt/tanbala/deploy/scripts/open-panels.sh panel add <имя>      # новый человек или новый пароль ему
sudo /opt/tanbala/deploy/scripts/open-panels.sh panel remove <имя>   # убрать человека (последний — panel. снова 503)
sudo /opt/tanbala/deploy/scripts/open-panels.sh panel list           # у кого есть пароль Caddy
```

Второй слой — пользователь самой консоли: имя `[a-z0-9._-]`, пароль от 9 до 256 символов, роль владелец или
менеджер. В интерфейсе пользователи только для чтения, заводит и меняет их владелец командой (пароль спросит
консоль, ввод не виден):

```bash
ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/console-user.sh user add <имя>
ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/console-user.sh --help   # пароль, роль, отключить, сессии
```

Сотрудник ушёл: отключить его в консоли (сессии закроются) и `open-panels.sh panel remove <имя>`.

Пять неверных входов в консоль за 10 минут — IP закрыт на час (fail2ban, `tanbala-console-login`). Свой адрес:
`sudo fail2ban-client set tanbala-console-login unbanip <IP>` (и `tanbala-caddy-auth`, если он есть и там:
`sudo fail2ban-client status tanbala-caddy-auth`).
