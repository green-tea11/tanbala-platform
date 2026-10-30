#!/usr/bin/env bash
# Этап 4: привязка номера WhatsApp к боту на сервере по QR и запуск его службы. Только по команде владельца.
# Перед запуском: бот на ПК остановлен, в телефоне устройство бота с ПК отвязано (WhatsApp => Связанные устройства).
# Запуск с ПК в развёрнутом на весь экран окне PowerShell (QR рисуется символами):
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/pair-whatsapp.sh
# Бот запускается в этом окне от tanbala-wa и печатает QR. Номер привязан и в журнале есть «Первая синхронизация»
# и «Пропущено с запуска» — Ctrl+C: бот остановится, скрипт включит службу tanbala-whatsapp и проверит, что всё живо.
# Номер уже привязан (например, окно закрылось до Ctrl+C): QR не будет, скрипт только включит службу.
# Попыток привязки не больше двух за 24 часа, их считает сам бот; неудачная тоже считается.
set -euo pipefail

APP=/opt/tanbala/whatsapp
UNIT=tanbala-whatsapp
BOT=tanbala-wa
SERVER=ubuntu@91.201.215.210
# Сколько ждать после запуска службы, прежде чем проверять панель бота.
SETTLE_SEC=20
# Сколько ждать штатной остановки бота, оставшегося от прошлого запуска (он доводит ответы до 2 минут).
STOP_WAIT_SEC=130

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

# Внутри папки бота всё делается от его имени: root там не читает и не пишет (ссылки, подложенные ботом).
# setpriv, а не runuser: тот после Ctrl+C через 2 секунды убивает бота, не дав ему дописать сессию и базу.
as_bot() { setpriv --reuid="$BOT" --regid="$BOT" --init-groups --no-new-privs -- "$@"; }
linked() { as_bot grep -qs '"me":' "$APP/data/whatsapp-session/creds.json"; }
env_has() { as_bot grep -qx "$1" "$APP/.env"; }
env_count() { as_bot grep -c "^$1=" "$APP/.env" || true; }

# WA_ENABLED и TEST_MODE: ровно по одной строке (при двух бот взял бы не ту), TEST_MODE только закрытый.
check_env() {
	[[ $(env_count WA_ENABLED) == 1 ]] && { env_has 'WA_ENABLED=true' || env_has 'WA_ENABLED=false'; } ||
		fail "в $APP/.env должна быть одна строка WA_ENABLED=true или WA_ENABLED=false"
	[[ $(env_count TEST_MODE) == 1 ]] && env_has 'TEST_MODE=true' ||
		fail "в $APP/.env должна быть одна строка TEST_MODE=true: до команды владельца бот только в закрытом режиме"
}

# WA_ENABLED только из .env (бот не стартует, если он задан и в окружении процесса); права файла sed сохраняет.
enable_whatsapp() {
	env_has 'WA_ENABLED=true' || as_bot sed -i 's/^WA_ENABLED=false$/WA_ENABLED=true/' "$APP/.env"
	env_has 'WA_ENABLED=true' || fail "не удалось поставить WA_ENABLED=true в $APP/.env"
}

# Держит ли процесс базу бота открытой. Только ссылки в /proc, в папку бота root не заходит.
holds_db() { ls -l "/proc/$1/fd" 2>/dev/null | grep -qF "$APP/data/tanbala.db"; }

# Бот, запущенный вручную и оставшийся после оборванного окна, держит замок: остановить штатно (SIGINT).
# После закрытого окна бот доводит остановку, но выйти может не суметь: вывод в потерянный терминал sudo висит.
# База закрыта — остановка дошла до конца, процесс добивается сразу; иначе через STOP_WAIT_SEC, как у systemd.
stop_leftover_bot() {
	local pid waited=0
	pgrep -u "$BOT" -x node >/dev/null || return 0
	echo "Бот запущен вручную (прошлое окно?): останавливаю его штатно, до $STOP_WAIT_SEC секунд."
	pkill -INT -u "$BOT" -x node || true
	while pgrep -u "$BOT" -x node >/dev/null; do
		sleep 1
		waited=$((waited + 1))
		for pid in $(pgrep -u "$BOT" -x node); do
			if ! holds_db "$pid" || ((waited >= STOP_WAIT_SEC)); then kill -KILL "$pid" 2>/dev/null || true; fi
		done
	done
}

start_service() {
	enable_whatsapp
	systemctl reset-failed "$UNIT" 2>/dev/null || true
	systemctl enable --now "$UNIT"
	echo "Служба $UNIT запущена и стартует сама после перезагрузки. Проверка через $SETTLE_SEC секунд:"
	sleep "$SETTLE_SEC"
	systemctl is-active --quiet "$UNIT" || fail "служба $UNIT не работает: journalctl -u $UNIT -n 50"
	exec /opt/tanbala/deploy/scripts/health.sh
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
[[ -t 0 && -t 1 ]] || fail "нужен терминал для QR: ssh -t $SERVER sudo $0"
! systemctl is-active --quiet "$UNIT" || fail "служба $UNIT уже работает: systemctl status $UNIT"
stop_leftover_bot
check_env
if linked; then
	echo "Номер уже привязан: QR не нужен."
	start_service
fi
systemctl is-active --quiet tanbala-firewall || fail "нет правил nftables для бота: systemctl start tanbala-firewall"
chronyc tracking 2>/dev/null | grep -q 'Leap status *: Normal' ||
	fail "часы сервера не сверены (chronyc tracking): бот сочтёт свежие сообщения старыми"

cat <<'EOF'
Привязка номера WhatsApp к боту на сервере. Перед QR:
  1. Бот на ПК остановлен (окно «Tanbala bot» закрыто).
  2. В телефоне: WhatsApp => Связанные устройства => устройство бота с ПК => Выйти.
  3. Телефон с рабочим номером в руке, это окно развёрнуто на весь экран.
Режим бота: закрытый (TEST_MODE=true), отвечает только номерам из TEST_ALLOWLIST.
Попыток не больше двух за 24 часа, неудачная тоже считается.
EOF
read -rp 'Всё готово? Напишите да (или y): ' answer
[[ $answer == да || $answer == y ]] || fail "отменено, на сервере ничего не изменено"
enable_whatsapp

cat <<'EOF'

Запуск бота. Через несколько секунд ниже появится QR (он сменяется сам, на всё 2–3 минуты; не успели — бот
остановится, попытка засчитана).
В телефоне: WhatsApp => Связанные устройства => Привязка устройства, наведите камеру на QR.
Дождитесь строк «Номер привязан», «Первая синхронизация» и «Пропущено с запуска», затем нажмите Ctrl+C один раз
и ждите строку «Бот остановлен» (до 2 минут). Второй раз Ctrl+C не нажимать и окно не закрывать.

EOF
# Ctrl+C и закрытое окно (SIGHUP) достаются боту, он останавливается штатно; скрипт ждёт его и идёт дальше.
# trap с обработчиком, не игнор: боту он не передаётся. Без trap скрипт погиб бы раньше бота, sudo закрыл бы
# терминал, и второй SIGHUP оборвал бы остановку бота посреди записи сессии.
trap : INT HUP
status=0
as_bot env -i HOME="$APP" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM="${TERM:-xterm}" \
	bash -c 'umask 077 && cd "$1" && exec node dist/cli.js' _ "$APP" || status=$?
trap - INT HUP

linked || fail "номер не привязан (бот вышел с кодом $status, причина в строках выше). Если QR был показан,
попытка засчитана: следующую не сразу, WhatsApp наказывает частые неудачи."
echo "Номер привязан."
start_service
