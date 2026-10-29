# Настройки на сервере

Здесь только названия переменных и несекретные значения (адреса, пути). Секреты владелец переносит сам: `.env` из
`leads/` и `whatsapp/` на ПК. Образцы со всеми переменными: `leads/.env.example`, `whatsapp/.env.example`.

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
| `PUBLIC_UI_HOST` | `leads.tanbala.kz`: имя интерфейса за Caddy |
| `MAX_2GIS_BROWSERS`, `MAX_SITE_BROWSERS` | `1` и `1` |
| `REACHER_HELLO_NAME`, `REACHER_FROM_EMAIL` | после PTR 91.201.215.210 → `leads.tanbala.kz`: имя `leads.tanbala.kz`, адрес на этом домене (решает владелец). Исходящий порт 25 открыт (29.10.2026: Gmail, mail.ru, Яндекс отвечают 220); PTR просит владелец у PS.KZ |

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
| `WA_ENABLED` | `false` до привязки по QR (этап 4, только по команде владельца) |
| `TEST_MODE` | `true`, пока владелец отдельно не скажет |
| `EMAIL_API_URL` | `http://127.0.0.1:8000` |
| `EMAIL_UI_URL` | `https://leads.tanbala.kz` (ссылка на карточку компании для менеджера) |
| `INTERNAL_API_TOKEN` | секрет, тот же, что в `leads/.env` |

Без изменений: `VENMART_ANTHROPIC_KEY`, `OPENROUTER_API_KEY` (секреты), `MANAGER_WHATSAPP`, `TEST_ALLOWLIST`,
`API_DAILY_LIMIT`, `API_DAILY_LIMIT_PER_CHAT`, `BACKLOG_MAX_AGE_HOURS`. Пути `WHATSAPP_SESSION_DIR`, `DATABASE_PATH`,
`TOKEN_LOG_PATH` остаются внутри `data/` (по умолчанию). `TEST_MODE`, `TEST_ALLOWLIST`, `WA_ENABLED` задавать только
в `.env`, не в службе systemd: при разных значениях бот не запустится.

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
в `/opt/tanbala/whatsapp/.env`.
