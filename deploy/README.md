# deploy: всё для сервера

Сервер PS.KZ, Ubuntu 24.04, 91.201.215.210. Подробная инструкция (обновление, перезапуск, логи) будет
в `handover/MERGE.md` на этапе 5.

| Файл | Куда на сервере | Что |
| --- | --- | --- |
| `Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS для wa.tanbala.kz и leads.tanbala.kz, пароль Caddy на обоих, `/internal*` → 404 |
| `systemd/tanbala-leads.service` | `/etc/systemd/system/` | интерфейс почты и внутренний API, 127.0.0.1:8000 |
| `systemd/tanbala-whatsapp.service` | `/etc/systemd/system/` | бот и панель, 127.0.0.1:3100; без привязанной сессии не стартует |
| `systemd/tanbala-firewall.service`, `nftables/tanbala-guard.nft` | `/etc/systemd/system/`, `/opt/tanbala/deploy/nftables/` | куда службам можно внутри сервера: бот только в API почты, Caddy только в две панели, браузеры почты не уходят на 127.0.0.1, в частные сети и метаданные облака; без этих правил службы не стартуют |
| `apt/52tanbala-unattended-chrome` | `/etc/apt/apt.conf.d/` | Google Chrome обновляется сам вместе с обновлениями безопасности |
| `systemd/tanbala-backup.{service,timer}` | `/etc/systemd/system/` | копия баз каждую ночь в 03:30 |
| `systemd/tanbala-health.{service,timer}` | `/etc/systemd/system/` | проверка «всё живо» раз в 5 минут |
| `docker/compose.yml` | `/opt/tanbala/deploy/docker/` | Postgres и Reacher, только 127.0.0.1, лимиты памяти |
| `scripts/backup.sh`, `scripts/health.sh` | `/opt/tanbala/deploy/scripts/` | копии (7 дней) и проверка |
| `scripts/build-release.sh` | на ПК | архив кода из последнего коммита и команда scp |
| `fail2ban/` | `/etc/fail2ban/filter.d/`, `jail.d/` | блок IP при подборе пароля Caddy |
| `logrotate/tanbala` | `/etc/logrotate.d/tanbala` | журналы расхода Claude API, раз в месяц, 12 штук |
| `journald/tanbala.conf` | `/etc/systemd/journald.conf.d/` | журнал systemd до 1 ГБ и месяца |
| `env.md` | — | какие строки `.env` поменять на сервере, пароли Caddy |

## Кто где

| Что | Где | Владелец |
| --- | --- | --- |
| почта (код, окружения, браузер crawl4ai, логи, `.env`) | `/opt/tanbala/leads` | `tanbala-leads`; служба пишет только в `data/`, `logs/`, `.crawl4ai/` (создать при установке) |
| бот (код, `data/` с базой и сессией, `.env`) | `/opt/tanbala/whatsapp` | `tanbala-wa` |
| эта папка | `/opt/tanbala/deploy` | root |
| Postgres | том Docker `tanbala-leads_pgdata` | Docker (root) |
| копии баз | `/var/backups/tanbala` | root, права 700 |
| Node 22.23.2 | `/opt/node`, ссылка `/usr/local/bin/node` | root |

У пользователей служб нет sudo и нет группы docker (она даёт права root). Docker запускает root, с отдельным
`/etc/tanbala/compose.env` (env.md).

Права: `/opt/tanbala`, `/opt/tanbala/deploy` и его скрипты — root, без записи для группы и остальных (скрипты
запускает root). Папки служб — права 750. Код и окружения почты — root, писать служба может только в `data/`,
`logs/`, `.crawl4ai/` (их создать при установке, владелец `tanbala-leads`). Байткод: `python -m compileall`.

Порядок: сначала Caddy и пользователи служб, потом `tanbala-firewall` (nft ищет пользователей по имени), потом
службы. В ufw HTTP/3 (443/udp) не нужен: Caddy его не включает.

Открыто: Chromium для crawl4ai лежит в `leads/.browsers` и сам не обновляется (обновлять вместе с playwright или
перевести crawl4ai на системный Chrome — решить отдельно).

## Что ставится

Python 3.12 с venv, Node 22.23.2 (архив nodejs.org с проверкой суммы), Docker и compose (репозиторий Docker),
Google Chrome (репозиторий Google) для parser-2gis, Chromium для crawl4ai (Playwright в `leads/.browsers` и
системные библиотеки), Caddy (репозиторий Caddy), sqlite3 (копия базы бота), Xvfb — только если 2ГИС без окна
не работает.
