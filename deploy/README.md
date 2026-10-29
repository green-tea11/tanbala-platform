# deploy: всё для сервера

Сервер PS.KZ, Ubuntu 24.04, 91.201.215.210. Подробная инструкция (обновление, перезапуск, логи) будет
в `handover/MERGE.md` на этапе 5.

| Файл | Куда на сервере | Что |
| --- | --- | --- |
| `scripts/install.sh` | запуск из архива | установка и обновление по шагам: `system`, `configs`, `caddy`, `db`, `leads`, `whatsapp` (описание в начале файла) |
| `Caddyfile` | `/etc/caddy/Caddyfile` | HTTPS для wa.tanbala.kz и leads.tanbala.kz, пароль Caddy на обоих, `/internal*` → 404 |
| `Caddyfile.closed` | `/etc/caddy/Caddyfile`, пока нет паролей Caddy | оба имени отвечают 503, сертификаты уже получаются |
| `scripts/open-panels.sh` | `/opt/tanbala/deploy/scripts/` | пароли Caddy и переход на рабочий `Caddyfile` одной командой (env.md) |
| `caddy/common.caddy`, `caddy/site.caddy` | `/opt/tanbala/deploy/caddy/`, их импортируют оба Caddyfile | общие настройки Caddy; сайт tanbala.kz (открыт всем) и www → tanbala.kz |
| `scripts/site.sh` | на ПК | новая версия сайта одной командой: сборка из последнего коммита `../A-site` и выкладка |
| `scripts/site-install.sh` | `/opt/tanbala/deploy/scripts/` | версия сайта в `/srv/tanbala-site/releases`, переключение `current`, 5 версий, `--rollback` |
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
| почта (код, окружения, браузер crawl4ai, логи, `.env`) | `/opt/tanbala/leads` | root, группа `tanbala-leads`; служба пишет только в `data/`, `logs/`, `.crawl4ai/` |
| бот (код, `data/` с базой и сессией, `.env`) | `/opt/tanbala/whatsapp` | `tanbala-wa`; root внутри не пишет, `install.sh` обновляет код от имени бота |
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
`tanbala-leads`, root в них не пишет). Байткод: `python -m compileall`.

Порядок: сначала Caddy и пользователи служб, потом `tanbala-firewall` (nft ищет пользователей по имени), потом
службы. В ufw HTTP/3 (443/udp) не нужен: Caddy его не включает. Этот порядок и права выполняет `install.sh`:

```bash
# ПК, Git Bash: архив из последнего коммита и отправка
bash deploy/scripts/build-release.sh && scp release/tanbala-<sha>.tar.gz ubuntu@91.201.215.210:~/
# сервер: распаковать и поставить (повтор безопасен; обновить только бота — шаг whatsapp)
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
| шаг 8 (QR), шаг 13 (рабочий режим) | этап 4 и дальше, только по команде владельца; команды от `tanbala-wa` с `umask 077` |

Права на личные данные бота (сессия 700, база и `-wal`/`-shm` 600) служба выставляет сама при каждом запуске, даже
если файлы создала ручная привязка по QR; `health.sh` их проверяет.

Открыто:

- Chromium для crawl4ai лежит в `leads/.browsers` и сам не обновляется: шаг `leads` ставит ту версию, что требует
  закреплённый playwright (обновлять вместе с ним или перевести crawl4ai на системный Chrome — решить отдельно).
- В `leads/requirements*.lock.txt` нет хэшей пакетов, а pip ставит их от root: если у автора пакета угонят аккаунт,
  подменённый файл той же версии пройдёт. Лечится в leads: `--generate-hashes` и установка с `--require-hashes`.

## Что ставится

Python 3.12 с venv, Node 22.23.2 (архив nodejs.org с проверкой суммы), Docker и compose (репозиторий Docker),
Google Chrome (репозиторий Google) для parser-2gis, Chromium для crawl4ai (Playwright в `leads/.browsers` и
системные библиотеки), Caddy (репозиторий Caddy), sqlite3 (копия базы бота), Xvfb — только если 2ГИС без окна
не работает.
