#!/usr/bin/env bash
# Новая версия сайта tanbala.kz одной командой. Запуск на ПК в Git Bash из любой папки этого репозитория:
#   bash deploy/scripts/site.sh
# Берёт исходники из последнего коммита ../A-site (или папки SITE_DIR; если там нет git — из рабочей папки),
# собирает во временной папке: сам A-site не меняется (ни dist, ни кэши). Незакоммиченные правки A-site в сборку
# не попадают. Архив сборки едет на сервер, там site-install.sh кладёт его новой версией и переключает сайт на неё.
# Откат на прошлую версию: ssh ubuntu@91.201.215.210 sudo /opt/tanbala/deploy/scripts/site-install.sh --rollback
set -euo pipefail

SERVER=ubuntu@91.201.215.210
SITE_DIR=${SITE_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)/../A-site}
# Только то, что нужно для сборки: без node_modules, dist, кэшей и заметок.
FILES=(package.json package-lock.json astro.config.mjs tsconfig.json src public)
PLACEHOLDER_WA=wa.me/77000000000

[[ -f $SITE_DIR/package.json ]] || {
	echo "Нет сайта в $SITE_DIR (задать папку: SITE_DIR=... bash $0)" >&2
	exit 1
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/src"
if git -C "$SITE_DIR" rev-parse --git-dir >/dev/null 2>&1; then
	echo "Сайт из коммита $(git -C "$SITE_DIR" log -1 --format='%h %s')"
	[[ -z $(git -C "$SITE_DIR" status --porcelain --untracked-files=no) ]] ||
		echo "Внимание: в A-site есть незакоммиченные правки, в сборку они не попадут" >&2
	git -C "$SITE_DIR" archive HEAD "${FILES[@]}" | tar -C "$work/src" -xf -
else
	tar -C "$SITE_DIR" -cf - "${FILES[@]}" | tar -C "$work/src" -xf -
fi
(cd "$work/src" && npm ci --no-audit --no-fund --loglevel=error && npx astro build --outDir ../dist)
[[ -f $work/dist/index.html ]] || {
	echo "Сборка без index.html, на сервер ничего не ушло" >&2
	exit 1
}
if grep -q "$PLACEHOLDER_WA" "$work/dist/index.html"; then
	echo "Внимание: номер WhatsApp на сайте — заглушка ($PLACEHOLDER_WA, A-site/src/data/content.ts)" >&2
fi

tar -C "$work/dist" -czf "$work/site.tar.gz" .
echo "Сборка: $(du -sh "$work/dist" | cut -f1), отправка на сервер"
scp -q "$work/site.tar.gz" "$SERVER:~/tanbala-site.tar.gz"
ssh "$SERVER" 'sudo /opt/tanbala/deploy/scripts/site-install.sh ~/tanbala-site.tar.gz'
