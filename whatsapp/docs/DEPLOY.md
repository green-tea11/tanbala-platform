# Запуск на VPS PS.KZ

Инструкция для владельца, по шагам. Обновлено: 29.10.2026. Составлена по коду проекта и на настоящем сервере не прогонялась: первый запуск делайте по порядку, проверки не пропускайте.

Схема: браузер => `https://panel.example.kz` => Caddy (порты 80 и 443, HTTPS) => панель на `127.0.0.1:3100`. Бот, WhatsApp и панель работают одним процессом под systemd. Снаружи открыты только порты 22, 80 и 443.

В примерах: администратор `admin` (с sudo), пользователь бота `tanbala` (без sudo), код в `/home/tanbala/app`, домен `panel.example.kz`, Node `22.23.2`. Подставьте свои значения. Команды с `sudo` выполняет администратор, остальные пользователь `tanbala` (войти `sudo -iu tanbala`, выйти `exit`).

## Перед началом

- VPS: Ubuntu Server LTS (24.04 или новее), x86_64, от 2 ГБ памяти и 20 ГБ диска.
- Домен или поддомен для панели и доступ к его DNS.
- SSH-ключ на вашем ПК (`ssh-keygen -t ed25519` в PowerShell).
- Ключи: `VENMART_ANTHROPIC_KEY`, для голосовых `OPENROUTER_API_KEY`.
- Телефон с рабочим номером под рукой: он нужен для QR.
- Решить заранее: домен панели, номер менеджера (`MANAGER_WHATSAPP`, можно пустым), свои номера для проверки (`TEST_ALLOWLIST`), переносить ли базу с ПК (по умолчанию нет, шаг 12).

## 1. Сервер

Войдите по SSH-ключу под администратором. Если хостер выдал только `root`, создайте `admin`:

```bash
# root
adduser admin && usermod -aG sudo admin
install -d -m 700 -o admin -g admin /home/admin/.ssh
install -m 600 -o admin -g admin ~/.ssh/authorized_keys /home/admin/.ssh/authorized_keys
```

Обновления и пакеты:

```bash
# администратор
sudo apt update && sudo apt upgrade -y
sudo apt install -y ufw chrony curl ca-certificates xz-utils git
```

Если есть файл `/var/run/reboot-required`, выполните `sudo reboot`.

Вход только по ключу. Сначала во втором окне проверьте, что `ssh admin@IP_СЕРВЕРА` пускает без пароля, и только потом:

```bash
# администратор
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf >/dev/null <<'EOF'
PasswordAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Время должно быть точным: код сравнивает время сообщений со временем привязки и простоя, при сбитых часах свежие сообщения сочтутся старыми. chrony ведёт время сам, `chronyc tracking | grep 'Leap status'` покажет `Normal`. На контейнерной виртуализации (LXC, OpenVZ) время ведёт хостер, chrony не нужен.

Файрвол. Порт 3100 не открываем: панель и так слушает только `127.0.0.1`. Исходящие соединения оставьте открытыми: нужны WhatsApp, Anthropic, OpenRouter и GitHub (версия WhatsApp Web). Если SSH у вас не на порту 22, откройте его вместо 22. Если у хостера есть внешний файрвол, откройте в нём те же порты.

```bash
# администратор
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Пользователь бота. Пароля у него нет, входят под ним через `sudo -iu tanbala`. `umask 077` закрывает его новые файлы от других пользователей: в базе и сессии личные данные.

```bash
# администратор
sudo adduser --disabled-password --gecos "" tanbala
echo 'umask 077' | sudo tee -a /home/tanbala/.profile
```

## 2. Node.js 22 LTS точной версии

Ставим ровно ту версию, на которой проект проверяется на ПК: `22.23.2` (`package.json` требует 22.12 или новее). Берём официальный архив nodejs.org и проверяем контрольную сумму. Скрипт «установить последнюю» не используем: версия не должна меняться сама.

```bash
# администратор
uname -m          # x86_64; для aarch64 в имени архива вместо x64 будет arm64
NODE_VERSION=22.23.2
cd /tmp
curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt
grep " node-v$NODE_VERSION-linux-x64.tar.xz\$" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /opt/node
sudo tar -xJf node-v$NODE_VERSION-linux-x64.tar.xz -C /opt/node --no-same-owner
sudo ln -sfn /opt/node/node-v$NODE_VERSION-linux-x64/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node/node-v$NODE_VERSION-linux-x64/bin/npm /usr/local/bin/npm
rm node-v$NODE_VERSION-linux-x64.tar.xz SHASUMS256.txt
node -v && npm -v
```

`sha256sum` должен ответить `OK`, `node -v` покажет `v22.23.2`. Смена версии Node: те же команды с новой `NODE_VERSION`, затем `sudo systemctl restart tanbala`.

## 3. Код

Сейчас в локальном репозитории не настроен удалённый адрес, поэтому основной путь: архив. В нём только закоммиченные файлы, то есть нет `.env`, `data/`, `node_modules/` и сессии WhatsApp.

Вариант А, архив. На ПК в папке проекта (PowerShell), после коммита:

```powershell
git archive --format=tar.gz -o $env:TEMP\tanbala.tar.gz HEAD
cd $env:TEMP
scp tanbala.tar.gz admin@IP_СЕРВЕРА:/tmp/
```

На сервере:

```bash
# администратор
sudo -iu tanbala bash -c 'mkdir -p ~/app && tar -xzf /tmp/tanbala.tar.gz -C ~/app'
sudo rm /tmp/tanbala.tar.gz
```

Вариант Б, `git clone`, когда репозиторий появится на GitHub или GitLab: `sudo -iu tanbala git clone АДРЕС_РЕПОЗИТОРИЯ app`. Для закрытого репозитория нужен ключ только для чтения (deploy key): создайте его под `tanbala` через `ssh-keygen -t ed25519` и добавьте `.pub` в настройки репозитория.

Не копируйте на сервер `node_modules/`, `.env`, `data/` (особенно `data/whatsapp-session/`).

## 4. Зависимости и сборка

```bash
# tanbala
cd ~/app
npm ci
npm run build
npm prune --omit=dev
mkdir -p data
node -e "require('better-sqlite3')(':memory:').close(); console.log('better-sqlite3 работает')"
ls dist/cli.js
```

- `.npmrc` отключает install-скрипты (`ignore-scripts=true`), требует точные версии и подходящий Node (`engine-strict=true`). Скрипты проекту не нужны: как и на ПК, достаточно `npm ci`.
- better-sqlite3 13.0.3 привозит готовый бинарник `prebuilds/linux-x64.node` внутри пакета (на ПК берётся `prebuilds/win32-x64.node`). Компиляторы, `node-gyp` и `npm rebuild` не нужны. Если проверка выдала ошибку, не ставьте компиляторы наугад, а пришлите текст ошибки разработчику.
- `npm prune --omit=dev` убирает инструменты сборки (TypeScript и другие): после `npm run build` они не нужны.

## 5. Настройки (.env)

```bash
# tanbala
cd ~/app
install -m 600 .env.example .env
nano .env
```

| Переменная | Значение на сервере |
|---|---|
| `VENMART_ANTHROPIC_KEY` | ключ Claude этого проекта. Без него бот только принимает сообщения и не отвечает |
| `OPENROUTER_API_KEY` | ключ для расшифровки голосовых. Пусто: голосовые не расшифровываются |
| `MANAGER_WHATSAPP` | номер менеджера `7XXXXXXXXXX`. Пусто: уведомления только в логе и в панели |
| `ADMIN_PASSWORD` | не короче 16 символов. Подойдёт `openssl rand -hex 16` (32 символа без спецзнаков). Сохраните в менеджере паролей |
| `PANEL_HOST` | `127.0.0.1` |
| `PANEL_PORT` | `3100` |
| `PANEL_ALLOWED_HOSTS` | `panel.example.kz`. В `.env.example` строка закомментирована, уберите `#`. Домен в нижнем регистре, без `https://` и без `/` |
| `TEST_MODE` | `true`. На `false` только по шагу 13, после теста на сервере |
| `TEST_ALLOWLIST` | ваши номера для проверки через запятую, формат `77XXXXXXXXX` (не номер бота и не номер менеджера) |
| `WA_ENABLED` | `false` до шага 8, там поменяйте на `true` |
| `INTERNAL_API_TOKEN` | токен внутреннего API почтового проекта, тот же, что в его `.env`, не короче 32 символов. Пусто: бот не определяет компанию клиента и работает как раньше. Пока проект B не запущен на этом сервере, оставьте пустым |
| `EMAIL_API_URL` | `http://127.0.0.1:8000` (адрес API проекта B на этом же сервере; только 127.0.0.1) |
| `EMAIL_UI_URL` | адрес интерфейса проекта B для ссылки на карточку компании в уведомлении менеджеру. Пусто: без ссылки. С телефона менеджера ссылка откроется, только если у интерфейса свой домен с HTTPS |

Остальное оставьте как в `.env.example`. Пути `WHATSAPP_SESSION_DIR`, `DATABASE_PATH` и `TOKEN_LOG_PATH` обязаны вести внутрь `data/`.

- Значения без кавычек и без пробелов вокруг `=`. После правки `.env` на работающей службе: `sudo systemctl restart tanbala`.
- Пароль короче 16 символов: домен из `PANEL_ALLOWED_HOSTS` не принимается, вход через Caddy закрыт (а при `PANEL_HOST` не `127.0.0.1` бот вовсе не запустится).
- Эти настройки задавайте только в `.env`. Не дублируйте их в unit-файле или `~/.profile`: `TEST_MODE`, `TEST_ALLOWLIST` и `WA_ENABLED` в окружении с другим значением, чем в `.env`, или при отсутствии строки в `.env` дают отказ в запуске.
- `.env` никуда не копируйте и не отправляйте.

## 6. Caddy и HTTPS

DNS: A-запись `panel.example.kz` на IP сервера. Проверка: `getent hosts panel.example.kz` покажет этот IP.

Установка Caddy из официального репозитория. Команды взяты из инструкции Caddy для Debian и Ubuntu (caddyserver.com/docs/install): если на сайте они изменились, следуйте сайту.

```bash
# администратор
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Настройка (шаблон `deploy/Caddyfile.example`):

```bash
# администратор
sudo cp /home/tanbala/app/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile        # замените panel.example.kz на свой домен
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -sI https://panel.example.kz | head -1
```

Caddy сам получит сертификат и включит HTTPS (нужны DNS и открытые порты 80 и 443). Пока бот не запущен, ответ `HTTP/2 502` нормален: важно, что нет ошибки сертификата. Если сертификат не выдался, смотрите `sudo journalctl -u caddy`, исправьте DNS или файрвол и только потом делайте `reload`: у Let's Encrypt есть лимиты на неудачные попытки.

В Caddyfile обязательно `127.0.0.1:3100`, а не `localhost`. Панель слушает только IPv4-адрес `127.0.0.1`, принимает соединения лишь с самого сервера, верит заголовкам `X-Forwarded-*` только от `127.0.0.1` и пускает домен только по HTTPS (по обычному HTTP ответ 403).

## 7. Проверка панели без WhatsApp

Пока `WA_ENABLED=false`, бот к WhatsApp не подключается. Проверим всё остальное, не тратя попытки привязки.

```bash
# tanbala
cd ~/app
node dist/cli.js
```

В логе (строки JSON) будут `Запуск: WhatsApp выключен, закрытый режим включён...` и `Веб-панель запущена: 127.0.0.1:3100`. Откройте `https://panel.example.kz`, войдите с `ADMIN_PASSWORD`: откроется пустой список чатов. После 5 неверных паролей вход закрывается на время до 10 минут. Остановите бота: Ctrl+C, в логе `Бот остановлен`.

Если бот не запустился, причина в stderr: `Бот не запущен: настройки не прошли проверку`, ниже названы переменные.

## 8. Привязка номера по QR

Делается один раз и только вручную, до включения службы.

Подготовка:

1. На ПК остановите бота (Ctrl+C). В телефоне: WhatsApp => Связанные устройства => устройство бота с ПК (по названию и времени активности) => Выйти. Иначе на номере будут работать два бота и клиенты получат по два ответа.
2. Папку сессии с ПК (`data/whatsapp-session/`) на сервер не копируйте: она даёт полный доступ к номеру, а после отвязки бесполезна.
3. Лимит: не больше 2 попыток привязки за скользящие 24 часа, третью запрещает код. Счётчик лежит в базе и в файле `.pairing-attempts.json` в корне проекта. На новом сервере он пуст. Если на ПК номер привязывали меньше суток назад, перенесите этот файл (в нём только время попыток), чтобы сервер учёл те попытки:

   ```powershell
   scp .\.pairing-attempts.json admin@IP_СЕРВЕРА:/tmp/
   ```

   ```bash
   sudo install -o tanbala -g tanbala -m 600 /tmp/.pairing-attempts.json /home/tanbala/app/.pairing-attempts.json && sudo rm /tmp/.pairing-attempts.json
   ```

4. В `.env` на сервере замените `WA_ENABLED=false` на `WA_ENABLED=true` (`nano ~/app/.env`).

Привязка. Нужен обычный интерактивный сеанс SSH и окно терминала побольше: QR рисуется символами. Запуск через `ssh сервер "команда"` без `-t` QR в терминале не покажет.

```bash
# tanbala
cd ~/app
node dist/cli.js
```

В телефоне: WhatsApp => Связанные устройства => Привязка устройства, отсканируйте QR. У QR мало времени: телефон держите наготове до запуска. Тот же QR кладётся в `data/qr.png` (права 600) и удаляется после привязки.

В логе по порядку должны появиться:

- `Начата привязка номера по QR`, `QR для привязки номера показан`
- `Номер привязан: граница старых сообщений обновлена`
- `Подключение к WhatsApp открыто`
- `Первая синхронизация: чатов записано в known_chats: N` (список чатов нужен для этапа 8)
- `Пропущено с запуска: ...` (обычно в течение минуты после подключения)

Дождитесь этих строк и остановите бота: Ctrl+C, в логе `Бот остановлен`.

Если QR не отсканирован вовремя, бот остановится с причиной `pairing_timeout`, попытка уже засчитана. Известный риск Baileys rc14 (ADR-0001): привязка проходит не всегда. Не повторяйте попытки подряд: WhatsApp наказывает частые неудачи блокировкой привязки. Когда лимит исчерпан, бот пишет `Привязка по QR запрещена: лимит попыток за 24 часа исчерпан` и время следующей попытки по Алматы.

## 9. Служба systemd

```bash
# администратор
sudo cp /home/tanbala/app/deploy/tanbala.service /etc/systemd/system/tanbala.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/tanbala.service
sudo systemctl enable --now tanbala
sudo systemctl status tanbala --no-pager
```

Перед этим убедитесь, что ручной запуск из шага 8 остановлен: второй экземпляр не стартует (`Бот уже запущен: папка данных занята другим процессом`).

Что задаёт `deploy/tanbala.service`:

- Работает от `tanbala`, стартует вместе с сервером.
- Не стартует, пока в `data/whatsapp-session/creds.json` нет привязанной сессии (`ExecStartPre`). Так под systemd бот никогда не начнёт привязку по QR сам и не потратит попытки.
- Перезапуск `Restart=on-failure` через 60 секунд. Код выхода 0 бывает только при штатной остановке (`systemctl stop`, перезагрузка), её не перезапускают. Любой сбой (ошибка в `.env`, WhatsApp остановился сам, необработанная ошибка) даёт код 1, и причину по нему systemd не отличает. Поэтому есть предел: не больше 4 запусков за 10 минут, затем `failed (start-limit-hit)`. Прочитайте лог, исправьте причину и выполните `sudo systemctl reset-failed tanbala && sudo systemctl start tanbala`.
- После `logged_out`, `replaced` и `forbidden` бот сам не переподключается (`src/whatsapp/reconnect.ts`), но systemd его перезапустит. Попытки привязки это не тратит (сессия на месте, привязка не начнётся), а предел оборвёт повторы. Чтобы перезапуска не было совсем, разработчику нужно дать этим причинам отдельный код выхода в `src/cli.ts` и добавить в службу `RestartPreventExitStatus`. Сейчас этого нет.
- Остановка (`systemctl stop`): бот доводит ответы в работе, до 120 секунд.

Что делать, когда WhatsApp остановился сам, смотрите в шаге 14.

## 10. Проверка после запуска

1. `sudo systemctl status tanbala --no-pager`: `active (running)`.
2. `sudo journalctl -u tanbala -n 40 -o cat`: есть `Подключение к WhatsApp открыто` и `Веб-панель запущена: 127.0.0.1:3100`.
3. `curl -sI https://panel.example.kz/login | head -1` отвечает `HTTP/2 200`, а `curl -sI http://panel.example.kz/login | head -1` ведёт на https (`308`).
4. Браузер: откройте панель, войдите с `ADMIN_PASSWORD`, увидите список чатов.
5. Порт 3100 снаружи закрыт. С ПК `Test-NetConnection IP_СЕРВЕРА -Port 3100` покажет `TcpTestSucceeded : False`. На сервере `ss -tln | grep 3100` покажет только `127.0.0.1:3100`.
6. С номера из `TEST_ALLOWLIST` напишите боту: придёт ответ, в логе будет `Сохранено входящее: чат #N`, чат появится в панели. Это реальный вызов Claude, он тратит кредиты (предохранитель `API_DAILY_LIMIT`). Сообщения с других номеров бот не читает и не сохраняет.
7. `sudo reboot`, через минуту повторите пункты 1 и 2: служба поднялась сама.

## 11. Обслуживание

Логи. Бот пишет строки JSON в журнал systemd, уровень в поле `level` (40 предупреждение, 50 ошибка, 60 критическая). Текста сообщений, номеров клиентов и ключей в логах нет. Размер журнала systemd ограничивает сам.

```bash
# администратор
sudo journalctl -u tanbala -f                                      # вживую
sudo journalctl -u tanbala --since today -o cat                    # за сегодня
sudo journalctl -u tanbala -o cat | grep -E '"level":(40|50|60)'   # предупреждения и ошибки
sudo journalctl -u caddy                                           # Caddy и сертификаты
```

Расход API: `tail -n 5 /home/tanbala/app/data/token-usage.jsonl`. При полном дневном лимите файл растёт примерно на 100 КБ в сутки. Ротация, по желанию:

```bash
# администратор
sudo tee /etc/logrotate.d/tanbala >/dev/null <<'EOF'
/home/tanbala/app/data/token-usage.jsonl {
    su tanbala tanbala
    monthly
    rotate 12
    compress
    missingok
    notifempty
    create 0600
}
EOF
sudo logrotate -d /etc/logrotate.d/tanbala
```

Резервная копия базы. Только `data/tanbala.db`: папку сессии `data/whatsapp-session/` и `.env` в копии не включаем. На работающем боте не копируйте файл базы обычным `cp`: часть данных ещё лежит в `tanbala.db-wal`. Команда ниже делает целостную копию:

```bash
# tanbala
install -d -m 700 ~/backups
cd ~/app
node -e "const d=require('better-sqlite3')('data/tanbala.db',{fileMustExist:true});d.backup('/home/tanbala/backups/tanbala-'+new Date().toISOString().slice(0,10)+'.db').then(()=>d.close())"
```

Ежедневно в 04:15 по времени сервера с хранением 14 дней (`crontab -e` под `tanbala`; в cron нужен полный путь к `node`):

```
15 4 * * * cd /home/tanbala/app && /usr/local/bin/node -e "const d=require('better-sqlite3')('data/tanbala.db',{fileMustExist:true});d.backup('/home/tanbala/backups/tanbala-'+new Date().toISOString().slice(0,10)+'.db').then(()=>d.close())" && find /home/tanbala/backups -name 'tanbala-*.db' -mtime +14 -delete
```

В базе переписки клиентов, это персональные данные: храните копии на сервере или на своём ПК в Казахстане, в зарубежные облака и почту не отправляйте.

Восстановление из копии:

```bash
# администратор
sudo systemctl stop tanbala
sudo -u tanbala rm -f /home/tanbala/app/data/tanbala.db-wal /home/tanbala/app/data/tanbala.db-shm
sudo -u tanbala install -m 600 /home/tanbala/backups/tanbala-2026-10-26.db /home/tanbala/app/data/tanbala.db
sudo systemctl start tanbala
```

Обновление версии. Сначала сделайте копию базы (команда выше), затем:

```bash
# администратор
sudo systemctl stop tanbala
# новый код, одно из двух. Вариант А: новый архив в /tmp (как в шаге 3), затем
sudo -iu tanbala bash -c 'tar -xzf /tmp/tanbala.tar.gz -C ~/app'
# вариант Б: sudo -iu tanbala bash -c 'cd ~/app && git pull --ff-only'
sudo -iu tanbala bash -c 'cd ~/app && npm ci && npm run build && npm prune --omit=dev'
sudo systemctl start tanbala
sudo journalctl -u tanbala -n 30 -o cat
```

Миграции базы выполняются сами при запуске и необратимы: если откатываете код на старую версию, верните и базу из копии, сделанной перед обновлением. Node, Baileys и другие зависимости обновляйте осознанно, отдельным шагом и после проверки.

## 12. Перенос базы с ПК (необязательно, решает владелец)

По умолчанию не нужен: на ПК лежат тестовые переписки со своих номеров, а список чатов сервер соберёт сам при привязке. Переносите, только если хотите сохранить тестовые карточки и статусы.

Правила: переносить только до привязки номера на сервере (шаг 8), код на сервере не должен быть старше, чем на ПК. После привязки заменять базу на сервере нельзя: в ней момент привязки и список чатов для этапа 8. Вместе с базой приедут и попытки привязки с ПК, они учтутся в лимите 2 за 24 часа (тогда `.pairing-attempts.json` из шага 8 переносить не нужно).

На ПК (PowerShell, в папке проекта, бот остановлен) делаем целостную копию и отправляем её:

```powershell
node -e "const d=require('better-sqlite3')('data/tanbala.db',{fileMustExist:true});d.backup('pc-copy.db').then(()=>d.close())"
scp .\pc-copy.db admin@IP_СЕРВЕРА:/tmp/
Remove-Item .\pc-copy.db
```

На сервере (шаг 7 мог создать пустую базу, её заменяем):

```bash
# администратор
sudo systemctl stop tanbala    # если служба уже создана
sudo -u tanbala rm -f /home/tanbala/app/data/tanbala.db-wal /home/tanbala/app/data/tanbala.db-shm
sudo install -o tanbala -g tanbala -m 600 /tmp/pc-copy.db /home/tanbala/app/data/tanbala.db
sudo rm /tmp/pc-copy.db
```

## 13. Закрытый режим и рабочий режим

Пока `TEST_MODE=true`, бот отвечает только номерам из `TEST_ALLOWLIST`, остальные чаты не читает и не трогает, но запоминает их номера и время последней активности (без текста). По этому списку при переходе бот поймёт, какие чаты были на номере раньше (правило из `CLAUDE.md`: старые чаты ведёт менеджер, бот берёт только тех, кто впервые напишет после переключения). Чтобы список был полным:

- привяжите номер на сервере один раз и не откладывая: с момента привязки бот копит список чатов;
- после привязки не удаляйте и не заменяйте `data/tanbala.db`;
- если в логе есть `Чаты первой синхронизации записаны не все`, сообщите разработчику: в базе стоит флаг «список чатов неполный», и бот откажется переходить;
- то же, если проба бизнес-профиля (`npm run probe:business`) написала, что поставила этот флаг: проба подключается тем же устройством, что бот, и забирает сообщения, пришедшие пока бот остановлен.

### Переход в рабочий режим (этап 8)

Условия, все до одного:

1. Тест на сервере пройден (шаг 10): с номеров из `TEST_ALLOWLIST` бот отвечает, передача менеджеру и «Вернуть боту» в панели работают.
2. Номер привязан на этом сервере, в логе была строка `Первая синхронизация: чатов записано в known_chats: N`. Без неё (список чатов пуст) бот сам не запустится в рабочем режиме.
3. Флага «список чатов неполный» нет (см. выше). Если он есть, бот сам не запустится в рабочем режиме.
4. Менеджеры предупреждены: с переключения бот отвечает всем, кто напишет впервые; старые чаты остаются за ними, бот в них молчит; любой такой чат можно отдать боту кнопкой «Вернуть боту»; если в чат бота написать с телефона или из панели, бот в нём замолкает.
5. Сделана копия базы (шаг 11).

Шаги:

```bash
# tanbala
nano ~/app/.env                       # TEST_MODE=false, остальное не трогать
# администратор
sudo systemctl restart tanbala
sudo journalctl -u tanbala -n 40 -o cat
```

В логе должны быть `Запуск: WhatsApp включён, рабочий режим: бот отвечает новым чатам, номеров в TEST_ALLOWLIST: N` и один раз `Переход в рабочий режим: граница записана, у менеджера адресов известных чатов A, чатов из базы переведено к менеджеру B`. При следующих перезапусках вместо второй строки будет `Рабочий режим: переход уже был, граница не меняется`. Если список чатов пуст (первая синхронизация не пришла), бот в рабочем режиме не запустится, см. ниже.

Если бот не запустился и пишет `Рабочий режим (TEST_MODE=false) не включён: ...`, в базе ничего не записано. Верните `TEST_MODE=true`, перезапустите и передайте текст разработчику.

Что происходит со старыми чатами:

- Момент переключения записывается в базу (граница).
- Все чаты, которые были на номере до переключения (список первой синхронизации и всё, что приходило после привязки), ведёт менеджер. Когда такой клиент пишет, чат появляется в панели со статусом «Ведёт менеджер (написал с телефона)», бот молчит, уведомления менеджеру нет: это его прежние чаты.
- После «Вернуть боту» бот отвечает на сообщения клиента, пришедшие после переключения и не старше 12 часов. На сообщения до переключения бот не отвечает.
- Сообщения чатов не из `TEST_ALLOWLIST`, отправленные до переключения (например, пока бот перезапускался), бот пропускает: в сводке `Пропущено с запуска` они идут как `before_link`.
- Номера из `TEST_ALLOWLIST` работают как раньше.
- Новая привязка по QR при `TEST_MODE=false` (например, сессию отозвали в телефоне): граница прежняя. Сообщений новой синхронизации бот не видит и не знает, кто отвечал клиентам в перерыве, поэтому все чаты этой синхронизации ведёт менеджер, в том числе чаты, которые вёл бот (кроме номеров `TEST_ALLOWLIST`). В логе `Синхронизация в рабочем режиме: чатов бота переведено к менеджеру N`. Нужные чаты менеджер возвращает боту.
- Так задано по умолчанию, до решения владельца. Сузить правило (например, менеджеру только чаты с перепиской за последние N дней) можно правкой одной функции `startsWithManager` в `src/pipeline/working-mode.ts`.

Откат: `TEST_MODE=true` в `.env` и `sudo systemctl restart tanbala`. В логе `Закрытый режим: граница рабочего режима снята`. Чаты, которые бот успел взять, остаются в базе, но в закрытом режиме бот им не отвечает. Повторное включение `TEST_MODE=false` снова переход с новой границей: все чаты не из `TEST_ALLOWLIST`, в том числе те, что вёл бот, уходят менеджеру, потому что в закрытом режиме бот не видел, ответил ли им человек. Нужные чаты менеджер возвращает боту.

Первый час после переключения:

- Панель: новые чаты со статусом «Ведёт бот» и ответы бота в них; старые клиенты со статусом «Ведёт менеджер»; уведомления о передаче.
- Лог: `sudo journalctl -u tanbala -f -o cat`. Нормально: `Сохранено входящее: чат #N`, `Новый чат был на рабочем номере до перехода в рабочий режим: ведёт менеджер, чат #N`, в сводке `before_link`. Предупреждения и ошибки: `sudo journalctl -u tanbala -o cat | grep -E '"level":(40|50|60)'`.
- Расход: `tail -n 5 ~/app/data/token-usage.jsonl` (предохранитель `API_DAILY_LIMIT`).
- Бот ответил клиенту, которого вёл менеджер: менеджер пишет в чат с телефона (бот там замолкает), сообщите разработчику; при сомнениях откат.
- Пробу `npm run probe:business` в рабочем режиме не запускайте: она забирает сообщения, пришедшие пока бот остановлен, и бот на них не ответит.

## 14. Если что-то пошло не так

| Что видите | Что делать |
|---|---|
| `Бот не запущен: настройки не прошли проверку` | В `.env` ошибка, ниже названа переменная. Исправьте и `sudo systemctl restart tanbala` |
| `Бот уже запущен: папка данных занята другим процессом` | Работает второй экземпляр, например ручной запуск при службе. Остановите лишний |
| `failed (start-limit-hit)` | 4 сбоя за 10 минут. Прочитайте лог, исправьте причину, затем `sudo systemctl reset-failed tanbala && sudo systemctl start tanbala` |
| `ExecStartPre ... status=1` или `status=2` | Нет привязанной сессии (нет `creds.json` с ключом `me`). Пройдите шаг 8 |
| `status=226/NAMESPACE` | Хостер не даёт песочницу. Закомментируйте строки песочницы в `tanbala.service`, затем `daemon-reload` и `restart` |
| Панель: 403, в логе `запрос с чужим заголовком Host отклонён` | `PANEL_ALLOWED_HOSTS` не совпадает с доменом или `ADMIN_PASSWORD` короче 16 символов. Исправьте `.env`, перезапустите |
| Панель: 403, в логе `запрос к домену по HTTP отклонён, на VPS только HTTPS` | Откройте по `https://`. Caddy должен стоять на этом же сервере и ходить на `127.0.0.1:3100` |
| Панель: 403, в логе `соединение не с этого компьютера отклонено` | К панели идёт не локальный Caddy. В Caddyfile должно быть `reverse_proxy 127.0.0.1:3100` |
| Нет сертификата, в `journalctl -u caddy` ошибки ACME | DNS не ведёт на сервер или закрыт порт 80 или 443. Исправьте, затем `sudo systemctl reload caddy` |
| `Привязка по QR запрещена: лимит попыток за 24 часа исчерпан` | Ждите время из сообщения (по Алматы). Лимит не обходить |
| `WhatsApp остановлен: сессия отозвана в телефоне` (`logged_out`) | Устройство отвязано в телефоне. `sudo systemctl stop tanbala`, удалите `data/whatsapp-session/`, снова шаг 8 (учтите лимит попыток) |
| `...подключён в другом месте` (`replaced`) или `...отказал в доступе (код 403)` (`forbidden`) | Найдите вторую копию с этой сессией или проверьте номер в телефоне (возможна блокировка). Службу остановите и не перезапускайте подряд |
| `...привязка не завершена` (`pairing_timeout`) | QR не отсканирован вовремя, попытка засчитана. Повторите шаг 8 вручную позже |
| `...отклонил версию клиента` (`version_rejected`) | Нужно обновить Baileys: передайте разработчику |
| `...переподключиться не удалось`, `...сессия не сохранилась`, `...сбой при разборе или записи` (`gave_up`, `reconnect_failed`, `session_save_failed`, `handler_failed`) | Проверьте сеть и место на диске (`df -h`), затем `sudo systemctl restart tanbala` |
| `Номер уже привязан, но в базе нет момента привязки` | База потеряна или подменена. Восстановите её из копии или привяжите номер заново |
| `Рабочий режим (TEST_MODE=false) не включён: ...` | Номер не привязан или в базе флаг «список чатов неполный». В базе ничего не записано. Верните `TEST_MODE=true`, перезапустите, передайте текст разработчику (шаг 13) |
| `Рабочий режим (TEST_MODE=false) не включён: список чатов рабочего номера пуст` | Первая синхронизация WhatsApp ещё не пришла. В базе ничего не записано. Верните `TEST_MODE=true`, перезапустите, дождитесь в логе `Первая синхронизация: чатов записано в known_chats: N` и переключайте снова. Если строка уже была, передайте текст разработчику |

## Где что лежит

| Что | Где | Заметка |
|---|---|---|
| Код | `/home/tanbala/app` | сборка в `dist/` |
| Ключи и пароль | `/home/tanbala/app/.env` | права 600, секрет |
| Сессия WhatsApp | `/home/tanbala/app/data/whatsapp-session/` | полный доступ к номеру, не копировать |
| База с перепиской | `/home/tanbala/app/data/tanbala.db` (и `-wal`, `-shm`) | персональные данные, только Казахстан |
| Счётчик привязок | `/home/tanbala/app/.pairing-attempts.json` | только время попыток |
| Лог расхода API | `/home/tanbala/app/data/token-usage.jsonl` | токены без текстов |
| Копии базы | `/home/tanbala/backups` | те же персональные данные |
| Служба | `/etc/systemd/system/tanbala.service` | шаблон `deploy/tanbala.service` |
| Caddy | `/etc/caddy/Caddyfile` | шаблон `deploy/Caddyfile.example` |
