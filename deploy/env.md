# Настройки на сервере

Здесь только названия переменных и несекретные значения (адреса, пути). Секреты владелец переносит сам: `.env` из
`leads/` и `whatsapp/` на ПК. Образцы со всеми переменными: `leads/.env.example`, `whatsapp/.env.example`.

## Перенос `.env` с ПК

scp кладёт файл с правами 644, поэтому сначала в домашнюю папку `ubuntu`, потом на место с правами 600 и
владельцем-пользователем службы, копия в домашней папке стирается:

```powershell
# ПК, PowerShell, из папки D-Email+WhatsApp
scp .\leads\.env ubuntu@91.201.215.210:~/leads.env
scp .\whatsapp\.env ubuntu@91.201.215.210:~/whatsapp.env
```

```bash
# сервер
sudo install -m 600 -o tanbala-leads -g tanbala-leads ~/leads.env /opt/tanbala/leads/.env
sudo install -m 600 -o tanbala-wa -g tanbala-wa ~/whatsapp.env /opt/tanbala/whatsapp/.env
shred -u ~/leads.env ~/whatsapp.env
```

## `/etc/tanbala/compose.env` (root, права 600)

Для `docker compose` (его запускает root): только строки `POSTGRES_*` и `REACHER_*` из `.env` почты, без остальных
секретов. Не сам `.env` почты: его может менять пользователь `tanbala-leads`.

```bash
sudo install -d -m 700 /etc/tanbala
sudo sh -c "umask 077 && grep -E '^(POSTGRES|REACHER)_' /opt/tanbala/leads/.env > /etc/tanbala/compose.env"
```

После смены этих строк в `.env` почты повторить команду и `docker compose ... up -d`.

## `/opt/tanbala/leads/.env` (пользователь `tanbala-leads`)

Что поменять после переноса с ПК:

| Переменная | На сервере |
| --- | --- |
| `PARSER_2GIS_BIN` | `.venv-2gis/bin/parser-2gis` (на ПК путь Windows) |
| `PARSER_2GIS_HEADLESS` | `true`: Chrome для 2ГИС без окна. Если 2ГИС без окна не заработает — `false` и Xvfb |
| `PUBLIC_UI_HOST` | `leads.tanbala.kz`: имя интерфейса за Caddy |
| `MAX_2GIS_BROWSERS`, `MAX_SITE_BROWSERS` | `1` и `1` (VPS 4 ГБ) |
| `REACHER_HELLO_NAME`, `REACHER_FROM_EMAIL` | после PTR 91.201.215.210 → `leads.tanbala.kz`: имя `leads.tanbala.kz`, адрес на этом домене (решает владелец) |

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

## Пароли Caddy (basic auth)

Файлы `/etc/caddy/auth/wa.caddy` и `/etc/caddy/auth/leads.caddy`, в каждом одна строка `имя хэш`. Делает владелец
в своём сеансе SSH; в файле только хэш bcrypt.

Пароль длинный и случайный (не короче 24 символов), его запоминает менеджер паролей и браузер. Тогда хэш можно
делать с ценой 10: подбор такого пароля всё равно безнадёжен, а неверная попытка стоит серверу в 16 раз меньше
процессора, чем у `caddy hash-password` (цена 14, 0.7 с на попытку). Неверные попытки ещё и блокирует fail2ban.

```bash
sudo apt install -y apache2-utils
sudo install -d -m 750 -o root -g caddy /etc/caddy/auth
openssl rand -base64 18    # пример случайного пароля (24 символа): сохранить в менеджер паролей
# для wa.tanbala.kz (для leads.tanbala.kz то же с leads.caddy): имя латиницей, пароль htpasswd спросит дважды
read -rp "Имя: " user && hash=$(htpasswd -nBC 10 "$user" | cut -d: -f2-) && \
  printf '%s %s\n' "$user" "$hash" | sudo tee /etc/caddy/auth/wa.caddy >/dev/null
sudo chown root:caddy /etc/caddy/auth/*.caddy && sudo chmod 640 /etc/caddy/auth/*.caddy
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
