# deploy: всё для сервера

Сервер PS.KZ, Ubuntu 24.04, 91.201.215.210. Подробная инструкция (обновление, перезапуск, логи) будет
в `handover/MERGE.md` на этапе 5.

| Файл | Куда на сервере | Что |
| --- | --- | --- |
| `scripts/install.sh` | запуск из архива | установка и обновление по шагам: `system`, `configs`, `caddy`, `db`, `leads`, `whatsapp`, `console` (описание в начале файла) |
| `Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS для wa.tanbala.kz (→ 3100) и leads.tanbala.kz (→ 8001), пароль Caddy на обоих, `/internal*` → 404; импортирует блок panel |
| `Caddyfile.closed` | `/etc/caddy/Caddyfile`, пока нет паролей Caddy для wa и leads | оба имени отвечают 503, сертификаты уже получаются; импортирует блок panel |
| `caddy/panel.caddy`, `caddy/panel.closed.caddy` | копия одного из них — `/etc/caddy/panel-site.caddy` | panel.tanbala.kz (→ 3200): пароль Caddy по строке на человека, `/internal*` → 404; без паролей — 503. Режим свой, от wa. и leads. не зависит |
| `scripts/open-panels.sh` | `/opt/tanbala/deploy/scripts/` | пароли Caddy и переход на рабочий `Caddyfile` одной командой; `panel add\|remove\|list <имя>` — люди с паролем Caddy для panel. (env.md) |
| `scripts/console-user.sh` | `/opt/tanbala/deploy/scripts/` | пользователи самой консоли (`user add <имя>`, `--help`): от имени `tanbala-console`, пароль без эха (env.md) |
| `scripts/pair-whatsapp.sh` | `/opt/tanbala/deploy/scripts/` | этап 4: привязка номера по QR и запуск службы бота одной командой (ниже) |
| `caddy/common.caddy`, `caddy/site.caddy` | `/opt/tanbala/deploy/caddy/`, их импортируют оба Caddyfile | общие настройки Caddy; сайт tanbala.kz (открыт всем) и www → tanbala.kz |
| `scripts/site.sh` | на ПК | новая версия сайта одной командой: сборка из последнего коммита `../A-site` и выкладка |
| `scripts/site-install.sh` | `/opt/tanbala/deploy/scripts/` | версия сайта в `/srv/tanbala-site/releases`, переключение `current`, 5 версий, `--rollback` |
| `systemd/tanbala-leads.service` | `/etc/systemd/system/` | внутренний API почты 127.0.0.1:8000 (бот и консоль) и старый интерфейс 127.0.0.1:8001 (только через Caddy) |
| `systemd/tanbala-whatsapp.service` | `/etc/systemd/system/` | бот, панель 127.0.0.1:3100 и API для консоли 127.0.0.1:3101; без привязанной сессии не стартует |
| `systemd/tanbala-console.service` | `/etc/systemd/system/` | консоль (единая панель), 127.0.0.1:3200; без `.env` не запускается |
| `systemd/tanbala-firewall.service`, `nftables/tanbala-guard.nft` | `/etc/systemd/system/`, `/opt/tanbala/deploy/nftables/` | куда службам можно внутри сервера: бот только в API почты (8000), консоль только в API почты и бота (8000, 3101) и больше никуда, Caddy только в панель бота, консоль и интерфейс почты (3100, 3200, 8001), браузеры почты не уходят на 127.0.0.1, в частные сети и метаданные облака; без этих правил службы не стартуют |
| `apt/52tanbala-unattended-chrome` | `/etc/apt/apt.conf.d/` | Google Chrome обновляется сам вместе с обновлениями безопасности |
| `systemd/tanbala-backup.{service,timer}` | `/etc/systemd/system/` | копия баз (Postgres, SQLite бота и консоли) каждую ночь в 03:30 |
| `systemd/tanbala-health.{service,timer}` | `/etc/systemd/system/` | проверка «всё живо» раз в 5 минут |
| `docker/compose.yml` | `/opt/tanbala/deploy/docker/` | Postgres и Reacher, только 127.0.0.1, лимиты памяти |
| `scripts/backup.sh`, `scripts/health.sh` | `/opt/tanbala/deploy/scripts/` | копии (7 дней) и проверка |
| `scripts/build-release.sh` | на ПК | архив кода из последнего коммита, консоль собирается тут же (`console/dist`, `console/web/dist`), и команда scp |
| `fail2ban/` | `/etc/fail2ban/filter.d/`, `jail.d/` | блок IP при подборе пароля Caddy (10 за 10 минут) и при неудачных входах в консоль (5 за 10 минут), на час |
| `logrotate/tanbala` | `/etc/logrotate.d/tanbala` | журналы расхода Claude API, раз в месяц, 12 штук |
| `journald/tanbala.conf` | `/etc/systemd/journald.conf.d/` | журнал systemd до 1 ГБ и месяца |
| `env.md` | — | какие строки `.env` поменять на сервере, пароли Caddy |

## Кто где

| Что | Где | Владелец |
| --- | --- | --- |
| почта (код, окружения, браузер crawl4ai, логи, `.env`) | `/opt/tanbala/leads` | root, группа `tanbala-leads`; служба пишет только в `data/`, `logs/`, `.crawl4ai/` |
| бот (код, `data/` с базой и сессией, `.env`) | `/opt/tanbala/whatsapp` | `tanbala-wa`; root внутри не пишет, `install.sh` обновляет код от имени бота |
| консоль (код, `node_modules`, сборка интерфейса, `.env`) | `/opt/tanbala/console` | root, группа `tanbala-console`; служба пишет только в `data/` (база пользователей, сессий, журнала) |
| временная папка `npm ci` консоли | `/tmp` во время шага `console` | `tanbala-build`: у `tanbala-console` нет выхода в интернет, а root чужие пакеты не распаковывает |
| эта папка | `/opt/tanbala/deploy` | root |
| сайт tanbala.kz (сборка A-site) | `/srv/tanbala-site/current` → `releases/<время>` | root, Caddy только читает |
| Postgres | том Docker `tanbala-leads_pgdata` | Docker (root) |
| копии баз | `/var/backups/tanbala` | root, права 700 |
| Node 22.23.2 | `/opt/node`, ссылка `/usr/local/bin/node` | root |

У пользователей служб нет sudo и нет группы docker (она даёт права root). Docker запускает root, с отдельным
`/etc/tanbala/compose.env` (env.md).

Права: `/opt/tanbala`, `/opt/tanbala/deploy` и его скрипты — root, без записи для группы и остальных (скрипты
запускает root, а Caddyfile импортирует `deploy/caddy/*.caddy`). Папки служб — права 750. Код, окружения и `.env`
почты — root (`.env` 640, группа службы), писать служба может только в `data/`, `logs/`, `.crawl4ai/` (владелец
`tanbala-leads`, root в них не пишет). Байткод: `python -m compileall`. У консоли так же: код и `node_modules` — root,
`.env` 640 с группой службы, писать можно только в `data/`.

Порядок: сначала Caddy и пользователи служб, потом `tanbala-firewall` (nft ищет пользователей по имени), потом
службы; консоль последней (её API в почте и боте). В ufw HTTP/3 (443/udp) не нужен: Caddy его не включает. Этот
порядок и права выполняет `install.sh`:

```bash
# ПК, Git Bash: архив из последнего коммита и отправка
bash deploy/scripts/build-release.sh && scp release/tanbala-<sha>.tar.gz ubuntu@91.201.215.210:~/
# сервер: распаковать и поставить (повтор безопасен; обновить только бота — шаг whatsapp, только консоль — console)
tar -xzf ~/tanbala-<sha>.tar.gz -C ~ && sudo bash ~/tanbala-<sha>/deploy/scripts/install.sh all
# после переноса .env почты (env.md): Postgres, Reacher и служба почты
sudo bash ~/tanbala-<sha>/deploy/scripts/install.sh db leads
```

## Бот: whatsapp/docs/DEPLOY.md на этом сервере

DEPLOY.md написан для отдельного сервера бота. Здесь имена и пути другие, а часть шагов уже сделана:

| В DEPLOY.md | Здесь |
| --- | --- |
| служба `tanbala` | `tanbala-whatsapp` (`deploy/systemd/tanbala-whatsapp.service`) |
| пользователь `tanbala`, вход `sudo -iu tanbala` | `tanbala-wa`, без входа и без домашней папки: `sudo -u tanbala-wa bash -c 'umask 077; cd /opt/tanbala/whatsapp && …'` |
| `~/app`, `/home/tanbala/app` | `/opt/tanbala/whatsapp` |
| шаги 1–4 (сервер, chrony, Node, код, сборка) | `install.sh system` и `install.sh whatsapp` |
| шаг 6 (Caddy), шаг 9 (служба) | `deploy/Caddyfile`, `deploy/systemd/tanbala-whatsapp.service`, ставит `install.sh configs` |
| шаг 11: ротация журнала токенов | уже в `/etc/logrotate.d/tanbala` вместе с журналом почты; файл из DEPLOY.md не ставить, он затёр бы этот |
| шаг 11: копия базы в `/home/tanbala/backups` | `tanbala-backup.timer`, копии в `/var/backups/tanbala/whatsapp`, 7 дней |
| шаг 11: обновление кода | `install.sh whatsapp` из нового архива (бот останавливается и запускается сам) |
| шаг 7 (проверка без WhatsApp) | сделан 30.10.2026 на коммите 99e60a1: база создана (схема 12), панель отвечает |
| шаг 8 (QR), шаг 9 (служба) | `pair-whatsapp.sh` (ниже), только по команде владельца |
| шаг 13 (рабочий режим) | этап 8, только по команде владельца; команды от `tanbala-wa` с `umask 077` |

Права на личные данные бота (сессия 700, база и `-wal`/`-shm` 600) служба выставляет сама при каждом запуске, даже
если файлы создала ручная привязка по QR; `health.sh` их проверяет.

## Этап 4: привязка бота по QR

Только по команде владельца, не больше двух попыток за 24 часа (их считает бот, неудачная тоже считается).

1. ПК: в окне «Tanbala bot (D-Email+WhatsApp)» нажать Ctrl+C, через несколько секунд закрыть окно. Бот остановлен,
   если в PowerShell `Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue` ничего
   не печатает.
2. Телефон: WhatsApp => Связанные устройства => устройство бота с ПК => Выйти. Бота на ПК больше не запускать.
3. ПК, окно PowerShell на весь экран:
   `ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/pair-whatsapp.sh`, ответить `да`.
   Скрипт проверит часы и `.env`, поставит `WA_ENABLED=true` и запустит бота в этом окне, QR появится здесь же.
4. Телефон: WhatsApp => Связанные устройства => Привязка устройства, навести камеру на QR.
5. Дождаться строк «Номер привязан», «Первая синхронизация: чатов записано в known_chats: N» и «Пропущено
   с запуска», нажать Ctrl+C один раз. Скрипт включит службу `tanbala-whatsapp` и запустит `health.sh`.

QR не сканируется с экрана: та же картинка лежит в `/opt/tanbala/whatsapp/data/qr.png`. Во втором окне PowerShell:

```powershell
[IO.File]::WriteAllBytes("$env:TEMP\qr.png", [Convert]::FromBase64String((ssh ubuntu@91.201.215.210 "sudo -u tanbala-wa base64 -w0 /opt/tanbala/whatsapp/data/qr.png"))); Start-Process "$env:TEMP\qr.png"
```

(QR сменяется, при неудаче повторить команду; после привязки `Remove-Item "$env:TEMP\qr.png"`.)

Не успели: бот остановится с `pairing_timeout`, попытка засчитана; следующую не сразу. Окно закрылось или пропала
связь: та же команда. Скрипт остановит бота, оставшегося от прошлого окна (до 2 минут); номер привязан — QR уже
не будет, скрипт только включит службу.

Открыто:

- Chromium для crawl4ai лежит в `leads/.browsers` и сам не обновляется: шаг `leads` ставит ту версию, что требует
  закреплённый playwright (обновлять вместе с ним или перевести crawl4ai на системный Chrome — решить отдельно).
- В `leads/requirements*.lock.txt` нет хэшей пакетов, а pip ставит их от root: если у автора пакета угонят аккаунт,
  подменённый файл той же версии пройдёт. Лечится в leads: `--generate-hashes` и установка с `--require-hashes`.

## Единая панель (console): выкладка

Консоль (`console/`, план — `console/docs/PLAN.md`) — служба `tanbala-console` на 127.0.0.1:3200, снаружи
panel.tanbala.kz. Данные и действия она берёт из API почты (127.0.0.1:8000, `/internal/console/*`) и бота
(127.0.0.1:3101) со своими токенами (`contract/CONSOLE_API.md`). Старый интерфейс почты уходит с 8000 на 8001,
wa. и leads. работают как прежде. Порядок первой выкладки (A-запись panel.tanbala.kz уже есть):

1. ПК: коммит, `bash deploy/scripts/build-release.sh` (соберёт и консоль), scp архива.
2. Сервер: `sudo bash ~/tanbala-<sha>/deploy/scripts/install.sh all`. Шаг `system` заведёт пользователей
   `tanbala-console` и `tanbala-build`, `configs` — nftables, службы, fail2ban и Caddy с panel. в режиме 503,
   `leads` — почту на 8000 и 8001, `whatsapp` — код бота (перезапускает его, только если он уже работал),
   `console` — код консоли (без `.env` не запускает). Между шагами `configs` и `leads` (несколько минут: pip и
   Chromium) leads.tanbala.kz отвечает 502: Caddy уже ходит на 8001, а старая почта слушает только 8000; если в это
   окно старая почта перезапустится, новый ключ `--ui-port` она не знает и ждёт шага `leads`.
3. Сервер: `.env` консоли и два новых токена в три `.env`, перезапуск почты и консоли — env.md, «Токены консоли».
4. Сервер: пользователь консоли для владельца:
   `ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/console-user.sh user add <имя>`.
5. Сервер: пароль Caddy для panel.: `sudo /opt/tanbala/deploy/scripts/open-panels.sh panel add <имя>` (проверит,
   что без пароля 401).
6. `sudo /opt/tanbala/deploy/scripts/health.sh`: консоль, оба API без токена 401, интерфейс почты на 8001, panel.

Обновление консоли потом: архив и `install.sh console` (служба перезапустится сама, `.env` и `data/` не трогаются).

## Переключение wa./leads. → panel (этап Б)

Сделано 31.10.2026 по «ок» владельца: оба Caddyfile (на сервере паролей wa. и leads. нет, там `Caddyfile.closed`),
`health.sh`, `EMAIL_UI_URL` бота. Ссылка `wa.tanbala.kz/chats/{id}` тоже ведёт на тот же чат в panel. Старые панели
работают на своих портах (3100, 8001), снаружи не видны.

1. `deploy/Caddyfile` (и `Caddyfile.closed`): блоки wa. и leads. — перенаправление на panel., сначала **302**, не
   301 (301 браузер запоминает навсегда, откат не сработал бы; на 301 — позже, по решению владельца). Пароль Caddy
   у старых имён больше не нужен. Старые ссылки из уведомлений менеджеру в WhatsApp
   (`EMAIL_UI_URL` + `/companies/{id}`) должны открывать ту же компанию в консоли:

   ```caddy
   wa.tanbala.kz {
   	import common
   	redir https://panel.tanbala.kz/ 302
   }

   leads.tanbala.kz {
   	import common
   	route {
   		@internal path_regexp internal (?i)(^|/)internal([/;]|$)
   		respond @internal 404
   		@card path_regexp card ^/companies/(\d{1,19})$
   		redir @card https://panel.tanbala.kz/companies/{re.card.1} 302
   		redir https://panel.tanbala.kz/ 302
   	}
   }
   ```

   `route` нужен: в стандартном порядке Caddy `redir` идёт раньше `respond`, и `/internal` ушёл бы в редирект.
   Путь карточки компании в консоли (`/companies/{id}`) сверить с роутером интерфейса (этап 3): если он другой,
   менять и карту, и `EMAIL_UI_URL` вместе.
2. `.env` бота: `EMAIL_UI_URL=https://panel.tanbala.kz` (от имени `tanbala-wa`), перезапуск бота.
3. `health.sh`: снаружи вместо 401 и 503 у wa. и leads. — 302, и Location ведёт на panel.
   (`curl -s -o /dev/null -w '%{http_code} %{redirect_url}'`, у `https://leads.tanbala.kz/companies/1` — на
   `https://panel.tanbala.kz/companies/1`); `https://leads.tanbala.kz/internal/lookup` — по-прежнему 404; ветка
   «закрыто до паролей» для wa. и leads. уходит. Проверки изнутри (8001, 3100) остаются, пока живы старые панели.

Потом, отдельным шагом и тоже по «ок»: удалить старые панели. Тогда у Caddy в nftables остаётся только 3200,
«остальным» — без 3100 и 8001; из `.env` уходят `PUBLIC_UI_HOST` (почта) и `PANEL_ALLOWED_HOSTS` (бот); файлы
`/etc/caddy/auth/wa.caddy` и `leads.caddy`, `caddy_file()` в `install.sh` и проверки 8001 и 3100 в `health.sh`
убираются.

## Рабочий режим бота (TEST_MODE=false)

Подготовлен 31.10.2026, включает только владелец, по своей команде. `deploy/scripts/working-mode.sh`:

```bash
ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh check   # условия, ничего не меняет
ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh on      # включить
ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh off     # откат в закрытый режим
```

`on` проверяет условия (номер привязан, флага «список чатов неполный» нет, список чатов не пуст, номера менеджера нет
в `TEST_ALLOWLIST`), делает копию баз, ставит `TEST_MODE=false` и перезапускает бота. Если бот отказался переходить,
скрипт сам возвращает `TEST_MODE=true`. Что будет со старыми чатами: `whatsapp/docs/DEPLOY.md`, раздел 13.

## Что ставится

Python 3.12 с venv, Node 22.23.2 (архив nodejs.org с проверкой суммы), Docker и compose (репозиторий Docker),
Google Chrome (репозиторий Google) для parser-2gis, Chromium для crawl4ai (Playwright в `leads/.browsers` и
системные библиотеки), Caddy (репозиторий Caddy), sqlite3 (копии баз бота и консоли), Xvfb — только если 2ГИС без
окна не работает. Консоль приезжает собранной с ПК, на сервере только её зависимости для работы (`npm ci
--omit=dev`, без install-скриптов).
