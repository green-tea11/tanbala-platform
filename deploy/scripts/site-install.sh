#!/usr/bin/env bash
# Выкладка версии сайта tanbala.kz на сервере. Архив собранного сайта (делает deploy/scripts/site.sh на ПК)
# распаковывается во временную папку, проверяется и только потом ложится новой версией в /srv/tanbala-site/releases;
# ссылка /srv/tanbala-site/current одним шагом переключается на неё: Caddy отдаёт файлы оттуда, полуразложенную
# версию посетитель не увидит. Хранятся 5 последних версий, в history — какие версии были на сайте по очереди.
# Запуск: sudo /opt/tanbala/deploy/scripts/site-install.sh <архив.tar.gz>   (архив после выкладки удаляется)
#         sudo /opt/tanbala/deploy/scripts/site-install.sh --rollback      (назад на версию, что была до текущей)
set -euo pipefail

SITE_ROOT=/srv/tanbala-site
RELEASES=$SITE_ROOT/releases
HISTORY=$SITE_ROOT/history
KEEP=5
URL=https://tanbala.kz/
staging=

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

current_release() { basename "$(readlink "$SITE_ROOT/current" 2>/dev/null)" 2>/dev/null || true; }

# Переключение одним rename: ссылка current всегда ведёт на целую версию.
switch_to() {
	ln -sfn "releases/$1" "$SITE_ROOT/current.new"
	mv -T "$SITE_ROOT/current.new" "$SITE_ROOT/current"
	echo "сайт: версия $1"
}

check() {
	local got
	got=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL" || true)
	[[ $got == 200 ]] || fail "$URL: ждали 200, пришло $got"
	echo "OK    $URL отвечает 200"
}

# Назад на версию, что была на сайте до текущей (по history, а не по имени): текущая уходит из истории.
rollback() {
	local current previous
	current=$(current_release)
	[[ -s $HISTORY && $(tail -n 1 "$HISTORY") == "$current" ]] || fail "история версий не сходится с current ($current)"
	previous=$(tail -n 2 "$HISTORY" | head -n 1)
	[[ $(wc -l <"$HISTORY") -ge 2 && -f $RELEASES/$previous/index.html ]] || fail "нет версии до $current"
	switch_to "$previous"
	sed -i '$d' "$HISTORY"
	check
}

# В архиве только обычные файлы и папки, без ссылок, устройств, каналов и жёстких ссылок; есть index.html.
validate() {
	local dir=$1
	[[ -f $dir/index.html ]] || fail "в архиве нет index.html: версия не выложена"
	[[ -z $(find "$dir" \( \( ! -type f ! -type d \) -o \( -type f -links +1 \) \) -print -quit) ]] ||
		fail "в архиве не только обычные файлы и папки: версия не выложена"
}

# Старые версии: 5 последних по имени, текущая и предыдущая в истории не удаляются никогда.
prune() {
	local keep_now keep_prev old
	keep_now=$(current_release)
	keep_prev=$(tail -n 2 "$HISTORY" | head -n 1)
	find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n -"$KEEP" |
		while read -r old; do
			[[ $old == "$keep_now" || $old == "$keep_prev" ]] || rm -rf "${RELEASES:?}/$old"
		done
	# История только из версий, что ещё лежат на диске.
	awk -v dir="$RELEASES" '{ if (system("test -f " dir "/" $0 "/index.html") == 0) print }' "$HISTORY" >"$HISTORY.new"
	mv -f "$HISTORY.new" "$HISTORY"
}

install_release() {
	local archive=$1 name
	[[ -f $archive ]] || fail "нет архива $archive"
	# Имя по UTC: перевод часов или смена часового пояса не перепутают порядок версий.
	name=$(date -u +%Y%m%d-%H%M%S)
	[[ ! -e $RELEASES/$name ]] || fail "версия $name уже есть, повторите через секунду"
	staging=$(mktemp -d "$SITE_ROOT/.staging.XXXXXX")
	tar -xzf "$archive" -C "$staging" --no-same-owner --no-same-permissions
	validate "$staging"
	chown -R root:root "$staging"
	find "$staging" -type d -exec chmod 755 {} +
	find "$staging" -type f -exec chmod 644 {} +
	mv -T "$staging" "$RELEASES/$name"
	staging=
	switch_to "$name"
	echo "$name" >>"$HISTORY"
	rm -f "$archive"
	prune
	check
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
(($# == 1)) || fail "укажите архив сайта или --rollback"
install -d -m 755 -o root -g root "$SITE_ROOT" "$RELEASES"
# Второй запуск ждёт первый: две выкладки сразу не наложатся друг на друга.
exec 9>"$SITE_ROOT/.lock"
flock 9
touch "$HISTORY"
# Версия, выложенная до появления истории, становится её первой строкой.
[[ -s $HISTORY || -z $(current_release) ]] || current_release >"$HISTORY"
trap '[[ -z $staging ]] || rm -rf "$staging"' EXIT
if [[ $1 == --rollback ]]; then rollback; else install_release "$1"; fi
