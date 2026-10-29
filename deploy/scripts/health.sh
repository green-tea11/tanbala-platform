#!/usr/bin/env bash
# Проверка «всё живо»: службы, контейнеры, оба сайта снаружи и изнутри, закрытый API, диск, память, свежесть копий.
# Запуск: таймер tanbala-health.timer раз в 5 минут (root) или вручную: sudo /opt/tanbala/deploy/scripts/health.sh
# Печатает OK или СБОЙ по каждому пункту. Код выхода 1, если есть сбой: systemd пометит запуск failed.
set -uo pipefail

LEADS=http://127.0.0.1:8000
PANEL=http://127.0.0.1:3100
BACKUP_ROOT=/var/backups/tanbala
BACKUP_MAX_AGE_MIN=$((26 * 60))
DISK_MAX_PERCENT=85
MEM_MIN_MB=200
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

for unit in docker caddy tanbala-leads tanbala-whatsapp; do
	if systemctl is-active --quiet "$unit"; then ok "служба $unit"; else bad "служба $unit не работает (journalctl -u $unit -n 50)"; fi
done
for unit in tanbala-leads tanbala-whatsapp; do
	restarts=$(systemctl show -p NRestarts --value "$unit" 2>/dev/null || echo 0)
	if ((restarts > RESTARTS_MAX)); then bad "служба $unit перезапускалась $restarts раз (journalctl -u $unit)"; fi
done

for container in tanbala-leads-postgres-1 tanbala-leads-reacher-1; do
	state=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo "нет контейнера")
	if [[ $state == healthy ]]; then ok "контейнер $container"; else bad "контейнер $container: $state"; fi
done

# Изнутри: главная почты читает базу; API без токена — 401 (жив и закрыт); вход в панель бота.
expect 200 "интерфейс почты отвечает и видит базу" "$LEADS/"
expect 401 "внутренний API жив и без токена закрыт" "$LEADS/internal/lookup?domain=example.kz"
expect 200 "панель бота отвечает" "$PANEL/login"

# Снаружи, через Caddy и настоящий сертификат: без пароля — 401, внутренний API — 404.
expect 401 "https://leads.tanbala.kz закрыт паролем" https://leads.tanbala.kz/
expect 404 "внутренний API снаружи не виден" https://leads.tanbala.kz/internal/lookup
expect 401 "https://wa.tanbala.kz закрыт паролем" https://wa.tanbala.kz/

disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if ((disk < DISK_MAX_PERCENT)); then ok "диск занят на $disk%"; else bad "диск занят на $disk% (df -h, journalctl --disk-usage)"; fi
mem=$(awk '/MemAvailable/ {print int($2 / 1024)}' /proc/meminfo)
if ((mem >= MEM_MIN_MB)); then ok "свободно памяти $mem МБ"; else bad "свободно памяти всего $mem МБ"; fi

latest=$(find "$BACKUP_ROOT/postgres" -name 'tanbala-*.dump' -mmin -"$BACKUP_MAX_AGE_MIN" 2>/dev/null | head -1)
if [[ -n $latest ]]; then ok "свежая копия базы: $(basename "$latest")"; else bad "нет копии базы моложе 26 часов (journalctl -u tanbala-backup)"; fi

exit "$failed"
