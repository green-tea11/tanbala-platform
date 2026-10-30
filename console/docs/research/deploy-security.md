# План: служба console (panel.tanbala.kz) на сервере Tanbala

Только чтение: ни один файл не менялся, службы и внешние API не вызывались, `.env` не открывались.

---

## 1. Что поменять по файлам

### 1.1 `deploy/nftables/tanbala-guard.nft`

**Что сейчас не пустит консоль:**
- Строка `deploy/nftables/tanbala-guard.nft:60`: `ip daddr 127.0.0.0/8 tcp dport { 3100, 8000 } meta skuid != 0 reject`. Любой пользователь, кроме root, получит отказ к обоим приложениям, значит и `tanbala-console`.
- Caddy пускают только на `{ 3100, 8000 }` (`:55`), остальная петля закрыта (`:56`). Соединение caddy → 127.0.0.1:3200 будет отклонено.
- Правила ищут пользователей по имени (`:10`, `deploy/systemd/tanbala-firewall.service:3`). Если `tanbala-console` ещё нет, `nft -f` не примет файл целиком. Файл применяется атомарно, поэтому старая таблица останется. Но `install.sh configs` упадёт на `reload-or-restart tanbala-firewall` (`deploy/scripts/install.sh:156`).

**Что добавить.** Блок консоли поставить до строки 59. Строка 34 (`ct state established,related accept`) уже пропускает ответы консоли Caddy:
```nft
		# Консоль: на 127.0.0.1 только API почты (8000) и бота (3100 или отдельный 3101), больше никуда.
		meta skuid "tanbala-console" ip daddr 127.0.0.1 tcp dport { 3100, 8000 } accept
		meta skuid "tanbala-console" reject with icmpx admin-prohibited
```
Последнее правило запрещает консоли весь остальной исходящий трафик: интернет ей не нужен, и при взломе она ничего не унесёт наружу. Правило DNS в `:36` стоит выше, но консоль ходит только на IP-адреса.

Для Caddy (`:55`) и для «остальных» (`:60`):
```nft
		meta skuid "caddy" ip daddr 127.0.0.1 tcp dport { 3100, 3200, 8000 } accept
		...
		ip daddr 127.0.0.0/8 tcp dport { 3100, 3101, 3200, 8000 } meta skuid != 0 reject with tcp reset
```
- Почта к 3200 не пройдёт: петля для неё открыта только на `5432, 8080, 32768-60999` (`:40-41`). Бот тоже: ему открыт только 8000 (`:48-49`).
- После того как старые панели уберут: у caddy остаётся только `{ 3200 }`, у `tanbala-wa` по-прежнему только 8000.
- Если API бота будет на отдельном порту 3101 (раздел 3), у консоли `{ 3101, 8000 }`, а Caddy к 3101 не пускать никогда.
- Поправить шапку файла (`:2-10`) и `deploy/systemd/tanbala-firewall.service:7`: `Before=... tanbala-console.service`.

### 1.2 `deploy/systemd/tanbala-console.service` (новый)

**Какие защиты уже есть в двух рабочих службах** (`deploy/systemd/tanbala-leads.service:59-79`, `deploy/systemd/tanbala-whatsapp.service:49-70`):

`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=strict`, `ProtectHome`, `ReadOnlyPaths`/`ReadWritePaths`, `InaccessiblePaths` (чужие папки, копии, пароли и API Caddy), `PrivateDevices` (только у бота), `ProtectProc=invisible`, `SystemCallArchitectures=native`, `ProtectKernelTunables`, `ProtectKernelModules`, `ProtectKernelLogs`, `ProtectControlGroups`, `ProtectClock`, `ProtectHostname`, `RestrictSUIDSGID`, `RestrictRealtime`, `RestrictNamespaces` (только у бота), `LockPersonality`, `RestrictAddressFamilies`, `CapabilityBoundingSet=`, `UMask=0077`. Кроме того: `Requires=tanbala-firewall.service`, `StartLimitIntervalSec`/`StartLimitBurst`, `MemoryLow`/`MemoryHigh`/`MemoryMax`, `OOMScoreAdjust`. `MemoryDenyWriteExecute` не ставится из-за JIT V8 (`tanbala-whatsapp.service:48`).

**Черновик:**
```ini
[Unit]
Description=Tanbala console: единая панель (127.0.0.1:3200)
After=network-online.target tanbala-firewall.service tanbala-leads.service tanbala-whatsapp.service
Wants=network-online.target
Requires=tanbala-firewall.service
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=tanbala-console
Group=tanbala-console
WorkingDirectory=/opt/tanbala/console
Environment=NODE_ENV=production
Environment=HOME=/opt/tanbala/console/data
ExecStart=/usr/local/bin/node /opt/tanbala/console/dist/server.js
Restart=on-failure
RestartSec=10
TimeoutStopSec=15
UMask=0077
# Консоль ≈ 50–80 МБ; scrypt при входе до 32 МиБ на проверку. Первые 48 МБ ядро не уводит в swap во время поиска.
MemoryLow=48M
MemoryHigh=200M
MemoryMax=300M
OOMScoreAdjust=-100
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/tanbala/console
ReadWritePaths=/opt/tanbala/console/data
InaccessiblePaths=-/opt/tanbala/leads -/opt/tanbala/whatsapp -/var/backups/tanbala -/etc/caddy/auth -/etc/tanbala -/var/lib/caddy
PrivateDevices=true
ProtectProc=invisible
SystemCallArchitectures=native
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
# Сверх двух рабочих служб: сетевой замок systemd вдобавок к nftables.
IPAddressDeny=any
IPAddressAllow=localhost
```
- Права по образцу почты, а не бота. Код принадлежит root и для службы только читается, писать она может только в `data/`. У консоли токены к обоим приложениям, поэтому взлом консоли не должен подменить её код (см. `tanbala-leads.service:54-56`).
- В двух рабочих службах в `InaccessiblePaths` (`tanbala-leads.service:66`, `tanbala-whatsapp.service:55`) добавить `-/opt/tanbala/console`.
- Можно ещё `Environment=NODE_OPTIONS=--max-old-space-size=128`.

### 1.3 `deploy/scripts/install.sh`

- **Шаг `system`** (`:112-115`): `add_user tanbala-console`. Пользователь должен появиться до `configs`, иначе nft не найдёт его по имени.
- **Шаг `configs`** (`:120-122`): `need_user tanbala-console`. Службы и так ставятся маской `*.service` (`:151`). Добавить `systemctl enable tanbala-console.service`, как у почты (`:158`). Поставить новый фильтр и jail fail2ban (`:145-148`).
- **Новый шаг `console`**, по образцу `step_leads` и `step_whatsapp` (`:219-312`):
  1. `from_release console`, `need_user tanbala-console`.
  2. `install -d -m 750 -o root -g tanbala-console /opt/tanbala/console`.
  3. Копия из архива во временную папку, `chown` на `tanbala-console`.
  4. `runuser -u tanbala-console -- npm ci --omit=dev --no-audit --no-fund` во временной папке, только зависимости для работы. `.npmrc` с `ignore-scripts=true`, как у бота (`whatsapp/.npmrc`).
  5. Проверка native-модуля, если будет better-sqlite3 (как `:302`).
  6. `rsync -a --delete --safe-links --exclude=/.env --exclude=/data/` в `/opt/tanbala/console`, `chown -R root:root` всего, кроме `data/` и `.env`.
  7. `install -d -m 700 -o tanbala-console data`. `.env` приводится к `root:tanbala-console 640`.
  8. Запуск только при наличии `.env`, как `start_leads` (`:262-274`).
- **Порядок `all`** (`:327`): `system configs leads whatsapp console`. Консоль идёт последней: её эндпоинты появляются в `leads` и `whatsapp`. Обновить список шагов (`:330`) и шапку (`:5-12`).
- **Шаг `caddy`, режимы.** Сейчас рабочий Caddyfile ставится, только если готовы оба файла паролей (`:169-171`). Если добавить туда `panel`, первый же `install.sh configs` на сервере с открытыми wa и leads переключит Caddy на `Caddyfile.closed`, и обе старые панели получат 503 (`:139-140` вызывает `step_caddy`). Рекомендую решать режим консоли отдельно. Два файла: `caddy/panel.caddy` (рабочий) и `caddy/panel.closed.caddy` (503). `step_caddy` кладёт нужный в `/etc/caddy/panel-site.caddy`, оба Caddyfile его импортируют. `validate_caddy` (`:175-190`) должен переписывать и этот `import` на временную копию.

### 1.4 `deploy/scripts/build-release.sh`

- Сейчас в архив попадает только то, что в git: `git archive ... HEAD leads whatsapp deploy contract` (`:28-29`). Папки `console` в списке нет, а собранного `dist/` (Vite и `tsc`) в git обычно нет. Значит, сборка фронтенда в архив сейчас не попала бы.
- Бот собирается на сервере: `npm ci`, `npm run build` (`tsc`), `npm prune --omit=dev` от `tanbala-wa` (`install.sh:292-302`).
- **Рекомендация: везти консоль собранной с ПК, как сайт.** `deploy/scripts/site.sh:31-38` собирает на ПК во временной папке из `git archive` с `npm ci --ignore-scripts`. Комментарий `:32` объясняет причину: на ПК лежит ключ к серверу.
- Для консоли `build-release.sh`:
  1. Добавить `console` в список `git archive`.
  2. Распаковать `console` во временную папку и запустить `npm ci --ignore-scripts && npm run build` (сервер `tsc` и фронтенд `vite build`).
  3. Собрать итоговый архив: `git archive --format=tar`, затем `tar -rf` с `console/dist` и `console/web/dist`, затем `gzip`.
  4. Расширить проверку `:32` на `node_modules/` и `*.db`.
- **Почему не собирать Vite на сервере.** В простое свободно около 1 ГБ. Сборка Vite/Rollup берёт примерно 0.3–0.6 ГБ плюс `npm ci` с инструментами разработки. Вне поиска это поместится. Во время поиска Chrome займёт память, сборка уйдёт в swap, а ядро первым убьёт Chrome почты (`OOMScoreAdjust=500`). Кроме того, на сервере оказались бы лишние dev-пакеты: больше чужого кода и больше риск через цепочку поставок. `tsc` бота на сервере остаётся как есть.

### 1.5 `deploy/scripts/health.sh`

- `CONSOLE=http://127.0.0.1:3200`. В `units` (`:37`) добавить `tanbala-console` в конец, тогда сработает и проверка перезапусков `${units[@]:2}` (`:43-46`).
- **Изнутри:**
  - `expect 200 "консоль отвечает" "$CONSOLE/healthz"`. `/healthz` без сессии, только с локальным Host. Отдаёт только «да/нет» по каждому API, без данных.
  - `expect 401 ... "$LEADS/internal/console/<путь>"` без токена.
  - Такая же проверка для API бота, но только когда `wa_linked` (`:56`).
- **Снаружи:**
  - В закрытом режиме `expect 503 https://panel.tanbala.kz/`.
  - В рабочем режиме `expect 401 https://panel.tanbala.kz/` и `expect 404 https://panel.tanbala.kz/internal/x`.
  - После переключения на редиректы (раздел 1.10): `expect 302` (или 301) для wa. и leads. вместо 401 (`:72-74`).
- Если консоль будет в копиях, проверять свежесть `"$BACKUP_ROOT/console"`, как `:86-88`.
- `MEM_MIN_MB=200` (`:14`): на 2 ГБ во время поиска MemAvailable может опуститься ниже, и будет ложный СБОЙ (раздел 4).

### 1.6 `deploy/scripts/backup.sh`

- **Нужна ли копия.** Сессии копировать не нужно: в памяти, как у бота (`whatsapp/src/panel/sessions.ts:14`), или одноразовые. Пользователи (scrypt-хэши) и журнал действий в `data/console.db` — нужна. Потеря не смертельна, пользователей можно завести заново из CLI, но копия дешёвая.
- **Как.** Тот же приём, что для бота (`:35-49`): `runuser -u tanbala-console -- sqlite3 "$DB" ".backup '$TMP/copy.db'"`, `PRAGMA quick_check`, поток в файл root. Папка `$BACKUP_ROOT/console` (`:22`), очистка через 7 дней (`:52-56`). `ReadWritePaths=/var/backups/tanbala` в `tanbala-backup.service:16` уже покрывает подпапку.
- **Проверить на сервере, и для бота тоже.** Служба копий идёт с `ProtectSystem=strict` (`tanbala-backup.service:15`). Для неё `/opt/tanbala/*/data` только на чтение. Для SQLite в режиме WAL чтение при работающем приложении зависит от файла `-shm`. Посмотреть `journalctl -u tanbala-backup` после первой ночной копии бота.

### 1.7 fail2ban (неудачные входы в консоль)

- **Что уже есть.** Фильтр `deploy/fail2ban/filter.d/tanbala-caddy-auth.conf:6` ловит любой `"status":401` в `/var/log/caddy/access.log`. Значит, 401 от самой консоли уже попадёт в этот jail: 10 за 10 минут, бан на час (`jail.d/...:13-15`).
- **Ловушка 1.** Ограничитель как у бота даёт 429 после 5 неудач (`whatsapp/src/panel/login-limiter.ts:18-22`). До 10 ответов 401 дело не дойдёт.
- **Ловушка 2.** Если консоль отвечает 401 на «сессия истекла» для опросов SPA, то через 10 опросов fail2ban забанит самого владельца. Консоль должна отдавать 401 только на неверный логин или пароль. На «нет сессии» — 403 с `{"error":"no_session"}`.
- **Рекомендация: отдельный jail по журналу Caddy.** Адрес там настоящий (`remote_ip` — TCP-пир), и формат лога приложения не нужен. Путь в журнале остаётся, вырезается только строка запроса (`deploy/caddy/common.caddy:35`).
  ```ini
  # filter.d/tanbala-console-login.conf
  [Definition]
  failregex = ^\{.*"remote_ip":"<HOST>".*"method":"POST".*"host":"panel\.tanbala\.kz".*"uri":"/api/login".*"status":(?:401|429)[,}]
  datepattern = "ts":{EPOCH}
  # jail.d/tanbala-console-login.conf: logpath /var/log/caddy/access.log, backend polling, maxretry 5, findtime 10m,
  # bantime 1h, ignoreip как у tanbala-caddy-auth
  ```
  Регулярку проверить на сервере через `fail2ban-regex` на настоящей строке: порядок ключей в JSON Caddy проверяется регуляркой.
- **Запасной вариант: журнал systemd.** Консоль пишет pino-строку `{"action":"login_failed","ip":"…"}` (сейчас так делает бот: `whatsapp/src/panel/routes-auth.ts:55`). Jail с `backend = systemd`, `journalmatch = _SYSTEMD_UNIT=tanbala-console.service`. Нужен `python3-systemd` (проверить на сервере), а порядок ключей зависит от pino.

### 1.8 logrotate и journald

- Консоль пишет в stdout, то есть в журнал systemd. Его ограничения 1 ГБ и месяц (`deploy/journald/tanbala.conf:5-7`) уже действуют.
- Своих файлов журнала у консоли быть не должно, иначе нужна запись в `deploy/logrotate/tanbala` с `su tanbala-console tanbala-console` и `create 0600`.
- Логи fastify на уровне warn, без строки запроса и тела запроса: в теле логин и пароль. Так сделано у бота (`whatsapp/src/panel/server.ts:115`) и у почты (`leads/tanbala_leads/web/app.py:587-599`).

### 1.9 Блок Caddy для panel.tanbala.kz

Рабочий файл `caddy/panel.caddy` (по образцу leads, `deploy/Caddyfile:27-41`):
```caddy
panel.tanbala.kz {
	import common
	route {
		# Служебные пути приложений снаружи не видны: 404 ещё до пароля.
		@internal path_regexp internal (?i)(^|/)internal([/;]|$)
		respond @internal 404
		basic_auth {
			import /etc/caddy/auth/panel.caddy
		}
		# 127.0.0.1, не localhost. Пароль Caddy консоли не передаём; Host всегда имя консоли.
		reverse_proxy 127.0.0.1:3200 {
			header_up Host panel.tanbala.kz
			header_up -Authorization
		}
	}
}
```
- Закрытый вариант: `panel.tanbala.kz { import common; respond 503 }`, тогда сертификат получается заранее (как `deploy/Caddyfile.closed:10-13`).
- Нужна A-запись `panel.tanbala.kz → 91.201.215.210` до первого `reload`. Её делает владелец.
- Заголовки HSTS и `-Server` даёт `(common)` (`deploy/caddy/common.caddy:22-25`). CSP, nosniff, `X-Frame-Options`, `no-store` и прочее ставит сама консоль на каждом ответе, как бот (`whatsapp/src/panel/http.ts:95-105`). Для SPA: `script-src 'self'; connect-src 'self'` (как у почты, `app.py:98-101`).
- Статику фронтенда отдаёт консоль: Caddy не может читать `/opt/tanbala/console` (750 root:tanbala-console). Файлы с хэшем в имени — `immutable`, страница — `no-store`.

### 1.10 Перевод wa./leads. на panel., пока старые панели живы

- **Этап А** (отдельный коммит): добавить только `panel.tanbala.kz`. Блоки wa. и leads. (`deploy/Caddyfile:12-41`) не трогать, обе панели работают параллельно.
- **Этап Б** (после «ок» владельца, отдельный коммит): блоки заменить редиректом. Сначала **302**, не 301: браузер запоминает 301 навсегда, и откат не сработает. На 301 перейти позже.
  ```caddy
  wa.tanbala.kz {
  	import common
  	redir https://panel.tanbala.kz/whatsapp 302
  }
  leads.tanbala.kz {
  	import common
  	route {
  		@internal path_regexp internal (?i)(^|/)internal([/;]|$)
  		respond @internal 404
  		# Ссылки из уведомлений менеджеру в WhatsApp: https://leads.tanbala.kz/companies/{id}
  		@card path_regexp card ^/companies/(\d{1,19})$
  		redir @card https://panel.tanbala.kz/leads/companies/{re.card.1} 302
  		redir https://panel.tanbala.kz/leads 302
  	}
  }
  ```
  `route` нужен потому, что в стандартном порядке Caddy `redir` стоит раньше `respond`, и без `route` редирект перехватил бы `/internal`.
- **Почему нужна карта путей.** Бот кладёт в уведомления менеджеру ссылку `EMAIL_UI_URL + /companies/{id}` (`whatsapp/src/company/summary.ts:21-24`, `whatsapp/src/handoff/notification.ts:179`, `deploy/env.md:59`). Старые сообщения в WhatsApp со ссылками на leads. должны и дальше открываться.
- После этапа Б:
  - `EMAIL_UI_URL` поменять на адрес консоли.
  - Позже, по решению владельца, очистить `PUBLIC_UI_HOST` и `PANEL_ALLOWED_HOSTS`.
  - Убрать у caddy в nftables порты 3100 и 8000.
  - Убрать `wa.caddy` и `leads.caddy` и упростить `caddy_file()`.

### 1.11 `deploy/scripts/open-panels.sh`

- `case` (`:63-68`): добавить вариант `panel` (`force_panel`).
- После `:72`: `ask_password panel "$force_panel"`.
- Проверка снаружи (`:78`): `for site in wa leads panel`.
- Итоговые сообщения (`:88-89`): пользователи консоли заводятся отдельной командой (новый `deploy/scripts/console-user.sh` или `sudo -u tanbala-console node dist/cli.js user add <имя>`), пароль вводится через stdin без эха, как `:44-49`.
- Требование к паролю Caddy (`MIN_LENGTH=20`, `:16`) оставить для panel тем же.

### 1.12 `deploy/env.md` (только названия)

- **`/opt/tanbala/console/.env`** (root, группа `tanbala-console`, права 640):
  - `CONSOLE_HOST` (`127.0.0.1`), `CONSOLE_PORT` (`3200`), `CONSOLE_ALLOWED_HOSTS` (`panel.tanbala.kz`)
  - `LEADS_API_URL` (`http://127.0.0.1:8000`), `LEADS_CONSOLE_TOKEN` (секрет)
  - `WA_API_URL` (`http://127.0.0.1:3100` или `:3101`), `WA_CONSOLE_TOKEN` (секрет)
  - `CONSOLE_DATABASE_PATH` (`data/console.db`), `SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`, `LOG_LEVEL`
- **`/opt/tanbala/leads/.env`**: `CONSOLE_API_TOKEN` (секрет, тот же, что `LEADS_CONSOLE_TOKEN`). После этапа Б `PUBLIC_UI_HOST` пустой.
- **`/opt/tanbala/whatsapp/.env`**: `CONSOLE_API_TOKEN` (секрет, тот же, что `WA_CONSOLE_TOKEN`). `CONSOLE_API_PORT`, если выберут отдельный порт. После этапа Б `EMAIL_UI_URL` новый, `PANEL_ALLOWED_HOSTS` пустой.
- **`/etc/caddy/auth/panel.caddy`** (root:caddy 640, одна строка «имя хэш-bcrypt»).
- **README.md**: строки таблиц про `tanbala-console.service`, `/opt/tanbala/console` и про fail2ban.

---

## 2. Можно ли взять вход панели бота в консоль

**Как устроено сейчас.**
- **Сессии** (`whatsapp/src/panel/sessions.ts`):
  - В памяти, в `Map`. После перезапуска нужен новый вход (`:14`).
  - ID — 32 случайных байта в base64url (`:33`, `:42-44`). У каждой сессии свой токен CSRF (`:69-70`).
  - Простой 2 часа, всего не больше 12 часов (`:35-39`, `:50-51`). Не больше 20 сессий, лишняя вытесняет самую старую (`:53-63`).
  - Объект сессии не меняется: продление создаёт новый (`:84-89`). При входе старый ID уничтожается и выдаётся новый (защита от фиксации сессии, `routes-auth.ts:59-63`).
- **Cookie** `tanbala_sid`: `Path=/; HttpOnly; SameSite=Strict`, `Secure`, когда запрос пришёл по HTTPS. Срока нет, cookie живёт до закрытия браузера, срок сессии ведёт сервер (`http.ts:2`, `:17`, `:38-45`).
- **CSRF** — два слоя:
  1. Для POST и других изменяющих методов Origin, а без него Referer, должен совпасть с `протокол://Host`. Нет ни того ни другого — отказ (`http.ts:68-79`, `hooks.ts:106-117`).
  2. Скрытое поле `csrf` сравнивается с токеном сессии за постоянное время (`hooks.ts:131-135`, `:153-165`).
- **Ограничитель входа**: скользящее окно, 5 неудач за 10 минут на ключ `request.ip`, не больше 1000 ключей, старые вытесняются (`login-limiter.ts:18-22`, `:28-56`). После 5 неудач 429 с `Retry-After`, успешный вход сбрасывает счётчик (`routes-auth.ts:42-58`).
- **Доверенный прокси**: `trustProxy: '127.0.0.1'`. `request.ip` и `request.protocol` берутся из `X-Forwarded-*` только от локального Caddy (`server.ts:71`, `:116`). Caddy 2.5+ без `trusted_proxies` сам переписывает `X-Forwarded-For`.
- **Остальные хуки** (`hooks.ts:143-152`): пир сокета только петля (`:58-68`); Host из разрешённых (`guard.ts:73-100`); домен только по HTTPS (`hooks.ts:91-103`); вход требуется даже на 404.
- **Пароль**: один `ADMIN_PASSWORD` открытым текстом в `.env`, не короче 16 символов. Сравнение `timingSafeEqual` по SHA-256 (`guard.ts:11`, `:110-117`).

**Вывод.** Модули `sessions.ts`, `login-limiter.ts`, `guard.ts`, `http.ts` маленькие и не зависят от бота. Их можно перенести почти как есть (с тестами). Хуки `hooks.ts` перенести по схеме, поменяв проверки под JSON/SPA.

**Что улучшить в консоли.**
- **Имя и пароль.** Пароль от 9 символов, верхний предел около 256: ограничивает цену хэша. Хранится только хэш в SQLite, открытого пароля нигде нет.
- **Хэш scrypt** из `node:crypto` без native-зависимостей. В Node 22.23 argon2 нет. Параметры:
  - `N=2^15, r=8, p=1, keylen=64`, соль 16 байт.
  - `maxmem` задать явно, около 64 МиБ: при `N=2^15` стандартных 32 МиБ не хватит, OpenSSL откажет.
  - Формат `scrypt$N$r$p$salt$hash`, сравнение `timingSafeEqual`.
  - Только асинхронный `crypto.scrypt`, не больше 1–2 проверок сразу (около 32 МиБ каждая).
  - Для несуществующего имени считать подставной хэш, чтобы по времени ответа нельзя было узнать, есть ли такое имя.
- **Ограничитель с двумя ключами**: IP (5 за 10 минут) и имя (например, 10 за час). Ответ 401 только на неверный вход (раздел 1.7).
- **Cookie** `__Host-tanbala_console` (`Secure; Path=/`, без `Domain`). На локальном HTTP — обычное имя, как у бота.
- **CSRF для SPA**:
  - Только `application/json`. Тогда браузер шлёт предварительный запрос, а CORS консоль не разрешает.
  - Заголовок `X-CSRF-Token` с токеном сессии (отдаёт `GET /api/session`).
  - Плюс та же проверка Origin, что `http.ts:68-79`.
  - Тело ограничено, как `server.ts:73-87`.
- **Сессии**:
  - Ограничение на число сессий у пользователя.
  - При смене пароля все его сессии удаляются.
  - Если сессии хранить в SQLite, класть только SHA-256 от ID.
- **Аудит**: вход, выход, неудача, действия. Без паролей, токенов, текстов и номеров, как `whatsapp/src/shared/logger.ts:45-87`.
- **Опасные действия** (поиск 2ГИС за деньги, ответ клиенту в WhatsApp): подтверждение в интерфейсе. Переключателя `TEST_MODE` в консоли нет вовсе.

---

## 3. Защищённые токеном эндпоинты в приложениях

**Почта сейчас.**
- Заголовок `X-Internal-Token`, токен от 32 символов, иначе API выключен. Сравнение `hmac.compare_digest` (`leads/tanbala_leads/web/internal.py:26-28`, `:90-94`).
- Токен проверяется зависимостью всего роутера, первым делом (`:145-153`). Ошибки фреймворка на `/internal` тоже сначала дают 401 (`:101-107`).
- `HostRules`: любой путь, похожий на `/internal`, пускается только с Host `127.0.0.1` или `localhost` (порт любой) и без заголовков прокси (`X-Forwarded-*`, `Forwarded`, `Via`). Иначе 400 ещё до токена (`app.py:94-97`, `:155-180`).
- `TrustedHostMiddleware`: 127.0.0.1, localhost и `PUBLIC_UI_HOST` (`app.py:206`). Имя из `PUBLIC_UI_HOST` с портом не пускается (`:174`).
- uvicorn без заголовков прокси (`:604`), слушает только 127.0.0.1 (`:609-610`). Caddy отвечает 404 на `/internal` (`deploy/Caddyfile:30-31`). Строка запроса в журнал не попадает (`internal.py:71-87`).

**Бот сейчас.**
- `PANEL_ALLOWED_HOSTS` разбирается в `whatsapp/src/config/env.ts:129`, `:173-178`.
- Host проверяется на каждом запросе. Всегда разрешены `127.0.0.1:3100` и `localhost:3100`. Домены разрешены, только если пароль не короче 16 символов (`guard.ts:73-100`).
- **JSON-эндпоинтов с токеном у бота нет.** Принимаются только HTML-формы, JSON получает 415 (`server.ts:77-87`). Все хуки корневые: вход, Origin и CSRF требуются на любом пути (`hooks.ts:143-165`).
- Блок `wa.tanbala.kz` в Caddy **не** закрывает `/internal` (`deploy/Caddyfile:12-23`).
- Бот уже умеет ходить к почте с токеном: `whatsapp/src/company-api/transport.ts:139-151` (`redirect: 'manual'`), `:181` (ограничение размера ответа). В конфиге отказ запускаться при включённом прокси Node, чтобы токен не ушёл наружу (`env.ts:156-157`).

**Рекомендуемая схема.**
- **Отдельный токен на каждое приложение**, отличный от `INTERNAL_API_TOKEN`.
  - Почему это обязательно: бот по nftables может ходить на 127.0.0.1:8000 (`tanbala-guard.nft:48`). С общим токеном взломанный бот получил бы все права консоли в почте.
  - Генерировать на сервере, 32 случайных байта (например, `openssl rand -hex 32`).
- **Заголовок** `X-Console-Token`, другой, чем `X-Internal-Token`, чтобы токены не перепутать. Сравнение за постоянное время: в почте `hmac.compare_digest`, в боте `constantTimeEqual` (`guard.ts:110-112`). Токен проверяется первым: 401 на любом пути, в том числе на несуществующем.
- **Почта**: роутер `/internal/console/...`. Он сам попадает под `HostRules` и под 404 в Caddy.
  - Нужна правка `framework_error` (`internal.py:101-107`): сейчас для всех путей `/internal` он сверяет токен бота, а должен выбирать токен по пути.
  - Тело JSON с пределом размера, как `MAX_BODY_BYTES` (`internal.py:29`).
- **Бот: два варианта**, выбирает владелец.
  - **(А, рекомендую)** Отдельный экземпляр fastify в том же процессе на `127.0.0.1:3101`. Только JSON и токен, без хуков панели. nftables: к 3101 только консоль, Caddy туда не дотянется ни при какой ошибке в Caddyfile.
  - **(Б)** Префикс `/internal/console/` на 3100. Тогда нужно:
    - исключения в `hooks.ts` для входа, Origin и CSRF;
    - разбор JSON только на этом префиксе;
    - отказ при Host не `127.0.0.1:3100` или при заголовках прокси, как `HostRules`;
    - правило `@internal → 404` в блоке wa. в Caddy.
- **Клиент в консоли**, по образцу `transport.ts`:
  - Host только `127.0.0.1:<порт>`, не localhost: тот может указать на `::1`, см. правило `EMAIL_API_URL` в `env.ts:152-153`;
  - `redirect: 'error'` или `'manual'`, таймаут, предел размера ответа;
  - отказ запускаться при `NODE_USE_ENV_PROXY`;
  - проверка ответа схемой (zod);
  - данные с чужих сайтов и из WhatsApp выводятся только с экранированием.
  - Имя пользователя консоли передаётся заголовком `X-Console-User` только для аудита, не для прав.

---

## 4. Память на сервере

**Замер сейчас:** всего 1967 МБ, занято 481, доступно 1485, в swap 243 МБ (из 4095). Бот не запущен, почта в простое: 32 МБ резидентно, остальное в swap.

**Оценки:**

| Режим | Состав | Итог |
| --- | --- | --- |
| Простой с ботом и консолью | 481 + бот 150–300 (`tanbala-whatsapp.service:40`) + консоль 50–80 + почта «проснулась» +130–230 | **0.7–1.1 ГБ занято**, доступно ≈ 0.9–1.3 ГБ, swap ≈ 0.2–0.3 ГБ |
| Пик поиска, замер на сервере 29.10, Chrome без окна (`tanbala-leads.service:38-40`) | система, Docker, Caddy ≈ 0.43 + служба почты ≈ 1.4 + Postgres ≈ 0.22 + Reacher ≈ 0.03 + бот 0.3 + консоль 0.08 | **≈ 2.5 ГБ** при 1.97 ГБ памяти: ≈ 0.6–0.8 ГБ уйдёт в swap |
| Пик по пессимистичным цифрам с Windows (`handover/B-web-email.md:81-83`: Chrome 1.0, Chromium 0.6 + драйвер 0.15, сервер 0.26) | то же, служба почты ≈ 2.0 | **≈ 3.1 ГБ**: ≈ 1.1–1.3 ГБ в swap; почта упрётся в `MemoryHigh=1600M`, поиск замедлится (было 107 с вместо 62) |

Консоль добавляет 2–3 % к пику. Сама по себе она погоды не делает.

**Что уйдёт в swap при поиске:**
- Простаивающая часть Chrome и Chromium. У службы почты своп не больше 1 ГБ (`MemorySwapMax=1G`), предел `MemoryHigh=1600M` / `MemoryMax=1900M`, при нехватке памяти она умирает первой (`OOMScoreAdjust=500`, `OOMPolicy=continue`, `tanbala-leads.service:46-52`).
- Неактивные страницы Postgres (`mem_limit: 512m`; без `memswap_limit` Docker разрешает ещё столько же swap), Reacher (`256m`), dockerd и containerd, Caddy, fail2ban, journald.
- Консоль сверх `MemoryLow`.

Первые 256 МБ бота защищены (`MemoryLow=256M`), он умирает последним (`OOMScoreAdjust=-300`). Консоли предлагаю `MemoryLow=48M`, `MemoryHigh=200M`, `MemoryMax=300M`, `OOMScoreAdjust=-100`. `MemoryLow` работает, только если cgroup2 смонтирована с `memory_recursiveprot`; проверить `mount | grep cgroup2`.

**Устаревшие комментарии «VPS 4 ГБ»:** `deploy/docker/compose.yml:28`, `leads/tanbala_leads/web/app.py:616`, `CLAUDE.md` (разделы «Сервер» и «Решения владельца»). Unit почты уже рассчитан на 2 ГБ (`tanbala-leads.service:43-45`, при 4 ГБ: 2300M/2700M).

---

## 5. Риски и что решает владелец

1. **Памяти 2 ГБ, а не 4.** Пик при поиске ≈ 2.5–3.1 ГБ, то есть больше физической памяти. По правилу владельца (сообщить, если пик больше 3 ГБ) это надо сказать ему сейчас. Решение за ним: оставить 2 ГБ со swap или поднять до 4 или 8 ГБ.
2. **Порт API бота**: отдельный 3101 (рекомендую) или префикс на 3100 (раздел 3).
3. **Сборка**: везти консоль собранной с ПК (рекомендую) или собирать на сервере.
4. **Режим Caddy.** Пароль panel не должен закрывать wa. и leads. (раздел 1.3). Нужна A-запись `panel.tanbala.kz` (делает владелец) и новый пароль Caddy через `open-panels.sh panel`.
5. **Переключение.**
   - Когда переходить на редиректы, 302 или 301.
   - Карта `/companies/{id}`: старые ссылки в WhatsApp-уведомлениях менеджеру должны работать.
   - Смена `EMAIL_UI_URL` у бота.
   - После переключения — очистка `PUBLIC_UI_HOST` и `PANEL_ALLOWED_HOSTS`, nftables для caddy только 3200.
6. **Пользователи и пароль.** Кто входит в консоль (только владелец или и менеджер), нужны ли роли. Пароль от 9 символов слабее, чем у бота (16) и у Caddy (20). Это приемлемо, только пока сверху стоит basic auth и ограничитель.
7. **Уже сейчас, по коду.** Интерфейс почты на 127.0.0.1:8000 открыт любому пользователю, которого туда пускает nftables. Бот пускается (`tanbala-guard.nft:48`). Host `127.0.0.1` разрешён (`app.py:90`, `:206`), `HostRules` ограничивает только `/internal` (`:169-174`). CSRF-токен один на процесс и виден на любой странице (`:198`, `:262`), а POST без Origin проходит (`:237`). Значит, взломанный бот может нажимать кнопки интерфейса почты, например запускать платный поиск (в пределах `DAILY_API_BUDGET_USD`). С консолью так же. Варианты: пускать интерфейс только по имени через Caddy или убрать старый интерфейс после этапа Б. Решает владелец.
8. **Платные действия из консоли** (поиск, проверки, тестовое письмо): только после «ок» владельца с оценкой стоимости. В тестах консоли — заглушки.
9. **Бот не запущен** до этапа 4 (`tanbala-whatsapp.service:27-30`). Раздел WhatsApp в консоли должен спокойно показывать «бот недоступен».
10. **fail2ban.** На «нет сессии» консоль не должна отвечать 401, иначе забанит владельца. Регулярку проверить `fail2ban-regex`.
11. **Порядок установки:** `system` (пользователь) → `configs` (nftables) → `leads`/`whatsapp` (эндпоинты и токены) → `console`. Токены нужно вписать в три `.env`. Владелец делает это сам, в чат их не выводить. В `.env` бота писать только от имени `tanbala-wa`, как `pair-whatsapp.sh:28`, `:43`.
12. **Проверить на сервере:**
    - отработала ли копия SQLite бота при `ProtectSystem=strict` (раздел 1.6);
    - не даёт ли `MEM_MIN_MB=200` в `health.sh` ложных сбоев во время поиска;
    - в каком режиме сейчас Caddy (`grep '^# РЕЖИМ: закрыто' /etc/caddy/Caddyfile`).