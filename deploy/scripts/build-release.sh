#!/usr/bin/env bash
# Архив кода для сервера из последнего коммита: только то, что в git (без .env, баз, сессии WhatsApp и окружений).
# Запуск на ПК в Git Bash из любой папки репозитория: bash deploy/scripts/build-release.sh [--dirty-ok]
# --dirty-ok: собрать, хотя в рабочей папке есть незакоммиченные правки (например, другой агент правит код);
# архив всё равно из последнего коммита, правки в него не попадут.
# Печатает путь архива, команду scp и команду установки. Архивы лежат в release/ (в git не попадают).
set -euo pipefail

SERVER=ubuntu@91.201.215.210

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
# core.autocrlf=false: файлы едут с теми окончаниями строк, что в git (LF в deploy/ и whatsapp/), без замены на CRLF.
# tar.umask=0022: файлы 644 и папки 755, без права записи для группы.
git -c core.autocrlf=false -c tar.umask=0022 archive --format=tar.gz --prefix="$name/" -o "$archive" HEAD \
	leads whatsapp deploy contract

# Страховка: секретов и данных в архиве быть не должно.
if tar -tzf "$archive" | grep -E '(^|/)\.env$|whatsapp-session|creds\.json|\.db$|\.dump$|\.pairing-attempts\.json'; then
	echo "В архиве секреты или данные, архив удалён" >&2
	rm -f "$archive"
	exit 1
fi

echo "Архив: $archive ($(du -h "$archive" | cut -f1))"
echo "sha256: $(sha256sum "$archive" | cut -d' ' -f1)  (сверить на сервере: sha256sum ~/$name.tar.gz)"
# В домашнюю папку ubuntu, а не в общий /tmp.
echo "На сервер: scp \"$archive\" $SERVER:~/"
echo "На сервере: tar -xzf ~/$name.tar.gz -C ~ && sudo bash ~/$name/deploy/scripts/install.sh <шаги>"
