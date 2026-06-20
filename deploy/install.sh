#!/usr/bin/env bash
#
# Install the Cable Car Ticket Checker on a Debian/Ubuntu Proxmox LXC and expose it via a
# Cloudflare Tunnel. Idempotent — safe to re-run to update.
#
# Run as root from inside the cloned repo:   sudo bash deploy/install.sh
#
set -euo pipefail

APP_USER="ticketchecker"
APP_DIR="/opt/ticket-checker"
SERVICE="ticket-checker"
# Repo root = parent of this script's directory.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { echo -e "\033[1;36m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m!!\033[0m $*"; }

if [[ $EUID -ne 0 ]]; then echo "Please run as root (sudo)."; exit 1; fi

# --------------------------------------------------------------- 1. system deps
log "Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip build-essential libzbar0 git curl ca-certificates

# ------------------------------------------------------------------ 2. app user
if ! id "$APP_USER" &>/dev/null; then
  log "Creating service user $APP_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# --------------------------------------------------------------- 3. app files
log "Copying application to $APP_DIR"
mkdir -p "$APP_DIR"
# Copy code (backend, frontend, requirements). Preserve runtime data/ and .env.
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'inbox' --exclude '.env' --exclude 'venv' \
  "$SRC_DIR/backend" "$SRC_DIR/frontend" "$APP_DIR/"
cp "$SRC_DIR/backend/requirements.txt" "$APP_DIR/requirements.txt"

mkdir -p "$APP_DIR/data" "$APP_DIR/inbox/processed/needs_review"

# .env
if [[ ! -f "$APP_DIR/.env" ]]; then
  log "Creating .env with a generated scanner token"
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')"
  sed "s|^SCANNER_TOKEN=.*|SCANNER_TOKEN=${TOKEN}|; s|^EVENT_DATE=.*|EVENT_DATE=$(date +%F)|" \
    "$SRC_DIR/deploy/.env.example" > "$APP_DIR/.env"
  warn "Your scanner token (enter this in the phone app Settings):  ${TOKEN}"
else
  log ".env already exists — leaving it untouched"
fi

# ------------------------------------------------------------- 4. python venv
log "Setting up Python virtualenv"
if [[ ! -d "$APP_DIR/venv" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi
"$APP_DIR/venv/bin/pip" install --upgrade pip
"$APP_DIR/venv/bin/pip" install -r "$APP_DIR/requirements.txt"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# -------------------------------------------------------------- 5. systemd unit
log "Installing systemd service"
cp "$SRC_DIR/deploy/ticket-checker.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager --lines=5 status "$SERVICE" || true

# --------------------------------------------------------------- 6. cloudflared
if ! command -v cloudflared &>/dev/null; then
  log "Installing cloudflared"
  mkdir -p /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -y && apt-get install -y cloudflared
else
  log "cloudflared already installed"
fi

PORT_VAL="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2)"
cat <<EOF

Backend is running on 127.0.0.1:${PORT_VAL} (see .env).
Health check:   curl -s http://127.0.0.1:${PORT_VAL}/api/health

------------------------------------------------------------------------
NEXT: connect the Cloudflare Tunnel (gives you a public HTTPS URL the phone uses)

Option A — token connector (simplest):
  1. In Cloudflare Zero Trust dashboard: Networks > Tunnels > Create tunnel.
  2. Add a public hostname (e.g. tickets.example.com) -> service http://127.0.0.1:${PORT_VAL}
  3. Copy the connector token, then on this box run:
         sudo cloudflared service install TOKEN
         sudo systemctl enable --now cloudflared

Option B — named tunnel (config file):
  sudo cloudflared tunnel login
  sudo cloudflared tunnel create ticket-checker
  sudo cp ${SRC_DIR}/deploy/cloudflared-config.example.yml /etc/cloudflared/config.yml   # then edit
  sudo cloudflared tunnel route dns ticket-checker tickets.example.com
  sudo cloudflared service install && sudo systemctl enable --now cloudflared

STRONGLY RECOMMENDED: put Cloudflare Access (Zero Trust) in front of the hostname so only
your operators can reach it, in addition to the scanner token.

Then open https://tickets.example.com on the Android phone, enter the scanner token in
Settings, and "Add to home screen".
------------------------------------------------------------------------
EOF
