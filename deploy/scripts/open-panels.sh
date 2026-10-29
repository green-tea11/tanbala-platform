#!/usr/bin/env bash
# Открыть панели wa.tanbala.kz и leads.tanbala.kz: пароли basic auth Caddy и рабочий Caddyfile.
# Запускает владелец в своём сеансе SSH:
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh          пароли для имён, у которых их ещё нет
#   sudo /opt/tanbala/deploy/scripts/open-panels.sh wa       сменить пароль wa.tanbala.kz (или leads)
# Спросит имя (латиницей) и пароль (не короче 20 символов, ввод не виден, дважды). В /etc/caddy/auth/<wa|leads>.caddy
# ляжет одна строка «имя хэш-bcrypt», самого пароля на сервере нет. Потом шаг caddy из install.sh (проверка и reload)
# и проверка, что без пароля оба сайта отвечают 401. Прервался (опечатка, Ctrl-C): старый пароль остаётся, а Caddy
# возвращается к режиму по готовым паролям (без обоих — закрыт, 503).
set -euo pipefail

# Функции install.sh: auth_ready (проверка файла пароля), step_caddy, fail.
source "$(dirname "$0")/install.sh"

AUTH_DIR=/etc/caddy/auth
MIN_LENGTH=20
# Цена bcrypt 10, а не 14 у caddy hash-password: пароль длинный и случайный, подбор безнадёжен и так, а неверная
# попытка стоит 2 vCPU в 16 раз меньше. Неверные попытки ещё и блокирует fail2ban (deploy/env.md).
BCRYPT_COST=10
new_file=
applied=0

on_exit() {
	local code=$?
	[[ -z $new_file ]] || rm -f "$new_file"
	if ((code != 0 && !applied)); then
		echo "Прервано. Caddy остаётся в режиме по готовым паролям:" >&2
		step_caddy >&2 || true
	fi
}

ask_password() {
	local site=$1 force=$2 file=$AUTH_DIR/$1.caddy user pass pass2 hash
	if ((!force)) && auth_ready "$site"; then
		echo "$site.tanbala.kz: пароль уже есть (сменить: $0 $site)"
		return
	fi
	if [[ -e $file ]] && ! auth_ready "$site"; then
		echo "$site.tanbala.kz: $file не годится (владелец, права или формат), записываю заново"
	fi
	echo "== $site.tanbala.kz"
	read -rp "Имя (латиница, цифры, . _ -): " user
	[[ $user =~ ^[A-Za-z0-9._-]{1,64}$ ]] || fail "имя не подходит"
	IFS= read -rsp "Пароль: " pass && echo
	IFS= read -rsp "Ещё раз: " pass2 && echo
	[[ $pass == "$pass2" ]] || fail "пароли не совпали"
	((${#pass} >= MIN_LENGTH)) || fail "пароль короче $MIN_LENGTH символов"
	# Пароль идёт в htpasswd через stdin, не в командной строке (её видят другие процессы).
	hash=$(printf '%s\n' "$pass" | htpasswd -niBC "$BCRYPT_COST" "$user" | cut -d: -f2-)
	unset pass pass2
	# Новый файл рядом и переименование: старый пароль действует, пока новый не записан целиком.
	new_file=$(mktemp "$AUTH_DIR/.$site.XXXXXX")
	printf '%s %s\n' "$user" "$hash" >"$new_file"
	chown root:caddy "$new_file"
	chmod 640 "$new_file"
	mv -f "$new_file" "$file"
	new_file=
	auth_ready "$site" || fail "$file записан, но не прошёл проверку"
	echo "$site.tanbala.kz: пароль записан ($file)"
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
case ${1:-} in
'') force_wa=0 force_leads=0 ;;
wa) force_wa=1 force_leads=0 ;;
leads) force_wa=0 force_leads=1 ;;
*) fail "можно указать только wa или leads" ;;
esac
trap on_exit EXIT
install -d -m 750 -o root -g caddy "$AUTH_DIR"
ask_password wa "$force_wa"
ask_password leads "$force_leads"
step_caddy
applied=1

echo "== проверка снаружи, без пароля"
failed=0
for site in wa leads; do
	got=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$site.tanbala.kz/" || true)
	if [[ $got == 401 ]]; then
		echo "OK    https://$site.tanbala.kz просит пароль (401)"
	else
		echo "СБОЙ  https://$site.tanbala.kz: ждали 401, пришло $got"
		failed=1
	fi
done
((!failed)) || exit 1
echo "Панель бота откроется после этапа 4 (до него за паролем Caddy будет 502). Свой пароль панели — ADMIN_PASSWORD"
echo "в /opt/tanbala/whatsapp/.env, не короче 16 символов."
