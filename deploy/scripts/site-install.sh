#!/usr/bin/env bash
# Выкладка версии сайта tanbala.kz на сервере. Архив собранного сайта (делает deploy/scripts/site.sh на ПК) ложится
# новой папкой в /srv/tanbala-site/releases, потом ссылка /srv/tanbala-site/current одним шагом переключается на неё:
# Caddy отдаёт файлы оттуда, полуразложенную версию посетитель не увидит. Хранятся 5 последних версий.
# Запуск: sudo /opt/tanbala/deploy/scripts/site-install.sh <архив.tar.gz>   (архив после выкладки удаляется)
#         sudo /opt/tanbala/deploy/scripts/site-install.sh --rollback      (назад на предыдущую версию)
set -euo pipefail

SITE_ROOT=/srv/tanbala-site
KEEP=5
URL=https://tanbala.kz/

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

# Переключение одним rename: ссылка current всегда ведёт на целую версию.
switch_to() {
	ln -sfn "releases/$1" "$SITE_ROOT/current.new"
	mv -T "$SITE_ROOT/current.new" "$SITE_ROOT/current"
	echo "сайт: версия $1"
}

check() {
	local got
	got=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$URL" || true)
	if [[ $got == 200 ]]; then echo "OK    $URL отвечает 200"; else echo "СБОЙ  $URL: ждали 200, пришло $got"; fi
}

rollback() {
	local current previous
	current=$(basename "$(readlink "$SITE_ROOT/current")")
	previous=$(find "$SITE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort |
		awk -v cur="$current" '$0 == cur {print prev; exit} {prev = $0}')
	[[ -n $previous ]] || fail "нет версии раньше $current"
	switch_to "$previous"
	check
}

install_release() {
	local archive=$1 name dir
	[[ -f $archive ]] || fail "нет архива $archive"
	name=$(date +%Y%m%d-%H%M%S)
	dir=$SITE_ROOT/releases/$name
	install -d -m 755 "$dir"
	tar -xzf "$archive" -C "$dir" --no-same-owner --no-same-permissions
	# Ссылки в архиве могли бы показать наружу чужие файлы сервера: такой архив не выкладываем.
	if [[ -n $(find "$dir" -type l -print -quit) || ! -f $dir/index.html ]]; then
		rm -rf "$dir"
		fail "в архиве нет index.html или есть ссылки: версия не выложена"
	fi
	chown -R root:root "$dir"
	find "$dir" -type d -exec chmod 755 {} +
	find "$dir" -type f -exec chmod 644 {} +
	switch_to "$name"
	rm -f "$archive"
	find "$SITE_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort | head -n -"$KEEP" |
		while read -r old; do rm -rf "${SITE_ROOT:?}/releases/$old"; done
	check
}

[[ $EUID -eq 0 ]] || fail "запускать через sudo"
(($# == 1)) || fail "укажите архив сайта или --rollback"
install -d -m 755 -o root -g root "$SITE_ROOT" "$SITE_ROOT/releases"
if [[ $1 == --rollback ]]; then rollback; else install_release "$1"; fi
