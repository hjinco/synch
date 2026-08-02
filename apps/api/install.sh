#!/usr/bin/env bash
#
# Installs and starts the self-hosted Synch API as a systemd service.
# Tested on Debian/Ubuntu; should work on other apt-based distros with
# systemd. For other Linux distros, follow the manual steps in
# apps/www/src/content/docs/self-hosting-docker/en.mdx instead.
#
# Usage (from a clone of the repo, run as root or with sudo):
#   cd synch/apps/api
#   sudo ./install.sh
#
# The app is deployed to $INSTALL_DIR (default /opt/synch), NOT run in place
# from wherever you cloned it - the systemd service runs as an unprivileged
# user, and cloning under e.g. /root would leave it unable to even chdir into
# its own working directory. Re-running (e.g. after `git pull` in your
# original clone) re-syncs the code into $INSTALL_DIR and restarts the
# service; it never touches an existing .env or the data directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/synch}"
API_DIR="$INSTALL_DIR/apps/api"
SERVICE_USER="synch"
DATA_DIR="/var/lib/synch-api"
UNIT_PATH="/etc/systemd/system/synch-api.service"
NODE_MAJOR="24"
PORT="${PORT:-8787}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo ./install.sh)"
[ -f "$SCRIPT_DIR/package.json" ] || die "expected to find package.json next to this script"
command -v systemctl >/dev/null 2>&1 || die "systemd not found - see the Docker Compose path in the self-hosting docs instead"

if [ ! -f /etc/debian_version ]; then
	echo "warning: this script is written for Debian/Ubuntu; continuing anyway, but apt-based steps may fail." >&2
fi

log "Installing Node.js ${NODE_MAJOR}.x, a build toolchain, and rsync"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ] 2>/dev/null; then
	apt-get update
	apt-get install -y ca-certificates curl gnupg
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
	apt-get install -y nodejs
else
	echo "node $(node -v) already installed, skipping NodeSource setup"
fi
apt-get install -y python3 make g++ rsync

log "Installing pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
	# corepack isn't bundled with node on some distro packages - fall back to
	# installing pnpm directly via npm if `corepack enable` doesn't work.
	if command -v corepack >/dev/null 2>&1 && corepack enable 2>/dev/null; then
		:
	else
		npm install -g pnpm@10.33.0
	fi
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm still not on PATH after install"

log "Creating service user and data directory"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

log "Deploying to $INSTALL_DIR"
if [ "$REPO_ROOT" != "$INSTALL_DIR" ]; then
	mkdir -p "$INSTALL_DIR"
	rsync -a --delete \
		--exclude='.git' \
		--exclude='node_modules' \
		--exclude='apps/api/.env' \
		--exclude='apps/api/data' \
		"$REPO_ROOT"/ "$INSTALL_DIR"/
fi

log "Installing production dependencies"
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile --filter @synch/api... --prod

log "Setting up .env"
if [ ! -f "$API_DIR/.env" ]; then
	cp "$API_DIR/.env.example" "$API_DIR/.env"
	PUBLIC_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
	[ -n "${PUBLIC_URL:-}" ] || PUBLIC_URL="http://localhost:${PORT}"
	sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=${PUBLIC_URL}#" "$API_DIR/.env"
	sed -i "s#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=$(openssl rand -hex 32)#" "$API_DIR/.env"
	sed -i "s#^SYNC_TOKEN_SECRET=.*#SYNC_TOKEN_SECRET=$(openssl rand -hex 32)#" "$API_DIR/.env"
	echo "generated $API_DIR/.env with PUBLIC_URL=${PUBLIC_URL} - edit it (especially PUBLIC_URL) before relying on this in production"
else
	echo "$API_DIR/.env already exists, leaving it as-is"
fi

log "Locking down $INSTALL_DIR"
# $SERVICE_USER needs to read and traverse the app + its dependencies, but
# never to write to them - the running service shouldn't be able to modify
# its own code.
chown -R root:"$SERVICE_USER" "$INSTALL_DIR"
chmod -R g+rX,o-rwx "$INSTALL_DIR"
# Applied after the recursive chmod above (which would otherwise make it
# group-readable): systemd itself (running as root) reads EnvironmentFile
# before dropping privileges to $SERVICE_USER to exec the app, so the app
# process never needs - and shouldn't have - filesystem access to secrets.
chown root:root "$API_DIR/.env"
chmod 600 "$API_DIR/.env"

log "Installing systemd unit"
sed \
	-e "s#/opt/synch/apps/api#${API_DIR}#g" \
	-e "s#^User=.*#User=${SERVICE_USER}#" \
	-e "s#^Group=.*#Group=${SERVICE_USER}#" \
	-e "s#^Environment=DATA_DIR=.*#Environment=DATA_DIR=${DATA_DIR}#" \
	-e "s#^ReadWritePaths=.*#ReadWritePaths=${DATA_DIR}#" \
	"$API_DIR/synch-api.service.example" > "$UNIT_PATH"
systemctl daemon-reload
systemctl enable synch-api
# `restart` also starts an inactive unit, while ensuring a re-run after an
# upgrade replaces the process that still has the previous code loaded.
systemctl restart synch-api

log "Waiting for the server to come up"
for _ in $(seq 1 20); do
	if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
		echo "synch-api is up: http://localhost:${PORT}/health"
		exit 0
	fi
	sleep 1
done

echo "synch-api did not respond on :${PORT} within 20s - check: journalctl -u synch-api -f" >&2
exit 1
