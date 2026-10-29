# Настройки на сервере

Здесь только названия переменных и несекретные значения (адреса, пути). Секреты владелец переносит сам: `.env` из
`leads/` и `whatsapp/` на ПК (команды scp даёт Claude), на сервере права 600 и владелец — пользователь службы.
Образцы со всеми переменными: `leads/.env.example`, `whatsapp/.env.example`.

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

Файлы `/etc/caddy/auth/wa.caddy` и `/etc/caddy/auth/leads.caddy`, в каждом одна строка `имя хэш`. Пароль вводит
владелец, на экран он не выводится, в файле только хэш bcrypt:

```bash
sudo install -d -m 750 -o root -g caddy /etc/caddy/auth
# для каждого файла (wa, leads): имя пользователя латиницей, пароль Caddy спросит дважды
read -rp "Имя для wa.tanbala.kz: " user && hash=$(caddy hash-password) && \
  printf '%s %s\n' "$user" "$hash" | sudo tee /etc/caddy/auth/wa.caddy >/dev/null
sudo chown root:caddy /etc/caddy/auth/*.caddy && sudo chmod 640 /etc/caddy/auth/*.caddy
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```
