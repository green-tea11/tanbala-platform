#!/usr/bin/env bash
# Резервная копия баз Tanbala: Postgres почты, SQLite бота и SQLite консоли, хранение 7 дней.
# Сессию WhatsApp не копируем (решение владельца 29.10.2026: восстановление сессии — это новый QR).
# Запуск: таймер tanbala-backup.timer (root) или вручную: sudo /opt/tanbala/deploy/scripts/backup.sh
# Копии: /var/backups/tanbala/postgres/*.dump, whatsapp/*.db и console/*.db, доступ только у root.
set -euo pipefail
umask 077

BACKUP_ROOT=/var/backups/tanbala
KEEP_DAYS=7
PG_CONTAINER=tanbala-leads-postgres-1
WA_USER=tanbala-wa
WA_DB=/opt/tanbala/whatsapp/data/tanbala.db
CONSOLE_USER=tanbala-console
CONSOLE_DB=/opt/tanbala/console/data/console.db
STAMP=$(date +%F-%H%M)
TMP_DIRS=()

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

cleanup() {
	rm -rf "${TMP_DIRS[@]}"
	rm -f "$BACKUP_ROOT"/*/*.part
}

# Копии старше 7 дней (каждую ночь новая, значит остаются 7 последних). Только после удачной новой копии того же
# вида: если копии одной базы сломались, её старые копии не стираются, а остальные не копятся.
prune() { find "$1" -name "$2" -mtime +$((KEEP_DAYS - 1)) -delete; }

# SQLite приложения: .backup — целостная копия и при работающей службе (с учётом WAL). Копирует и проверяет
# пользователь службы: если бы базу открыл root, файлы -wal и -shm могли бы стать чужими для службы, а файлы в её
# папке root не открывает (там мог бы оказаться symlink). Копия переливается потоком в файл root.
# Временная папка в /tmp, а не в BACKUP_ROOT: туда (права 700) пользователь службы не войдёт. Служба tanbala-backup
# идёт с PrivateTmp. Сбой одной базы не мешает второй: функцию зовут через ||, set -e внутри не действует, поэтому
# каждый шаг проверяется сам.
backup_sqlite() {
	local label=$1 user=$2 db=$3 dir=$4 prefix=$5 tmp file
	if [[ ! -f $db ]]; then
		printf '%s: базы нет (%s), служба ещё не запускалась?\n' "$label" "$db"
		return 0
	fi
	tmp=$(mktemp -d "/tmp/$user-backup.XXXXXX") || return 1
	TMP_DIRS+=("$tmp")
	chown "$user:" "$tmp" || return 1
	if ! runuser -u "$user" -- sqlite3 "$db" ".backup '$tmp/copy.db'"; then
		printf 'ОШИБКА: %s: sqlite3 .backup не удался\n' "$label" >&2
		return 1
	fi
	if [[ $(runuser -u "$user" -- sqlite3 "$tmp/copy.db" 'PRAGMA quick_check;') != ok ]]; then
		printf 'ОШИБКА: %s: копия базы не прошла quick_check\n' "$label" >&2
		return 1
	fi
	file="$dir/$prefix-$STAMP.db"
	runuser -u "$user" -- cat "$tmp/copy.db" >"$file.part" || return 1
	mv "$file.part" "$file" || return 1
	printf '%s: %s (%s)\n' "$label" "$file" "$(du -h "$file" | cut -f1)"
	prune "$dir" "$prefix-*.db"
}

[[ $EUID -eq 0 ]] || fail "запускать от root (sudo)"
install -d -m 700 "$BACKUP_ROOT" "$BACKUP_ROOT/postgres" "$BACKUP_ROOT/whatsapp" "$BACKUP_ROOT/console"
trap cleanup EXIT
failed=0

# 1. Postgres: pg_dump в формате custom, проверка, что архив читается, и только потом имя без .part.
pg_file="$BACKUP_ROOT/postgres/tanbala-$STAMP.dump"
docker exec "$PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$pg_file.part"
docker exec -i "$PG_CONTAINER" pg_restore --list <"$pg_file.part" >/dev/null || fail "pg_restore не читает копию"
mv "$pg_file.part" "$pg_file"
printf 'Postgres: %s (%s)\n' "$pg_file" "$(du -h "$pg_file" | cut -f1)"
prune "$BACKUP_ROOT/postgres" 'tanbala-*.dump'

# 2. SQLite бота и консоли (у консоли пользователи, сессии, журнал действий).
backup_sqlite "База бота" "$WA_USER" "$WA_DB" "$BACKUP_ROOT/whatsapp" tanbala || failed=1
backup_sqlite "База консоли" "$CONSOLE_USER" "$CONSOLE_DB" "$BACKUP_ROOT/console" console || failed=1

printf 'Копий: Postgres %s, бот %s, консоль %s\n' \
	"$(find "$BACKUP_ROOT/postgres" -name 'tanbala-*.dump' | wc -l)" \
	"$(find "$BACKUP_ROOT/whatsapp" -name 'tanbala-*.db' | wc -l)" \
	"$(find "$BACKUP_ROOT/console" -name 'console-*.db' | wc -l)"
((!failed)) || fail "копия одной из баз SQLite не удалась (строки выше), её старые копии не тронуты"
