#!/usr/bin/env bash
#
# Comprehensive installer / updater for the Cable Car Ticket Checker on a Debian/Ubuntu
# Proxmox LXC, exposed via a Cloudflare Tunnel.
#
# Usually invoked through the one-command bootstrap (see deploy/bootstrap.sh):
#   curl -fsSL https://raw.githubusercontent.com/angeeinstein/ticket-manager/main/deploy/bootstrap.sh | sudo bash
#
# Or run directly from a cloned repo:   sudo bash deploy/install.sh
#
# It is idempotent: the FIRST run installs and prompts for configuration; a later run with
# updated code just refreshes the app + dependencies and restarts the service, keeping your
# .env. Pass --reconfigure to re-run the configuration prompts on an existing install.
#
# Flags:
#   --reconfigure     re-ask all configuration questions (rewrites .env), even on update
#   --no-tunnel       skip the Cloudflare Tunnel step
#   --yes             non-interactive: accept all defaults, generate a token, skip tunnel
set -euo pipefail

APP_USER="ticketchecker"
APP_DIR="/opt/ticket-checker"
SERVICE="ticket-checker"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RECONFIGURE=0
DO_TUNNEL=1
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --reconfigure) RECONFIGURE=1 ;;
    --no-tunnel)   DO_TUNNEL=0 ;;
    --yes|-y)      ASSUME_YES=1 ;;
  esac
done

log()  { echo -e "\033[1;36m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m!!\033[0m $*"; }
err()  { echo -e "\033[1;31m!!\033[0m $*" >&2; }
hr()   { echo "------------------------------------------------------------------------"; }

if [[ $EUID -ne 0 ]]; then err "Please run as root (sudo)."; exit 1; fi

# --------------------------------------------------------- interactive helpers
# Read from /dev/tty so prompts work even when the parent was piped from curl. With --yes
# (or no tty) we silently fall back to the default.
ask() { # ask "Question" "default" -> echoes the answer
  local q="$1" def="${2:-}" ans=""
  if [[ $ASSUME_YES -eq 0 && -r /dev/tty ]]; then
    if [[ -n "$def" ]]; then read -r -p "$q [$def]: " ans </dev/tty || true
    else read -r -p "$q: " ans </dev/tty || true; fi
  fi
  echo "${ans:-$def}"
}
ask_secret() { # ask_secret "Question" -> echoes the (hidden) answer
  local q="$1" ans=""
  if [[ $ASSUME_YES -eq 0 && -r /dev/tty ]]; then
    read -r -s -p "$q: " ans </dev/tty || true; echo >/dev/tty
  fi
  echo "$ans"
}
yesno() { # yesno "Question" "Y|N(default)" -> 0 if yes
  local def="${2:-Y}" ans
  ans="$(ask "$1 (y/n)" "$def")"
  [[ "$ans" =~ ^[Yy] ]]
}
menu() { # menu "Title" opt1 opt2 ...  -> echoes the chosen NUMBER (default 1)
  local title="$1"; shift
  if [[ $ASSUME_YES -eq 1 || ! -r /dev/tty ]]; then echo 1; return; fi
  { echo "$title"; local i=1; for o in "$@"; do echo "  $i) $o"; i=$((i+1)); done; } >/dev/tty
  local pick; read -r -p "Choose [1]: " pick </dev/tty || true
  [[ "$pick" =~ ^[0-9]+$ ]] || pick=1
  echo "$pick"
}

# ------------------------------------------------------------------- mode banner
MODE="install"
[[ -f "$APP_DIR/.env" ]] && MODE="update"
hr
if [[ "$MODE" == "update" ]]; then
  log "Existing installation detected in $APP_DIR — UPDATE mode"
  [[ $RECONFIGURE -eq 1 ]] && warn "--reconfigure given: configuration prompts will run again"
else
  log "Fresh installation"
fi
hr

# --------------------------------------------------------------- 1. system deps
log "Installing system dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y python3 python3-venv python3-pip build-essential libzbar0 git curl ca-certificates rsync

# ------------------------------------------------------------------ 2. app user
if ! id "$APP_USER" &>/dev/null; then
  log "Creating service user $APP_USER"
  useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------------------------------------------------------------- 3. app files
log "Syncing application code to $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude '.git' --exclude 'data' --exclude 'inbox' --exclude '.env' --exclude 'venv' --exclude 'src' \
  "$SRC_DIR/backend" "$SRC_DIR/frontend" "$APP_DIR/"
cp "$SRC_DIR/backend/requirements.txt" "$APP_DIR/requirements.txt"
mkdir -p "$APP_DIR/data" "$APP_DIR/inbox/processed/needs_review"

# ---------------------------------------------------------------- 4. .env config
write_env() {
  local event_date="$1" port="$2" walkup="$3" capacity="$4" slotlen="$5"
  sed -e "s|^EVENT_DATE=.*|EVENT_DATE=${event_date}|" \
      -e "s|^PORT=.*|PORT=${port}|" \
      -e "s|^WALKUP_MODE=.*|WALKUP_MODE=${walkup}|" \
      -e "s|^MAX_CAPACITY_PER_SLOT=.*|MAX_CAPACITY_PER_SLOT=${capacity}|" \
      -e "s|^SLOT_LENGTH_MINUTES=.*|SLOT_LENGTH_MINUTES=${slotlen}|" \
      "$SRC_DIR/deploy/.env.example" > "$APP_DIR/.env"
}

if [[ "$MODE" == "install" || $RECONFIGURE -eq 1 ]]; then
  log "Configuration"
  # Preserve current values as defaults when reconfiguring.
  cur() { [[ -f "$APP_DIR/.env" ]] && grep -E "^$1=" "$APP_DIR/.env" | head -1 | cut -d= -f2- || true; }
  def_date="$(cur EVENT_DATE)";        def_date="${def_date:-$(date +%F)}"
  def_port="$(cur PORT)";              def_port="${def_port:-8080}"
  def_walkup="$(cur WALKUP_MODE)";     def_walkup="${def_walkup:-false}"
  def_cap="$(cur MAX_CAPACITY_PER_SLOT)"; def_cap="${def_cap:-0}"
  def_slot="$(cur SLOT_LENGTH_MINUTES)";  def_slot="${def_slot:-15}"

  EVENT_DATE="$(ask "Event date (YYYY-MM-DD)" "$def_date")"

  if yesno "Start with WALK-UP mode ON (record unknown tickets, no import needed)?" \
           "$([[ "$def_walkup" == true ]] && echo Y || echo N)"; then WALKUP=true; else WALKUP=false; fi
  CAPACITY="$(ask "Max riders per window (0 = unlimited)" "$def_cap")"
  SLOTLEN="$(ask "Window / slot length in minutes" "$def_slot")"
  PORT="$(ask "Local port for the backend" "$def_port")"

  write_env "$EVENT_DATE" "$PORT" "$WALKUP" "$CAPACITY" "$SLOTLEN"
  log "Wrote $APP_DIR/.env"
  warn "Protect the public hostname with Cloudflare Access — there is no in-app token."
else
  log "Keeping existing $APP_DIR/.env (use --reconfigure to change it)"
  # Make sure any newly-added keys exist (merge missing lines from the example).
  while IFS= read -r line; do
    key="${line%%=*}"
    [[ "$line" == \#* || -z "$key" ]] && continue
    grep -qE "^${key}=" "$APP_DIR/.env" || echo "$line" >> "$APP_DIR/.env"
  done < "$SRC_DIR/deploy/.env.example"
fi

# --------------------------------------------------------------- 5. python venv
log "Setting up the Python virtualenv and dependencies"
[[ -d "$APP_DIR/venv" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# -------------------------------------------------------------- 6. systemd unit
log "Installing/refreshing the systemd service"
cp "$SRC_DIR/deploy/ticket-checker.service" "/etc/systemd/system/${SERVICE}.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"
sleep 2

PORT_VAL="$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2)"
if curl -fsS "http://127.0.0.1:${PORT_VAL}/api/health" >/dev/null 2>&1; then
  log "Backend healthy on 127.0.0.1:${PORT_VAL}"
else
  err "Backend did not answer on 127.0.0.1:${PORT_VAL}. Recent logs:"
  journalctl -u "$SERVICE" --no-pager --lines=20 || true
fi

# --------------------------------------------------------------- 7. cloudflared
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

setup_tunnel() {
  local choice
  choice="$(menu "Cloudflare Tunnel setup:" \
    "Token connector (simplest — paste a connector token)" \
    "Named tunnel (guided: login in a browser, create + route DNS)" \
    "Skip for now (I'll do it later)")"
  case "$choice" in
    1)
      local token; token="$(ask_secret "Paste the Cloudflare connector token")"
      if [[ -z "$token" ]]; then warn "No token entered — skipping."; return; fi
      cloudflared service install "$token"
      systemctl enable --now cloudflared
      log "cloudflared connector installed. Map the public hostname to http://127.0.0.1:${PORT_VAL} in the dashboard."
      ;;
    2)
      local tname host
      tname="$(ask "Tunnel name" "ticket-checker")"
      host="$(ask "Public hostname (e.g. tickets.example.com)" "")"
      log "A browser login URL will be printed — open it and authorize."
      cloudflared tunnel login </dev/tty
      cloudflared tunnel create "$tname" || warn "Tunnel may already exist; continuing."
      local cred uuid
      uuid="$(cloudflared tunnel list 2>/dev/null | awk -v n="$tname" '$2==n {print $1}' | head -1)"
      cred="$(ls /root/.cloudflared/${uuid}.json 2>/dev/null || ls /root/.cloudflared/*.json 2>/dev/null | head -1)"
      mkdir -p /etc/cloudflared
      cat > /etc/cloudflared/config.yml <<YML
tunnel: ${uuid:-$tname}
credentials-file: ${cred}
ingress:
  - hostname: ${host}
    service: http://127.0.0.1:${PORT_VAL}
  - service: http_status:404
YML
      [[ -n "$host" ]] && cloudflared tunnel route dns "$tname" "$host" || true
      cloudflared service install
      systemctl enable --now cloudflared
      log "Named tunnel '${tname}' configured for https://${host}"
      ;;
    *)
      warn "Skipping tunnel setup."
      ;;
  esac
}

if [[ $DO_TUNNEL -eq 1 && $ASSUME_YES -eq 0 ]]; then
  if systemctl is-active --quiet cloudflared 2>/dev/null; then
    log "cloudflared service already running"
    if [[ $RECONFIGURE -eq 1 ]] && yesno "Reconfigure the Cloudflare Tunnel?" "N"; then setup_tunnel; fi
  elif [[ "$MODE" == "install" || $RECONFIGURE -eq 1 ]]; then
    if yesno "Set up the Cloudflare Tunnel now?" "Y"; then setup_tunnel; fi
  fi
fi

# --------------------------------------------------------------------- 8. summary
hr
log "Done (${MODE})."
cat <<EOF
Backend:       http://127.0.0.1:${PORT_VAL}
Health check:  curl -s http://127.0.0.1:${PORT_VAL}/api/health
Service:       systemctl status ${SERVICE}    |    journalctl -u ${SERVICE} -f
Config:        ${APP_DIR}/.env   (re-run with --reconfigure to change)

Phone setup: open your public HTTPS hostname (behind Cloudflare Access), then
"Add to home screen". Configure capacity and time slots in Settings.

To UPDATE later, just run the same one-command installer again:
  curl -fsSL https://raw.githubusercontent.com/angeeinstein/ticket-manager/main/deploy/bootstrap.sh | sudo bash

REQUIRED: put Cloudflare Access (Zero Trust) in front of the hostname — the app has no
in-app auth, so Access (or at least keeping it off the public internet) is what protects it.
EOF
hr
