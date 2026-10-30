#!/usr/bin/env bash
# Архив кода для сервера из последнего коммита: только то, что в git (без .env, баз, сессии WhatsApp и окружений),
# плюс собранная здесь же консоль (console/dist и console/web/dist).
# Запуск на ПК в Git Bash из любой папки репозитория: bash deploy/scripts/build-release.sh [--dirty-ok]
# --dirty-ok: собрать, хотя в рабочей папке есть незакоммиченные правки (например, другой агент правит код);
# архив всё равно из последнего коммита, правки в него не попадут.
# Консоль собирается на ПК, как сайт (site.sh): на сервере 2 ГБ, сборка Vite во время поиска ушла бы в swap, а пакеты
# разработки серверу не нужны. Сборка во временной папке из того же коммита, рабочая папка console/ не меняется:
#   console/      npm ci --ignore-scripts, npm run build (сервер: tsc → console/dist, нужны dist/server.js и cli.js)
#   console/web/  то же (интерфейс: Vite → console/web/dist), если в коммите есть console/web/package.json
# console/web — отдельный пакет со своим package-lock.json (не workspace): на сервере ставятся только зависимости
# console/ для работы (install.sh, шаг console).
# Печатает путь архива, команду scp и команду установки. Архивы лежат в release/ (в git не попадают).
set -euo pipefail

SERVER=ubuntu@91.201.215.210

fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

cd "$(git rev-parse --show-toplevel)"
dirty=$(git status --porcelain --untracked-files=no)
if [[ -n $dirty ]]; then
	if [[ ${1:-} != --dirty-ok ]]; then
		echo "Есть незакоммиченные изменения: архив собирается только из коммита. Сначала коммит" \
			"(или --dirty-ok, если правки в архив и не должны попасть)." >&2
		exit 1
	fi
	printf 'Внимание: эти правки не закоммичены и в архив не попадут:\n%s\n' "$dirty" >&2
fi

sha=$(git rev-parse --short HEAD)
name="tanbala-$sha"
mkdir -p release
archive="release/$name.tar.gz"
work=$(mktemp -d)
# Недописанный архив (сбой gzip или проверки) в release/ не остаётся.
trap 'rm -rf "$work"; rm -f "$archive.part"' EXIT
tarball="$work/$name.tar"

# npm ci без install-скриптов пакетов (на этом ПК лежит ключ к серверу), затем npm run build; журнал — при сбое.
npm_build() {
	local dir=$1 what=$2
	echo "Сборка: $what (npm ci и npm run build)"
	(cd "$dir" && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && npm run build) \
		>"$work/build.log" 2>&1 || {
		tail -30 "$work/build.log" >&2
		fail "сборка ($what) не удалась, архива нет"
	}
}

# Консоль из коммита во временной папке; готовые dist дописываются в архив под тем же префиксом.
build_console() {
	local app=$work/build/console parts=(console/dist)
	if ! git cat-file -e HEAD:console/package.json 2>/dev/null; then
		echo "Внимание: в коммите нет console/package.json, консоль не собрана (шаг console на сервере откажет)" >&2
		return
	fi
	mkdir -p "$work/build"
	git -c core.autocrlf=false archive HEAD console | tar -C "$work/build" -xf -
	npm_build "$app" "консоль, сервер"
	[[ -f $app/dist/server.js && -f $app/dist/cli.js ]] || fail "после сборки нет console/dist/server.js или cli.js"
	if [[ -f $app/web/package.json ]]; then
		npm_build "$app/web" "консоль, интерфейс"
		[[ -f $app/web/dist/index.html ]] || fail "после сборки нет console/web/dist/index.html"
		parts+=(console/web/dist)
	else
		echo "Внимание: в коммите нет console/web/package.json, интерфейс консоли не собран" >&2
	fi
	# Владелец root и права 644/755, как у файлов из git (tar.umask=0022).
	tar -C "$work/build" --owner=0 --group=0 --numeric-owner --mode=u+rwX,go=rX --sort=name \
		--transform="s,^,$name/,S" -rf "$tarball" "${parts[@]}"
}

# core.autocrlf=false: файлы едут с теми окончаниями строк, что в git (LF в deploy/ и whatsapp/), без замены на CRLF.
# tar.umask=0022: файлы 644 и папки 755, без права записи для группы.
git -c core.autocrlf=false -c tar.umask=0022 archive --format=tar --prefix="$name/" -o "$tarball" HEAD \
	leads whatsapp deploy contract console
build_console
gzip -n -c "$tarball" >"$archive.part"

# Страховка: секретов (.env и .env.*, кроме образцов .env.example), данных и чужих зависимостей в архиве быть не
# должно. Архив, который не читается, тоже не годится.
list=$(tar -tzf "$archive.part") || fail "архив не читается, архива нет"
if grep -E '(^|/)\.env(\.[^/]*)?$|whatsapp-session|creds\.json|\.db(-wal|-shm|-journal)?$|\.sqlite3?$|\.dump$|\.pairing-attempts\.json|(^|/)node_modules(/|$)' <<<"$list" |
	grep -vE '(^|/)\.env\.example$'; then
	fail "в архиве секреты, данные или node_modules (строки выше), архива нет"
fi
mv "$archive.part" "$archive"

echo "Архив: $archive ($(du -h "$archive" | cut -f1))"
echo "sha256: $(sha256sum "$archive" | cut -d' ' -f1)  (сверить на сервере: sha256sum ~/$name.tar.gz)"
# В домашнюю папку ubuntu, а не в общий /tmp.
echo "На сервер: scp \"$archive\" $SERVER:~/"
echo "На сервере: tar -xzf ~/$name.tar.gz -C ~ && sudo bash ~/$name/deploy/scripts/install.sh <шаги>"
