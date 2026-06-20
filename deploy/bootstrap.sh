#!/usr/bin/env bash
#
# One-command bootstrap for the Cable Car Ticket Checker.
#
# It fetches the LATEST code from GitHub and hands off to the full installer. Run the exact
# same command to INSTALL the first time or to UPDATE to the newest pushed version — the
# installer is idempotent and detects which one it is.
#
#   curl -fsSL https://raw.githubusercontent.com/angeeinstein/ticket-manager/main/deploy/bootstrap.sh | sudo bash
#
# Options (env vars, place before `bash`):
#   BRANCH=some-branch   install/update from a specific branch (default: main)
#   REPO_URL=...         clone from a different git URL (e.g. a private mirror)
#   GITHUB_TOKEN=...     for a private repo (used for clone + raw fetch)
#   ACTION=update        force update path (default: auto-detect)
#
# Anything after `bash -s --` is forwarded to install.sh (e.g. `--reconfigure`).
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-angeeinstein/ticket-manager}"
BRANCH="${BRANCH:-main}"
GITHUB_TOKEN="${GITHUB_TOKEN:-}"
SRC_DIR="${SRC_DIR:-/opt/ticket-checker/src}"

if [[ -n "$GITHUB_TOKEN" ]]; then
  REPO_URL="${REPO_URL:-https://${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git}"
else
  REPO_URL="${REPO_URL:-https://github.com/${REPO_SLUG}.git}"
fi

log()  { echo -e "\033[1;36m==>\033[0m $*"; }
err()  { echo -e "\033[1;31m!!\033[0m $*" >&2; }

if [[ $EUID -ne 0 ]]; then err "Please run as root (use sudo)."; exit 1; fi

# ----------------------------------------------------------------- prerequisites
export DEBIAN_FRONTEND=noninteractive
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  log "Installing git and curl"
  apt-get update -y
  apt-get install -y git curl ca-certificates
fi

# --------------------------------------------------------------- fetch / update
mkdir -p "$(dirname "$SRC_DIR")"
if [[ -d "$SRC_DIR/.git" ]]; then
  log "Updating existing checkout in $SRC_DIR (branch: $BRANCH)"
  git -C "$SRC_DIR" remote set-url origin "$REPO_URL"
  git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$SRC_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
  git -C "$SRC_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_SLUG (branch: $BRANCH) into $SRC_DIR"
  rm -rf "$SRC_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
fi

REV="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
log "Now at commit $REV — launching installer"

# Hand off to the freshly-fetched installer. exec from a real file (not the curl pipe) so
# it can prompt interactively on /dev/tty.
exec bash "$SRC_DIR/deploy/install.sh" "$@"
