#!/usr/bin/env bash
# Рабочий режим бота (TEST_MODE=false): проверка условий, включение и откат. Включает только владелец, по своей
# команде (решение 31.10.2026: скрипт подготовлен, режим не включён). Запуск с ПК:
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh check   условия, ничего не меняет
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh on      включить
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/working-mode.sh off     откат в закрытый режим
# on: условия, копия баз (backup.sh), TEST_MODE=false, перезапуск бота, строки журнала о переходе. Если бот отказался
# («Рабочий режим (TEST_MODE=false) не включён»), скрипт сам возвращает TEST_MODE=true. Что будет со старыми чатами:
# whatsapp/docs/DEPLOY.md, раздел 13 (старые чаты ведёт менеджер, бот берёт тех, кто впервые напишет после включения).
set -euo pipefail

APP=/opt/tanbala/whatsapp
UNIT=tanbala-whatsapp
BOT=tanbala-wa
DB=$APP/data/tanbala.db
BACKUP=/opt/tanbala/deploy/scripts/backup.sh
BACKUP_DIR=/var/backups/tanbala/whatsapp
BACKUP_MAX_AGE_MIN=$((26 * 60))
# Сколько ждать после перезапуска, прежде чем читать журнал бота.
SETTLE_SEC=15

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

# Внутри папки бота всё от его имени: root там не читает и не пишет (ссылки, подложенные ботом), как в pair-whatsapp.sh.
as_bot() { setpriv --reuid="$BOT" --regid="$BOT" --init-groups --no-new-privs -- "$@"; }
env_count() { as_bot grep -c "^$1=" "$APP/.env" || true; }
# Значение переменной .env. Только для TEST_MODE, MANAGER_WHATSAPP и TEST_ALLOWLIST: секреты не читаются и не печатаются.
env_value() { as_bot grep -m1 "^$1=" "$APP/.env" | cut -d= -f2- | tr -d '\r' || true; }
state() { as_bot sqlite3 -readonly "$DB" "SELECT value FROM app_state WHERE key = '$1'"; }

problems=0
ok() { printf 'OK        %s\n' "$*"; }
bad() {
	printf 'СБОЙ      %s\n' "$*"
	problems=1
}
warn() { printf 'ВНИМАНИЕ  %s\n' "$*"; }

# Условия перехода (DEPLOY.md, раздел 13) и то, что бот проверит сам при запуске. Ничего не меняет.
check() {
	if systemctl is-active --quiet "$UNIT"; then ok "служба $UNIT работает"; else bad "служба $UNIT не работает"; fi
	if as_bot grep -qs '"me":' "$APP/data/whatsapp-session/creds.json"; then ok "номер привязан"; else bad "номер не привязан"; fi
	if [[ $(env_count TEST_MODE) == 1 ]]; then
		ok "в .env одна строка TEST_MODE (сейчас $(env_value TEST_MODE))"
	else
		bad "в $APP/.env должна быть ровно одна строка TEST_MODE"
	fi
	if [[ -n $(state linked_at_ms) ]]; then ok "момент привязки записан"; else bad "в базе нет момента привязки"; fi
	if [[ -z $(state history_incomplete_at_ms) ]]; then
		ok "флага «список чатов неполный» нет"
	else
		bad "в базе флаг «список чатов неполный»: бот откажется переходить (DEPLOY.md, раздел 13)"
	fi
	local known
	known=$(as_bot sqlite3 -readonly "$DB" 'SELECT count(*) FROM known_chats')
	if ((known > 0)); then ok "известных чатов рабочего номера: $known"; else bad "список чатов рабочего номера пуст"; fi
	local manager allowlist
	manager=$(env_value MANAGER_WHATSAPP)
	allowlist=$(env_value TEST_ALLOWLIST)
	if [[ -z $manager ]]; then
		warn "MANAGER_WHATSAPP пуст: уведомления о передаче будут только в панели"
	elif [[ ,$allowlist, == *",$manager,"* ]]; then
		bad "номер менеджера есть в TEST_ALLOWLIST: бот отвечал бы менеджеру как клиенту"
	else
		ok "номер менеджера задан и его нет в TEST_ALLOWLIST"
	fi
	local fresh
	fresh=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.db' -mmin -"$BACKUP_MAX_AGE_MIN" 2>/dev/null | head -1)
	if [[ -n $fresh ]]; then ok "свежая копия базы бота: $(basename "$fresh")"; else warn "копии базы бота за сутки нет (on её сделает)"; fi
}

# TEST_MODE=value в .env от имени бота, на месте (права и владелец файла не меняются), остальные строки не трогаются.
set_test_mode() {
	local value=$1
	as_bot bash -c 'new=$(sed "s/^TEST_MODE=.*/TEST_MODE=$2/" "$1") && printf "%s\n" "$new" >"$1"' _ "$APP/.env" "$value"
	[[ $(env_count TEST_MODE) == 1 && $(env_value TEST_MODE) == "$value" ]] || fail "TEST_MODE=$value не записан в $APP/.env"
}

# Перезапуск бота и его строки журнала о режиме с момента перезапуска.
restart_and_show() {
	local since
	since=$(date '+%Y-%m-%d %H:%M:%S')
	systemctl restart "$UNIT"
	sleep "$SETTLE_SEC"
	systemctl is-active --quiet "$UNIT" || printf 'Служба %s не работает: journalctl -u %s -n 50\n' "$UNIT" "$UNIT"
	journalctl -u "$UNIT" --since "$since" --no-pager -o cat |
		grep -oE '"msg":"(Запуск|Переход в рабочий режим|Рабочий режим|Закрытый режим)[^"]*"' | cut -d'"' -f4 || true
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
case "${1:-}" in
check)
	check
	exit "$problems"
	;;
on)
	check
	((problems == 0)) || fail "условия не выполнены, режим не включён"
	[[ $(env_value TEST_MODE) == true ]] || fail "TEST_MODE уже не true: рабочий режим включён раньше"
	"$BACKUP"
	set_test_mode false
	echo "TEST_MODE=false, перезапуск бота"
	out=$(restart_and_show)
	printf '%s\n' "$out"
	if grep -q 'не включён' <<<"$out" || ! grep -q 'рабочий режим' <<<"$out"; then
		echo "Бот не перешёл в рабочий режим: возвращаю TEST_MODE=true"
		set_test_mode true
		restart_and_show
		fail "рабочий режим не включён, бот снова в закрытом режиме; текст выше передайте разработчику"
	fi
	echo "Готово: рабочий режим включён. Откат: $0 off"
	;;
off)
	set_test_mode true
	echo "TEST_MODE=true, перезапуск бота"
	restart_and_show
	echo "Готово: закрытый режим, бот отвечает только номерам из TEST_ALLOWLIST"
	;;
*)
	fail "укажите check, on или off"
	;;
esac
