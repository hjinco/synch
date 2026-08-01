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
# Safe to re-run: re-running updates the code/dependencies and restarts the
# service without touching an existing .env or data directory.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
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

log "Installing Node.js ${NODE_MAJOR}.x and a build toolchain"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ] 2>/dev/null; then
	apt-get update
	apt-get install -y ca-certificates curl gnupg
	curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
	apt-get install -y nodejs
else
	echo "node $(node -v) already installed, skipping NodeSource setup"
fi
apt-get install -y python3 make g++

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

log "Installing production dependencies"
cd "$REPO_ROOT"
pnpm install --frozen-lockfile --filter @synch/api... --prod

log "Creating service user and data directory"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
mkdir -p "$DATA_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

log "Setting up .env"
if [ ! -f "$SCRIPT_DIR/.env" ]; then
	cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
	PUBLIC_URL="http://$(hostname -I 2>/dev/null | awk '{print $1}'):${PORT}"
	[ -n "${PUBLIC_URL:-}" ] || PUBLIC_URL="http://localhost:${PORT}"
	sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=${PUBLIC_URL}#" "$SCRIPT_DIR/.env"
	sed -i "s#^BETTER_AUTH_SECRET=.*#BETTER_AUTH_SECRET=$(openssl rand -hex 32)#" "$SCRIPT_DIR/.env"
	sed -i "s#^SYNC_TOKEN_SECRET=.*#SYNC_TOKEN_SECRET=$(openssl rand -hex 32)#" "$SCRIPT_DIR/.env"
	echo "generated $SCRIPT_DIR/.env with PUBLIC_URL=${PUBLIC_URL} - edit it (especially PUBLIC_URL) before relying on this in production"
else
	echo "$SCRIPT_DIR/.env already exists, leaving it as-is"
fi
chown "$SERVICE_USER:$SERVICE_USER" "$SCRIPT_DIR/.env"
chmod 600 "$SCRIPT_DIR/.env"

log "Installing systemd unit"
sed \
	-e "s#/opt/synch/apps/api#${SCRIPT_DIR}#g" \
	-e "s#^User=.*#User=${SERVICE_USER}#" \
	-e "s#^Group=.*#Group=${SERVICE_USER}#" \
	-e "s#^Environment=DATA_DIR=.*#Environment=DATA_DIR=${DATA_DIR}#" \
	-e "s#^ReadWritePaths=.*#ReadWritePaths=${DATA_DIR}#" \
	"$SCRIPT_DIR/synch-api.service.example" > "$UNIT_PATH"
systemctl daemon-reload
systemctl enable --now synch-api

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
