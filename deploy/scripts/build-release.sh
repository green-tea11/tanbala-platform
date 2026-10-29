#!/usr/bin/env bash
# Архив кода для сервера из последнего коммита: только то, что в git (без .env, баз, сессии WhatsApp и окружений).
# Запуск на ПК в Git Bash из любой папки репозитория: bash deploy/scripts/build-release.sh
# Печатает путь архива и команду scp. Архивы лежат в release/ (в git не попадают).
set -euo pipefail

SERVER=ubuntu@91.201.215.210

cd "$(git rev-parse --show-toplevel)"
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
	echo "Есть незакоммиченные изменения: архив собирается только из коммита. Сначала коммит." >&2
	exit 1
fi

sha=$(git rev-parse --short HEAD)
name="tanbala-$sha"
mkdir -p release
archive="release/$name.tar.gz"
# core.autocrlf=false: файлы едут с теми окончаниями строк, что в git (LF в deploy/ и whatsapp/), без замены на CRLF.
git -c core.autocrlf=false archive --format=tar.gz --prefix="$name/" -o "$archive" HEAD leads whatsapp deploy contract

# Страховка: секретов и данных в архиве быть не должно.
if tar -tzf "$archive" | grep -E '(^|/)\.env$|whatsapp-session|creds\.json|\.db$|\.dump$|\.pairing-attempts\.json'; then
	echo "В архиве секреты или данные, архив удалён" >&2
	rm -f "$archive"
	exit 1
fi

echo "Архив: $archive ($(du -h "$archive" | cut -f1))"
echo "На сервер: scp \"$archive\" $SERVER:/tmp/"
