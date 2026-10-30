#!/usr/bin/env bash
# Проверка «всё живо»: службы, контейнеры, сайты снаружи и изнутри, закрытые API, диск, память, свежесть копий.
# Запуск: таймер tanbala-health.timer раз в 5 минут (root) или вручную: sudo /opt/tanbala/deploy/scripts/health.sh
# Печатает OK, СБОЙ или ПРОПУСК по каждому пункту. Код выхода 1, если есть сбой: systemd пометит запуск failed.
# До паролей Caddy wa. и leads. (Caddyfile.closed) отвечают 503, panel. — 503 до своих паролей (режим отдельный);
# до привязки по QR (этап 4) бот не проверяется, до .env консоли (токены, deploy/env.md) — консоль.
set -uo pipefail

# Почта: 8000 — только внутренний API (бот и консоль), 8001 — старый интерфейс (через Caddy).
LEADS=http://127.0.0.1:8000
LEADS_UI=http://127.0.0.1:8001
PANEL=http://127.0.0.1:3100
WA_CONSOLE_API=http://127.0.0.1:3101
CONSOLE=http://127.0.0.1:3200
WA_CREDS=/opt/tanbala/whatsapp/data/whatsapp-session/creds.json
CONSOLE_ENV=/opt/tanbala/console/.env
PANEL_SITE=/etc/caddy/panel-site.caddy
BACKUP_ROOT=/var/backups/tanbala
BACKUP_MAX_AGE_MIN=$((26 * 60))
DISK_MAX_PERCENT=85
# Запас памяти до OOM: MemAvailable + SwapFree. Только MemAvailable не годится: на 2 ГБ во время поиска (Chrome и
# Chromium почты, пик 2.5–3.1 ГБ) ядро штатно уводит 0.6–1.3 ГБ в swap, и MemAvailable падает до десятков МБ —
# прежний порог 200 МБ давал ложный СБОЙ на каждом поиске. Swap 4 ГБ: в простое запас ≈ 4.5–5 ГБ, в худший пик
# поиска ≈ 2.5 ГБ. Меньше 1 ГБ — swap почти съеден (утечка или что-то лишнее), следующий поиск может кончиться OOM.
# Если swap выключат, запас станет ≈ 1 ГБ и проверка будет мигать: на 2 ГБ без swap поиск и так не уместится.
MEM_MIN_MB=1024
RESTARTS_MAX=3

failed=0
ok() { printf 'OK    %s\n' "$*"; }
bad() {
	printf 'СБОЙ  %s\n' "$*"
	failed=1
}
# HTTP-код ответа или 000, если ответа нет (в том числе ошибка сертификата).
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@" || true; }
expect() {
	local want=$1 what=$2 got
	shift 2
	got=$(code "$@")
	if [[ $got == "$want" ]]; then ok "$what"; else bad "$what: ждали $want, пришло $got"; fi
}

skip() { printf 'ПРОПУСК %s\n' "$*"; }

# Бот привязан по QR: то же условие, что ExecStartPre его службы.
wa_linked=0
grep -qs '"me":' "$WA_CREDS" && wa_linked=1
# Консоль настроена: есть её .env (без него служба не запускается, ConditionPathExists).
console_ready=0
[[ -f $CONSOLE_ENV ]] && console_ready=1
units=(docker caddy tanbala-leads)
((console_ready)) && units+=(tanbala-console)
((wa_linked)) && units+=(tanbala-whatsapp)

for unit in "${units[@]}"; do
	if systemctl is-active --quiet "$unit"; then ok "служба $unit"; else bad "служба $unit не работает (journalctl -u $unit -n 50)"; fi
done
for unit in "${units[@]:2}"; do
	restarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)
	if ((restarts > RESTARTS_MAX)); then bad "служба $unit перезапускалась $restarts раз (journalctl -u $unit)"; fi
done

for container in tanbala-leads-postgres-1 tanbala-leads-reacher-1; do
	state=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null) || state="нет контейнера"
	if [[ $state == healthy ]]; then ok "контейнер $container"; else bad "контейнер $container: $state"; fi
done

# Изнутри. Почта: интерфейс на 8001 читает базу и не отдаёт /internal; на 8000 интерфейса нет, оба API без токена
# закрыты (401 — жив и закрыт). Консоль отвечает (/healthz без сессии, только «да/нет» по API почты и бота).
expect 200 "интерфейс почты отвечает и видит базу" "$LEADS_UI/"
expect 404 "интерфейс почты не отдаёт внутренний API" "$LEADS_UI/internal/lookup"
expect 404 "на порту API почты нет интерфейса" "$LEADS/"
expect 401 "внутренний API почты для бота жив и без токена закрыт" "$LEADS/internal/lookup?domain=example.kz"
expect 401 "API почты для консоли жив и без токена закрыт" "$LEADS/internal/console/summary"
if ((console_ready)); then
	expect 200 "консоль отвечает" "$CONSOLE/healthz"
else
	skip "нет $CONSOLE_ENV (deploy/env.md, «Токены консоли»): консоль не проверяется"
fi
if ((wa_linked)); then
	expect 200 "панель бота отвечает" "$PANEL/login"
	expect 401 "API бота для консоли жив и без токена закрыт" "$WA_CONSOLE_API/internal/console/status"
	# Личные данные бота: сессия только у бота, база и -wal/-shm без доступа для группы и остальных.
	open_files=$(find /opt/tanbala/whatsapp/data -maxdepth 1 \( -name whatsapp-session -o -name 'tanbala.db*' \) \
		-perm /077 2>/dev/null | head -3)
	if [[ -z $open_files ]]; then ok "права на сессию и базу бота"; else bad "открытые права: $open_files"; fi
else
	skip "бот не привязан по QR (этап 4): служба, панель и API бота не проверяются"
fi

# Снаружи, через Caddy и настоящий сертификат: без пароля — 401, внутренний API — 404. До паролей — 503 на всё.
if grep -q '^# РЕЖИМ: закрыто' /etc/caddy/Caddyfile; then
	expect 503 "https://leads.tanbala.kz закрыт до паролей Caddy" https://leads.tanbala.kz/
	expect 503 "внутренний API снаружи не виден" https://leads.tanbala.kz/internal/lookup
	expect 503 "https://wa.tanbala.kz закрыт до паролей Caddy" https://wa.tanbala.kz/
else
	expect 401 "https://leads.tanbala.kz закрыт паролем" https://leads.tanbala.kz/
	expect 404 "внутренний API снаружи не виден" https://leads.tanbala.kz/internal/lookup
	expect 401 "https://wa.tanbala.kz закрыт паролем" https://wa.tanbala.kz/
fi
# panel. — свой режим (install.sh, шаг caddy): закрыт (503), пока нет его паролей Caddy.
if grep -qs '^# РЕЖИМ: закрыто' "$PANEL_SITE"; then
	expect 503 "https://panel.tanbala.kz закрыт до паролей Caddy" https://panel.tanbala.kz/
else
	expect 401 "https://panel.tanbala.kz закрыт паролем" https://panel.tanbala.kz/
	expect 404 "служебные пути консоли снаружи не видны" https://panel.tanbala.kz/internal/x
fi
# Сайт открыт всем, www ведёт на основное имя.
expect 200 "сайт https://tanbala.kz открыт" https://tanbala.kz/
expect 301 "https://www.tanbala.kz ведёт на tanbala.kz" https://www.tanbala.kz/

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if ((disk < DISK_MAX_PERCENT)); then ok "диск занят на $disk%"; else bad "диск занят на $disk% (df -h, journalctl --disk-usage)"; fi
read -r mem swap < <(awk '/^MemAvailable:/ {m = int($2 / 1024)} /^SwapFree:/ {s = int($2 / 1024)} END {print m, s}' /proc/meminfo)
if ((mem + swap >= MEM_MIN_MB)); then
	ok "запас памяти $((mem + swap)) МБ (свободно $mem МБ, swap свободно $swap МБ)"
else
	bad "запас памяти всего $((mem + swap)) МБ (свободно $mem МБ, swap свободно $swap МБ): free -m, systemd-cgtop"
fi

# Самая новая из копий моложе 26 часов (по времени файла, а не первая попавшаяся).
latest=$(find "$BACKUP_ROOT/postgres" -name 'tanbala-*.dump' -mmin -"$BACKUP_MAX_AGE_MIN" -printf '%T@ %f\n' 2>/dev/null |
	sort -n | tail -n 1 | cut -d' ' -f2-)
if [[ -n $latest ]]; then ok "свежая копия базы: $latest"; else bad "нет копии базы моложе 26 часов (journalctl -u tanbala-backup)"; fi

exit "$failed"
