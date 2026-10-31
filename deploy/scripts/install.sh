#!/usr/bin/env bash
# Установка и обновление Tanbala на сервере (Ubuntu 24.04) из архива deploy/scripts/build-release.sh.
# Запуск от root из распакованного архива, шаги по порядку (повтор любого шага безопасен):
#   tar -xzf ~/tanbala-<sha>.tar.gz -C ~ && sudo bash ~/tanbala-<sha>/deploy/scripts/install.sh <шаг>...
# Шаги:
#   system    пакеты (Python venv, sqlite3, Docker, Caddy, Google Chrome, Node) и пользователи служб
#   configs   /opt/tanbala/deploy и contract, Caddy, nftables, службы и таймеры systemd, fail2ban, журналы, apt
#   caddy     Caddyfile: wa. и leads. закрыты (503), пока нет обоих их паролей Caddy, иначе ведут на panel; panel. — свой
#             режим (открыт, когда есть его файл паролей), wa. и leads. не закрывает. Его зовёт open-panels.sh
#   db        Postgres и Reacher в Docker; нужен /opt/tanbala/leads/.env (deploy/env.md)
#   leads     код почты, .venv и .venv-2gis, Chromium для crawl4ai; .env, data/, logs/ не трогает
#   whatsapp  код бота, npm ci и сборка; .env, data/ и счётчик привязок по QR не трогает
#   console   консоль, собранная на ПК (build-release.sh), и её зависимости для работы; .env и data/ не трогает
#   all       system configs leads whatsapp console
# Секретов скрипт не печатает. .env переносит владелец (deploy/env.md). Службы почты и консоли стартуют, если есть
# их .env. Бот включается только на этапе 4 (привязка по QR): здесь он перезапускается, только если уже работал.
# open-panels.sh подключает этот файл (source) ради шага caddy и проверки паролей; тогда шаги сами не запускаются.
set -euo pipefail

NODE_VERSION=22.23.2
# Сумма архива Node, сверенная с SHASUMS256.txt nodejs.org 29.10.2026: новая версия Node — новая сумма здесь.
NODE_SHA256=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307
# Отпечатки главных ключей репозиториев apt (сверены 29.10.2026): чужой ключ при первой загрузке не пройдёт.
DOCKER_KEY=9DC858229FC7DD38854AE2D88D81803C0EBFCD88
CADDY_KEY=65760C51EDEA2017CEA2CA15155B6D79CA56EA34
GOOGLE_KEY=EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796
ROOT=/opt/tanbala
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# Блок panel.tanbala.kz, его импортируют оба Caddyfile: копия caddy/panel.caddy или caddy/panel.closed.caddy.
PANEL_SITE=/etc/caddy/panel-site.caddy
# Строка файла паролей Caddy: «имя хэш-bcrypt».
AUTH_LINE_RE='[A-Za-z0-9._-]{1,64} \$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}'
COMPOSE=(docker compose -f "$ROOT/deploy/docker/compose.yml" --env-file /etc/tanbala/compose.env)
WA_STOPPED=0
# Временная папка npm ci консоли: удаляется и при сбое шага (on_exit).
CONSOLE_WORK=
export DEBIAN_FRONTEND=noninteractive

log() { printf '\n== %s\n' "$*"; }
fail() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}
from_release() { [[ $SRC != "$ROOT" ]] || fail "шаг $1 запускать из распакованного архива, не из $ROOT"; }
need_user() { id "$1" &>/dev/null || fail "нет пользователя $1: сначала шаг system"; }

# Из архива на место: лишние файлы удаляются, исключённые пути (данные, .env, окружения) не трогаются.
sync_tree() {
	local from=$1 to=$2
	shift 2
	rsync -a --delete --no-owner --no-group "$@" "$from/" "$to/"
}

# Репозиторий apt со своим ключом (signed-by): ключ этого репозитория не подходит к остальным.
add_repo() {
	local name=$1 key_url=$2 key=$3 line=$4 keyring=/etc/apt/keyrings/$1.gpg tmp
	if [[ ! -s $keyring ]]; then
		tmp=$(mktemp)
		curl -fsSL "$key_url" | gpg --dearmor --yes -o "$tmp"
		if [[ $(gpg --show-keys --with-colons "$tmp" 2>/dev/null | awk -F: '/^fpr/ {print $10; exit}') != "$key" ]]; then
			rm -f "$tmp"
			fail "ключ репозитория $name не совпал с отпечатком $key"
		fi
		install -m 644 "$tmp" "$keyring"
		rm -f "$tmp"
	fi
	printf '%s\n' "${line//KEYRING/$keyring}" >"/etc/apt/sources.list.d/$name.list"
}

add_user() {
	id "$1" &>/dev/null ||
		useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$1"
}

# Node точной версии из архива nodejs.org, сумма архива записана выше (как whatsapp/docs/DEPLOY.md, шаг 2).
install_node() {
	local name=node-v$NODE_VERSION-linux-x64 tmp
	if [[ ! -x /opt/node/$name/bin/node ]]; then
		tmp=$(mktemp -d)
		curl -fsSL -o "$tmp/$name.tar.xz" "https://nodejs.org/dist/v$NODE_VERSION/$name.tar.xz"
		echo "$NODE_SHA256  $tmp/$name.tar.xz" | sha256sum -c -
		install -d -m 755 /opt/node
		tar -xJf "$tmp/$name.tar.xz" -C /opt/node --no-same-owner
		rm -rf "$tmp"
	fi
	ln -sfn "/opt/node/$name/bin/node" /usr/local/bin/node
	ln -sfn "/opt/node/$name/bin/npm" /usr/local/bin/npm
	echo "Node $(node -v), npm $(npm -v)"
}

step_system() {
	log "пакеты Ubuntu"
	apt-get update -q
	# chrony вместо systemd-timesyncd: бот сравнивает время сообщений со временем привязки и простоя.
	apt-get install -y -q ca-certificates curl gnupg rsync xz-utils python3-venv sqlite3 apache2-utils chrony
	install -d -m 755 /etc/apt/keyrings
	local arch codename
	arch=$(dpkg --print-architecture)
	codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
	add_repo docker https://download.docker.com/linux/ubuntu/gpg "$DOCKER_KEY" \
		"deb [arch=$arch signed-by=KEYRING] https://download.docker.com/linux/ubuntu $codename stable"
	add_repo caddy-stable https://dl.cloudsmith.io/public/caddy/stable/gpg.key "$CADDY_KEY" \
		"deb [signed-by=KEYRING] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main"
	# Наш источник Chrome нужен только для первой установки: пакет Chrome заменяет его своим google-chrome.sources
	# (со своим ключом) и дальше ведёт сам. Второй источник рядом дал бы apt конфликт Signed-By.
	if [[ ! -f /etc/apt/sources.list.d/google-chrome.sources ]]; then
		add_repo google-chrome https://dl.google.com/linux/linux_signing_key.pub "$GOOGLE_KEY" \
			"deb [arch=amd64 signed-by=KEYRING] https://dl.google.com/linux/chrome/deb/ stable main"
	fi
	apt-get update -q
	# Caddy с первой секунды на закрытом Caddyfile (с его import): стандартный показал бы свою страницу на :80.
	if [[ ! -f /etc/caddy/Caddyfile ]]; then
		install -D -m 644 -t "$ROOT/deploy/caddy" "$SRC"/deploy/caddy/*.caddy
		install -D -m 644 "$SRC/deploy/caddy/panel.closed.caddy" "$PANEL_SITE"
		install -D -m 644 "$SRC/deploy/Caddyfile.closed" /etc/caddy/Caddyfile
	fi
	apt-get install -y -q -o Dpkg::Options::=--force-confold \
		docker-ce docker-ce-cli containerd.io docker-compose-plugin caddy google-chrome-stable
	log "Node $NODE_VERSION"
	install_node
	log "пользователи служб"
	add_user tanbala-leads
	add_user tanbala-wa
	add_user tanbala-console
	# Только для npm ci консоли (шаг console): у tanbala-console нет выхода в интернет, root чужие пакеты не ставит.
	add_user tanbala-build
	id caddy
}

step_configs() {
	from_release configs
	need_user caddy
	need_user tanbala-leads
	need_user tanbala-wa
	need_user tanbala-console
	need_user tanbala-build
	# Caddyfile из архива проверяется до того, как он и его import в $ROOT/deploy/caddy станут рабочими.
	validate_caddy "$SRC/deploy"
	log "deploy и contract в $ROOT"
	install -d -m 755 -o root -g root "$ROOT"
	sync_tree "$SRC/deploy" "$ROOT/deploy"
	sync_tree "$SRC/contract" "$ROOT/contract"
	chown -R root:root "$ROOT/deploy" "$ROOT/contract"
	chmod -R go-w "$ROOT/deploy" "$ROOT/contract"
	chmod 755 "$ROOT"/deploy/scripts/*.sh

	log "журнал systemd, logrotate, автообновление Chrome"
	install -D -m 644 "$ROOT/deploy/journald/tanbala.conf" /etc/systemd/journald.conf.d/tanbala.conf
	systemctl restart systemd-journald
	install -m 644 "$ROOT/deploy/logrotate/tanbala" /etc/logrotate.d/tanbala
	install -m 644 "$ROOT/deploy/apt/52tanbala-unattended-chrome" /etc/apt/apt.conf.d/

	log "Caddy"
	step_caddy

	log "fail2ban"
	# Без файла журнала jail не поднимется, а с ним и весь fail2ban (вместе с защитой SSH).
	[[ -e /var/log/caddy/access.log ]] || install -m 600 -o caddy -g caddy /dev/null /var/log/caddy/access.log
	# Пароль Caddy на всех именах и неудачные входы в консоль: оба читают журнал Caddy.
	local jails=(tanbala-caddy-auth tanbala-console-login) jail
	for jail in "${jails[@]}"; do
		install -m 644 "$ROOT/deploy/fail2ban/filter.d/$jail.conf" /etc/fail2ban/filter.d/
		install -m 644 "$ROOT/deploy/fail2ban/jail.d/$jail.conf" /etc/fail2ban/jail.d/
	done
	systemctl reload-or-restart fail2ban
	for jail in "${jails[@]}"; do fail2ban-client status "$jail" | head -3; done

	log "службы и таймеры systemd"
	install -m 644 "$ROOT"/deploy/systemd/*.service "$ROOT"/deploy/systemd/*.timer /etc/systemd/system/
	install -d -m 700 /var/backups/tanbala
	systemctl daemon-reload
	# reload, а не restart: restart правил остановил бы и службы с Requires=tanbala-firewall.
	systemctl enable tanbala-firewall.service
	systemctl reload-or-restart tanbala-firewall.service
	systemctl enable --now docker.service tanbala-backup.timer tanbala-health.timer
	systemctl enable tanbala-leads.service
}

# Файл паролей Caddy готов: владелец root:caddy, права 640, только строки «имя хэш-bcrypt» с разными именами и без
# имени import (его Caddy счёл бы своей командой). У wa и leads строка ровно одна, у panel — по строке на человека
# (open-panels.sh panel add|remove).
auth_ready() {
	local file=/etc/caddy/auth/$1.caddy lines
	[[ -f $file && ! -L $file && $(stat -c '%U:%G %a' "$file") == 'root:caddy 640' ]] || return 1
	lines=$(wc -l <"$file")
	if [[ $1 == panel ]]; then ((lines >= 1)) || return 1; else ((lines == 1)) || return 1; fi
	! grep -qvxE "$AUTH_LINE_RE" "$file" && ! grep -qiE '^import ' "$file" &&
		[[ -z $(cut -d' ' -f1 "$file" | sort | uniq -d) ]]
}

# Режим wa. и leads.: рабочий Caddyfile, только если готовы оба их файла паролей.
caddy_file() {
	if auth_ready wa && auth_ready leads; then echo Caddyfile; else echo Caddyfile.closed; fi
}

# Режим panel. отдельно от wa. и leads.: открыт, только если готов его файл паролей. Пароль panel не закрывает
# старые панели, и наоборот.
panel_file() {
	if auth_ready panel; then echo panel.caddy; else echo panel.closed.caddy; fi
}

# Проверка Caddyfile из папки deploy (архива или $ROOT/deploy): копия во временной папке, её import ведёт на
# копию caddy/ и на копию нужного файла panel (вместо $PANEL_SITE), проверяет пользователь caddy. Рабочие файлы
# Caddy до этой проверки не меняются.
validate_caddy() {
	local deploy=$1 file panel tmp out
	file=$(caddy_file)
	panel=$(panel_file)
	[[ -f $deploy/$file ]] || fail "нет $deploy/$file"
	[[ -f $deploy/caddy/$panel ]] || fail "нет $deploy/caddy/$panel"
	tmp=$(mktemp -d)
	cp "$deploy/$file" "$tmp/Caddyfile"
	cp -r "$deploy/caddy" "$tmp/caddy"
	cp "$deploy/caddy/$panel" "$tmp/panel-site.caddy"
	sed -i -e "s#^import $ROOT/deploy/caddy/#import $tmp/caddy/#" \
		-e "s#^import $PANEL_SITE\$#import $tmp/panel-site.caddy#" "$tmp/Caddyfile"
	if ! grep -qxF "import $tmp/panel-site.caddy" "$tmp/Caddyfile"; then
		rm -rf "$tmp"
		fail "в $deploy/$file нет строки import $PANEL_SITE: panel.tanbala.kz не подключён"
	fi
	chmod -R a+rX "$tmp"
	if ! out=$(runuser -u caddy -- caddy validate --adapter caddyfile --config "$tmp/Caddyfile" 2>&1); then
		rm -rf "$tmp"
		printf '%s\n' "$out" >&2
		fail "Caddy не принял $deploy/$file: рабочие настройки Caddy не тронуты"
	fi
	rm -rf "$tmp"
}

step_caddy() {
	need_user caddy
	local file panel
	file=$(caddy_file)
	panel=$(panel_file)
	validate_caddy "$ROOT/deploy"
	# Сначала блок panel, потом Caddyfile с его import: перезапуск Caddy в любой момент найдёт оба файла.
	install -m 644 "$ROOT/deploy/caddy/$panel" "$PANEL_SITE"
	install -m 644 "$ROOT/deploy/$file" /etc/caddy/Caddyfile
	systemctl enable caddy
	# reload идёт через сокет API из Caddyfile; если Caddy ещё на старом адресе API, нужен restart.
	systemctl reload caddy || systemctl restart caddy
	if [[ $file == Caddyfile ]]; then
		echo "Caddy: wa. и leads. ведут на panel.tanbala.kz (этап Б)"
	else
		echo "Caddy: wa. и leads. закрыты (503), пока нет обоих их паролей Caddy (open-panels.sh)"
	fi
	if [[ $panel == panel.caddy ]]; then
		echo "Caddy: panel. открыт, строк паролей Caddy: $(wc -l </etc/caddy/auth/panel.caddy)"
	else
		echo "Caddy: panel. закрыт (503), пока нет его паролей Caddy (open-panels.sh panel add <имя>)"
	fi
}

step_db() {
	[[ -f $ROOT/leads/.env ]] || fail "нет $ROOT/leads/.env (deploy/env.md)"
	log "Postgres и Reacher"
	install -d -m 700 /etc/tanbala
	(umask 077 && grep -E '^(POSTGRES|REACHER)_' "$ROOT/leads/.env" >/etc/tanbala/compose.env)
	"${COMPOSE[@]}" up -d --wait
	"${COMPOSE[@]}" ps --format 'table {{.Name}}\t{{.Status}}'
}

# Код, окружения, браузеры и .env почты принадлежат root (служба их только читает), писать она может в data/,
# logs/, .crawl4ai/. Сама папка root: служба не подменит в ней data или .env ссылкой.
step_leads() {
	from_release leads
	need_user tanbala-leads
	local dir=$ROOT/leads py
	log "код почты в $dir"
	install -d -m 750 -o root -g tanbala-leads "$dir"
	sync_tree "$SRC/leads" "$dir" --exclude=/.env --exclude=/data/ --exclude=/logs/ --exclude=/.venv/ \
		--exclude=/.venv-2gis/ --exclude=/.browsers/ --exclude=/.crawl4ai/ --exclude='/*.egg-info/' \
		--exclude=__pycache__/
	log "окружения .venv и .venv-2gis"
	[[ -x $dir/.venv/bin/python ]] || python3 -m venv "$dir/.venv"
	[[ -x $dir/.venv-2gis/bin/python ]] || python3 -m venv "$dir/.venv-2gis"
	py=(--disable-pip-version-check --root-user-action=ignore -q)
	"$dir/.venv/bin/python" -m pip install "${py[@]}" -r "$dir/requirements.lock.txt"
	"$dir/.venv/bin/python" -m pip install "${py[@]}" --no-deps -e "$dir"
	"$dir/.venv-2gis/bin/python" -m pip install "${py[@]}" -r "$dir/requirements-2gis.lock.txt"
	"$dir/.venv/bin/python" -m compileall -q "$dir/tanbala_leads" "$dir/scripts"
	install_leads_browsers "$dir"

	log "права"
	find "$dir" -mindepth 1 -maxdepth 1 ! -name .env ! -name data ! -name logs ! -name .crawl4ai \
		-exec chown -R root:root {} +
	chown root:tanbala-leads "$dir"
	chmod 750 "$dir"
	install -d -m 700 -o tanbala-leads -g tanbala-leads "$dir/data" "$dir/logs" "$dir/.crawl4ai"
	# Папки crawl4ai (кэш, база) создаёт сама служба, от своего имени: в .crawl4ai пишут её браузеры, root туда не ходит.
	runuser -u tanbala-leads -- env HOME="$dir/data/home" bash -c 'mkdir -p "$HOME" && cd / && exec "$@"' _ \
		"$dir/.venv/bin/python" -c 'import tanbala_leads; from crawl4ai.install import setup_home_directory, run_migration
setup_home_directory(); run_migration()' >/dev/null
	start_leads "$dir"
}

# Chromium для crawl4ai (Playwright и patchright) в .browsers и его системные библиотеки. Каждый раз: если браузер
# уже есть, это быстро, а прерванная прошлая загрузка докачается или упадёт с ошибкой, а не молча.
install_leads_browsers() {
	local dir=$1 tool
	log "Chromium для crawl4ai"
	install -d -m 755 -o root -g root "$dir/.browsers"
	for tool in playwright patchright; do
		PLAYWRIGHT_BROWSERS_PATH=$dir/.browsers "$dir/.venv/bin/python" -m "$tool" install --with-deps chromium
	done
}

start_leads() {
	local dir=$1
	if [[ ! -f $dir/.env ]]; then
		echo "нет $dir/.env: служба почты не запущена (deploy/env.md)"
		return
	fi
	# Служба .env только читает: root владелец, группа службы. compose.env (step_db) берётся из него же.
	chown root:tanbala-leads "$dir/.env"
	chmod 640 "$dir/.env"
	systemctl enable tanbala-leads.service
	systemctl restart tanbala-leads.service
	echo "служба tanbala-leads перезапущена"
}

# Папка бота у tanbala-wa (бот пишет в неё счётчик привязок и data/). Поэтому root внутри неё ничего не делает:
# ссылка, подложенная взломанным ботом, увела бы rsync, mkdir или chmod от root на системные файлы. Код, сборка
# и права — всё от имени tanbala-wa; root только готовит копию кода во временной папке.
step_whatsapp() {
	from_release whatsapp
	need_user tanbala-wa
	local dir=$ROOT/whatsapp work state
	# activating — бот в цикле перезапусков: его тоже останавливаем, иначе systemd поднимет его посреди обновления.
	state=$(systemctl show -p ActiveState --value tanbala-whatsapp 2>/dev/null || true)
	case $state in active | activating | reloading) WA_STOPPED=1 ;; esac
	systemctl stop tanbala-whatsapp 2>/dev/null || true
	install -d -m 750 -o tanbala-wa -g tanbala-wa "$dir"
	work=$(mktemp -d)
	cp -a "$SRC/whatsapp" "$work/src"
	chown -R tanbala-wa:tanbala-wa "$work"
	log "код бота, npm ci, сборка, без инструментов разработки (пользователь tanbala-wa)"
	runuser -u tanbala-wa -- env HOME="$work" npm_config_cache="$work/npm" bash -ec '
		rsync -a --delete --exclude=/.env --exclude=/data/ --exclude="/.pairing-attempts.json*" \
			--exclude=/node_modules/ "$1/src/" "$2/"
		chmod 750 "$2"
		mkdir -p -m 700 "$2/data"
		[[ ! -f $2/.env ]] || chmod 600 "$2/.env"
		cd "$2"
		npm ci --no-audit --no-fund
		npm run build
		npm prune --omit=dev --no-audit --no-fund
		node -e "require(\"better-sqlite3\")(\":memory:\").close(); console.log(\"better-sqlite3 работает\")"
	' _ "$work" "$dir"
	rm -rf "$work"
	if ((WA_STOPPED)); then
		systemctl start tanbala-whatsapp
		WA_STOPPED=0
		echo "служба tanbala-whatsapp снова запущена"
	else
		echo "служба tanbala-whatsapp не запускалась (этап 4: привязка по QR только по команде владельца)"
	fi
}

# Консоль держит токены к почте и боту, поэтому права как у почты: код и зависимости принадлежат root, служба их
# только читает, писать может только в data/ (пользователи, сессии, журнал действий). Сама папка root: служба не
# подменит в ней data или .env ссылкой. Собирается на ПК (build-release.sh кладёт console/dist и console/web/dist
# в архив), здесь только зависимости для работы: npm ci без инструментов разработки во временной папке от имени
# tanbala-build (у tanbala-console по nftables нет выхода в интернет, а root чужие пакеты не распаковывает).
# Install-скрипты пакетов не запускаются, суммы пакетов npm сверяет с package-lock.json.
step_console() {
	from_release console
	need_user tanbala-console
	need_user tanbala-build
	local dir=$ROOT/console
	[[ -f $SRC/console/dist/server.js && -f $SRC/console/dist/cli.js && -f $SRC/console/package-lock.json ]] ||
		fail "в архиве нет собранной консоли (console/dist, package-lock.json): архив собирает build-release.sh"
	[[ -f $SRC/console/web/dist/index.html ]] ||
		echo "ВНИМАНИЕ: в архиве нет интерфейса консоли (console/web/dist): будет только API"
	install -d -m 750 -o root -g tanbala-console "$dir"
	CONSOLE_WORK=$(mktemp -d)
	rsync -a --exclude=/node_modules/ --exclude=/.env --exclude=/data/ "$SRC/console/" "$CONSOLE_WORK/src/"
	chown -R tanbala-build:tanbala-build "$CONSOLE_WORK"
	log "зависимости консоли: npm ci без инструментов разработки (пользователь tanbala-build)"
	runuser -u tanbala-build -- env HOME="$CONSOLE_WORK" npm_config_cache="$CONSOLE_WORK/npm" bash -ec '
		umask 022
		cd "$1/src"
		npm ci --omit=dev --ignore-scripts --no-audit --no-fund
	' _ "$CONSOLE_WORK"
	# Дальше папку читает root: ни один процесс tanbala-build не должен успеть подменить в ней что-то ссылкой.
	pkill -KILL -u tanbala-build || true
	chown -R root:root "$CONSOLE_WORK"
	log "код консоли в $dir"
	# Код меняется не под работающей службой: старый и новый код вперемешку не загрузятся. Старт — в start_console.
	systemctl stop tanbala-console 2>/dev/null || true
	# --safe-links: ссылки, ведущие за пределы папки, не копируются.
	sync_tree "$CONSOLE_WORK/src" "$dir" --safe-links --exclude=/.env --exclude=/data/
	rm -rf "$CONSOLE_WORK"
	CONSOLE_WORK=
	log "права"
	# Без записи для группы и остальных и без setuid/setgid из пакетов.
	find "$dir" -mindepth 1 -maxdepth 1 ! -name .env ! -name data -exec chown -R root:root {} + \
		-exec chmod -R go-w,u-s,g-s {} +
	chown root:tanbala-console "$dir"
	chmod 750 "$dir"
	install -d -m 700 -o tanbala-console -g tanbala-console "$dir/data"
	# Native-модуль SQLite приезжает готовым бинарником (install-скрипты выключены): проверка от имени службы,
	# заодно видно, что служба читает код и зависимости.
	if [[ -d $dir/node_modules/better-sqlite3 ]]; then
		runuser -u tanbala-console -- bash -c 'cd "$1" && exec node -e "$2"' _ "$dir" \
			'require("better-sqlite3")(":memory:").close(); console.log("better-sqlite3 работает")'
	fi
	start_console "$dir"
}

start_console() {
	local dir=$1
	if [[ ! -f $dir/.env ]]; then
		echo "нет $dir/.env: служба консоли не запущена (deploy/env.md)"
		return
	fi
	# Служба .env только читает: root владелец, группа службы.
	chown root:tanbala-console "$dir/.env"
	chmod 640 "$dir/.env"
	systemctl enable tanbala-console.service
	systemctl restart tanbala-console.service
	echo "служба tanbala-console перезапущена"
}

on_exit() {
	local code=$?
	[[ -z $CONSOLE_WORK ]] || rm -rf "$CONSOLE_WORK"
	if ((code != 0 && WA_STOPPED)); then
		echo "ВНИМАНИЕ: бот остановлен для обновления и не запущен. После исправления: sudo systemctl start tanbala-whatsapp" >&2
	fi
}

# Подключён из open-panels.sh: только функции, без шагов.
[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

[[ $EUID -eq 0 ]] || fail "запускать от root: sudo bash $0 <шаг>"
(($# > 0)) || fail "укажите шаги: system configs caddy db leads whatsapp console или all (описание в начале файла)"
steps=("$@")
# Консоль последней: её API в почте и боте появляются в шагах leads и whatsapp.
[[ ${steps[*]} != all ]] || steps=(system configs leads whatsapp console)
for step in "${steps[@]}"; do
	case $step in
	system | configs | caddy | db | leads | whatsapp | console) ;;
	*) fail "неизвестный шаг: $step" ;;
	esac
done
trap on_exit EXIT
for step in "${steps[@]}"; do "step_$step"; done
log "готово: ${steps[*]}"
