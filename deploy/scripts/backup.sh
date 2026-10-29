#!/usr/bin/env bash
# Резервная копия баз Tanbala: Postgres почты и SQLite бота, хранение 7 дней.
# Сессию WhatsApp не копируем (решение владельца 29.10.2026: восстановление сессии — это новый QR).
# Запуск: таймер tanbala-backup.timer (root) или вручную: sudo /opt/tanbala/deploy/scripts/backup.sh
# Копии: /var/backups/tanbala/postgres/*.dump и /var/backups/tanbala/whatsapp/*.db, доступ только у root.
set -euo pipefail
umask 077

BACKUP_ROOT=/var/backups/tanbala
KEEP_DAYS=7
PG_CONTAINER=tanbala-leads-postgres-1
WA_USER=tanbala-wa
WA_DB=/opt/tanbala/whatsapp/data/tanbala.db
STAMP=$(date +%F-%H%M)

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

[[ $EUID -eq 0 ]] || fail "запускать от root (sudo)"
install -d -m 700 "$BACKUP_ROOT" "$BACKUP_ROOT/postgres" "$BACKUP_ROOT/whatsapp"
# Временная папка, куда пишет пользователь бота: базу бота копирует он сам (см. ниже). В /tmp, а не в BACKUP_ROOT:
# в BACKUP_ROOT (права 700) пользователь бота не войдёт. Служба tanbala-backup идёт с PrivateTmp.
WA_TMP=$(mktemp -d /tmp/tanbala-wa-backup.XXXXXX)
trap 'rm -rf "$WA_TMP"; rm -f "$BACKUP_ROOT"/postgres/*.part "$BACKUP_ROOT"/whatsapp/*.part' EXIT

# 1. Postgres: pg_dump в формате custom, проверка, что архив читается, и только потом имя без .part.
pg_file="$BACKUP_ROOT/postgres/tanbala-$STAMP.dump"
docker exec "$PG_CONTAINER" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$pg_file.part"
docker exec -i "$PG_CONTAINER" pg_restore --list <"$pg_file.part" >/dev/null || fail "pg_restore не читает копию"
mv "$pg_file.part" "$pg_file"
printf 'Postgres: %s (%s)\n' "$pg_file" "$(du -h "$pg_file" | cut -f1)"

# 2. SQLite бота: .backup — целостная копия и при работающем боте (с учётом WAL). Копирует и проверяет пользователь
# бота: если бы базу открыл root, файлы -wal и -shm могли бы стать чужими для бота, а файлы в его папке root
# не открывает (там мог бы оказаться symlink). Копия переливается потоком в файл root.
if [[ -f $WA_DB ]]; then
	chown "$WA_USER:" "$WA_TMP"
	runuser -u "$WA_USER" -- sqlite3 "$WA_DB" ".backup '$WA_TMP/copy.db'"
	[[ $(runuser -u "$WA_USER" -- sqlite3 "$WA_TMP/copy.db" 'PRAGMA quick_check;') == ok ]] ||
		fail "копия базы бота не прошла quick_check"
	wa_file="$BACKUP_ROOT/whatsapp/tanbala-$STAMP.db"
	runuser -u "$WA_USER" -- cat "$WA_TMP/copy.db" >"$wa_file.part"
	mv "$wa_file.part" "$wa_file"
	printf 'База бота: %s (%s)\n' "$wa_file" "$(du -h "$wa_file" | cut -f1)"
else
	printf 'База бота не найдена (%s): бот ещё не запускался?\n' "$WA_DB"
fi

# 3. Копии старше 7 дней удаляются (каждую ночь новая, значит остаются 7 последних).
find "$BACKUP_ROOT/postgres" -name 'tanbala-*.dump' -mtime +$((KEEP_DAYS - 1)) -delete
find "$BACKUP_ROOT/whatsapp" -name 'tanbala-*.db' -mtime +$((KEEP_DAYS - 1)) -delete
printf 'Готово, копий: Postgres %s, бот %s\n' \
	"$(find "$BACKUP_ROOT/postgres" -name 'tanbala-*.dump' | wc -l)" \
	"$(find "$BACKUP_ROOT/whatsapp" -name 'tanbala-*.db' | wc -l)"
