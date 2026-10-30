#!/usr/bin/env bash
# Пароли basic auth Caddy и открытие панелей. Запускает владелец в своём сеансе SSH:
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh                     wa. и leads.: пароли для имён, где их ещё нет
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh wa                  сменить пароль wa.tanbala.kz (или leads)
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh panel add <имя>     panel.tanbala.kz: пароль Caddy для человека
#                                                                        (имя уже есть — новый пароль вместо старого)
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh panel remove <имя>  убрать человека (последний — panel. 503)
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh panel list          у кого есть пароль Caddy для panel.
# Пароль не короче 20 символов, ввод не виден, дважды. В /etc/caddy/auth/<wa|leads|panel>.caddy ложатся строки
# «имя хэш-bcrypt» (у wa и leads одна, у panel по строке на человека), самого пароля на сервере нет. Потом шаг caddy
# из install.sh (проверка и reload) и проверка снаружи без пароля: 401 (panel без людей — 503). Режимы wa./leads.
# и panel. независимы: пароль panel не закрывает старые панели, и наоборот. Прервался (опечатка, Ctrl-C): старые
# пароли остаются, а Caddy возвращается к режиму по готовым файлам паролей.
# Вход в саму консоль (второй слой, своё имя и пароль) заводится отдельно: console-user.sh.
set -euo pipefail

# Функции install.sh: auth_ready (проверка файла пароля), step_caddy, fail, PANEL_SITE, AUTH_LINE_RE.
source "$(dirname "$0")/install.sh"

AUTH_DIR=/etc/caddy/auth
MIN_LENGTH=20
# Цена bcrypt 10, а не 14 у caddy hash-password: пароль длинный и случайный, подбор безнадёжен и так, а неверная
# попытка стоит 2 vCPU в 16 раз меньше. Неверные попытки ещё и блокирует fail2ban (deploy/env.md).
BCRYPT_COST=10
CONSOLE_USER_CMD="sudo /opt/tanbala/deploy/scripts/console-user.sh"
# Один запуск за раз: два одновременных panel add потеряли бы строку.
LOCK_FILE=/run/tanbala-open-panels.lock
new_file=
# Копия файлов паролей до правки (папка в $AUTH_DIR, права 700): если Caddy новые не примет, вернуть старые.
prev_dir=
applied=0
failed=0
hash=

# Файлы паролей как до запуска: правленые и новые убрать, сохранённые вернуть.
restore_auth() {
	local f
	for f in "$AUTH_DIR"/*.caddy; do
		if [[ -f $f && ! -e $prev_dir/${f##*/} ]]; then rm -f "$f"; fi
	done
	for f in "$prev_dir"/*.caddy; do
		if [[ -f $f ]]; then cp -p "$f" "$AUTH_DIR/"; fi
	done
}

on_exit() {
	local code=$?
	[[ -z $new_file ]] || rm -f "$new_file"
	if ((code != 0 && !applied)); then
		if [[ -n $prev_dir ]]; then
			echo "Прервано: файлы паролей Caddy возвращены как были." >&2
			restore_auth || true
		fi
		echo "Caddy остаётся в режиме по готовым паролям:" >&2
		step_caddy >&2 || true
	fi
	[[ -z $prev_dir ]] || rm -rf "$prev_dir"
}

# Имя: с буквы или цифры (с «-» htpasswd принял бы его за ключ), не import (в файле паролей Caddy счёл бы строку
# своей командой и после перезапуска не поднялся бы).
valid_user() {
	[[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ && ${1,,} != import ]] ||
		fail "имя не подходит (латиница, цифры, . _ -, с буквы или цифры, до 64 символов, не import)"
}

# Пароль для имени $1 с клавиатуры (без эха, дважды) → хэш bcrypt в переменной hash.
read_hash() {
	local user=$1 pass pass2
	IFS= read -rsp "Пароль: " pass && echo
	IFS= read -rsp "Ещё раз: " pass2 && echo
	[[ $pass == "$pass2" ]] || fail "пароли не совпали"
	((${#pass} >= MIN_LENGTH)) || fail "пароль короче $MIN_LENGTH символов"
	# Пароль идёт в htpasswd через stdin, не в командной строке (её видят другие процессы).
	hash=$(printf '%s\n' "$pass" | htpasswd -niBC "$BCRYPT_COST" "$user" | cut -d: -f2-)
	unset pass pass2
}

# Файл паролей $1 из stdin: новый файл рядом и переименование, старые строки действуют, пока новый не записан целиком.
write_auth() {
	local site=$1 file=$AUTH_DIR/$1.caddy
	new_file=$(mktemp "$AUTH_DIR/.$site.XXXXXX")
	cat >"$new_file"
	chown root:caddy "$new_file"
	chmod 640 "$new_file"
	mv -f "$new_file" "$file"
	new_file=
	auth_ready "$site" || fail "$file записан, но не прошёл проверку"
}

ask_password() {
	local site=$1 force=$2 file=$AUTH_DIR/$1.caddy user
	if ((!force)) && auth_ready "$site"; then
		echo "$site.tanbala.kz: пароль уже есть (сменить: $0 $site)"
		return
	fi
	if [[ -e $file ]] && ! auth_ready "$site"; then
		echo "$site.tanbala.kz: $file не годится (владелец, права или формат), записываю заново"
	fi
	echo "== $site.tanbala.kz"
	read -rp "Имя (латиница, цифры, . _ -): " user
	valid_user "$user"
	read_hash "$user"
	write_auth "$site" <<<"$user $hash"
	echo "$site.tanbala.kz: пароль записан ($file)"
}

# Есть ли имя $1 в файле паролей panel.
panel_has() { [[ -f $AUTH_DIR/panel.caddy ]] && awk -v u="$1" '$1 == u {f = 1} END {exit !f}' "$AUTH_DIR/panel.caddy"; }

# Строки panel без имени $1: только строки верного вида, при повторе имени — первая.
panel_others() {
	[[ -f $AUTH_DIR/panel.caddy ]] || return 0
	{ grep -xE "$AUTH_LINE_RE" "$AUTH_DIR/panel.caddy" || true; } | awk -v u="$1" '$1 != u && !seen[$1]++'
}

panel_add() {
	local user=$1 file=$AUTH_DIR/panel.caddy others
	valid_user "$user"
	if [[ -e $file ]] && ! auth_ready panel; then
		echo "panel.tanbala.kz: $file не годится (владелец, права или формат): строки не того вида отбрасываю"
	fi
	if panel_has "$user"; then
		echo "== panel.tanbala.kz: у $user уже есть пароль Caddy, записываю новый"
	else
		echo "== panel.tanbala.kz: пароль Caddy для $user"
	fi
	read_hash "$user"
	others=$(panel_others "$user")
	write_auth panel < <(printf '%s\n' ${others:+"$others"} "$user $hash")
	echo "panel.tanbala.kz: пароль $user записан ($file, людей: $(wc -l <"$file"))"
}

panel_remove() {
	local user=$1 file=$AUTH_DIR/panel.caddy rest
	valid_user "$user"
	panel_has "$user" || fail "у $user нет пароля Caddy для panel.tanbala.kz (список: $0 panel list)"
	rest=$(panel_others "$user")
	if [[ -n $rest ]]; then
		write_auth panel < <(printf '%s\n' "$rest")
		echo "panel.tanbala.kz: $user убран (людей: $(wc -l <"$file"))"
	else
		# Последний человек. Сначала закрытый блок panel (503), потом без файла паролей: Caddy, перезапущенный в любой
		# момент, найдёт всё, что импортирует.
		install -m 644 "$ROOT/deploy/caddy/panel.closed.caddy" "$PANEL_SITE"
		rm -f "$file"
		echo "panel.tanbala.kz: $user был последним, panel. закрывается (503)"
	fi
}

panel_list() {
	if [[ -f $AUTH_DIR/panel.caddy ]]; then
		echo "panel.tanbala.kz: пароль Caddy есть у"
		cut -d' ' -f1 "$AUTH_DIR/panel.caddy"
	else
		echo "panel.tanbala.kz: паролей Caddy нет, panel. закрыт (503)"
	fi
}

# Снаружи, через настоящий сертификат и без пароля: ждём код $2.
check_site() {
	local site=$1 want=$2 got
	got=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$site.tanbala.kz/" || true)
	if [[ $got == "$want" ]]; then
		echo "OK    https://$site.tanbala.kz без пароля: $want"
	else
		echo "СБОЙ  https://$site.tanbala.kz: ждали $want, пришло $got"
		failed=1
	fi
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
usage="$0 [wa|leads], $0 panel add|remove <имя> или $0 panel list"
force_wa=0 force_leads=0 panel_action=
case ${1:-} in
'') ;;
wa) force_wa=1 ;;
leads) force_leads=1 ;;
panel)
	case ${2:-} in
	list)
		panel_list
		exit 0
		;;
	add | remove)
		(($# == 3)) || fail "укажите имя: $0 panel $2 <имя>"
		panel_action=$2
		;;
	*) fail "можно: $usage" ;;
	esac
	;;
*) fail "можно: $usage" ;;
esac
exec 9>"$LOCK_FILE"
flock -n 9 || fail "уже идёт другой запуск $0"
trap on_exit EXIT
install -d -m 750 -o root -g caddy "$AUTH_DIR"
prev_dir=$(mktemp -d "$AUTH_DIR/.prev.XXXXXX")
find "$AUTH_DIR" -maxdepth 1 -name '*.caddy' -type f -exec cp -p {} "$prev_dir/" \;

if [[ -n $panel_action ]]; then
	case $panel_action in
	add) panel_add "$3" ;;
	remove) panel_remove "$3" ;;
	esac
	step_caddy
	applied=1
	echo "== проверка снаружи, без пароля"
	if auth_ready panel; then check_site panel 401; else check_site panel 503; fi
	((!failed)) || exit 1
	if [[ $panel_action == add ]]; then
		echo "Вход в саму консоль — свой пользователь и пароль (не короче 9 символов, ввод не виден):"
		echo "  $CONSOLE_USER_CMD user add $3"
	else
		echo "Если у $3 есть пользователь в самой консоли — отключить его там же (закроет сессии):"
		echo "  $CONSOLE_USER_CMD --help"
	fi
	exit 0
fi

ask_password wa "$force_wa"
ask_password leads "$force_leads"
step_caddy
applied=1

echo "== проверка снаружи, без пароля"
for site in wa leads; do check_site "$site" 401; done
((!failed)) || exit 1
echo "Панель бота откроется после этапа 4 (до него за паролем Caddy будет 502). Свой пароль панели — ADMIN_PASSWORD"
echo "в /opt/tanbala/whatsapp/.env, не короче 16 символов."
