#!/usr/bin/env bash
# Пользователи консоли panel.tanbala.kz (второй слой после пароля Caddy): завести, сменить пароль или роль,
# отключить, закрыть сессии. В интерфейсе консоли пользователи только для чтения, менять их можно только здесь.
# Запускает владелец в своём сеансе SSH (пароль спросит сама консоль, ввод не виден):
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/console-user.sh user add <имя>
#   ssh -t ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/console-user.sh --help    все команды
# Команды и их аргументы — у самой консоли (node dist/cli.js), этот скрипт только запускает её от имени
# tanbala-console, из папки службы (те же .env и data/console.db), с umask 077 и чистым окружением.
set -euo pipefail

APP=/opt/tanbala/console
CONSOLE_USER=tanbala-console

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
(($# > 0)) || fail "укажите команду, например: $0 user add <имя> (все команды: $0 --help)"
id "$CONSOLE_USER" &>/dev/null || fail "нет пользователя $CONSOLE_USER: сначала install.sh system"
[[ -f $APP/dist/cli.js ]] || fail "нет $APP/dist/cli.js: сначала install.sh console"
# В папке консоли root ничего не открывает сам: всё от имени службы. setpriv, а не runuser: без сеанса PAM,
# терминал остаётся тем же (ввод пароля без эха), Ctrl+C доходит до консоли.
exec setpriv --reuid="$CONSOLE_USER" --regid="$CONSOLE_USER" --init-groups --no-new-privs -- \
	env -i HOME="$APP/data" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TERM="${TERM:-dumb}" NODE_ENV=production \
	bash -c 'umask 077 && cd "$1" && shift && exec node dist/cli.js "$@"' _ "$APP" "$@"
