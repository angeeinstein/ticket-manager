# Cable Car Ticket Checker

Offline-first ticket scanner for a timed cable-car descent. Customers hold tickets with a
**15-minute time slot** and a **barcode**, and may ride **down** only during their slot or
**after every slot has passed** (free-for-all). The operator scans tickets on an Android
phone and instantly sees **VALID / BLOCKED / EARLY**, with manual override and live delay
control.

- **Phone PWA** is the only operator interface — scanning, delay control, settings,
  statistics, and PDF upload all happen there, and **everything works offline** from a
  local cache.
- **Server** is a pure data layer (FastAPI + SQLite): it parses/stores ticket PDFs and
  syncs the dataset, delay state, settings, and scan log between phones. **No operator UI.**
- Hosted in a **Proxmox LXC**, exposed via a **Cloudflare Tunnel** (HTTPS — required for
  the phone camera).
- Works **with or without imported tickets**: in **walk-up mode** the database is built
  from the scans themselves (see below).

```
backend/   FastAPI data layer: app.py parser.py validity.py db.py watcher.py config.py
frontend/  PWA: index.html app.js validity.js sw.js manifest.json styles.css
deploy/    install.sh + systemd unit + cloudflared example + .env.example
```

## How the validity rule works

A ticket is **VALID** during its slot, or once **all** slots have ended. Between its own
slot end and the last slot end it is **BLOCKED**. Two adjustments:

- **Delay offset** (phone-controlled) shifts *every* slot when the cable car runs late.
- **Grace** (optional minutes before/after) widens each slot.

The exact rule lives in `backend/validity.py` and is mirrored in `frontend/validity.js`
(kept in lock-step; both are covered by tests). Validation runs **on the phone**, so it
works with no network.

## Delay workflow (on the phone, while scanning)

- **Start delay** when the cable car stops → the offset grows live.
- **Stop delay** when it runs again → the downtime is frozen into the offset.
- **Catch up −1 / −5** to shave minutes as throughput recovers.
- **Reset** to return all slots to their original times.

Delay state syncs to the server and to other phones (last-write-wins). A phone always uses
its *local* delay, so it is correct offline even before it syncs.

## Walk-up mode (no imported tickets)

If you can't export the ticket PDFs in time, turn on **Walk-up mode** in the phone's
Settings (it syncs to every phone). Then:

- Scanning an **unknown** barcode **records** it as used instead of rejecting it — the
  database is built from the scans themselves.
- **One-time use is enforced:** re-scanning a recorded barcode shows **ALREADY SCANNED**
  (across phones once synced; redemptions are deduped).
- The **timeslot rule is not checked** for walk-ups (there is no assigned slot), but the
  **capacity stats still work** because they count actual rides-down per real-time window.

Known (imported) tickets continue to get the full VALID/BLOCKED/EARLY timeslot check, so
the two modes can be mixed.

## Capacity & statistics (scan screen)

All computed on-device from the cached tickets + scan log:

- **Capacity this window** — rides-down counted in the current **real-time** 15-min window
  (configurable length) against **Max capacity per window**, with a progress bar that turns
  red when over. This is throughput at the gate, so it is **independent of the delay
  offset** and works in walk-up mode.
- **Current slot scanned / total (%)**, **not-yet**, **no-shows** (slots fully passed,
  never scanned), and **day totals** — these use the live delay offset and need imported
  tickets to be meaningful.

Cross-phone accuracy improves on sync (redemptions sync both ways, deduped).

## Settings (synced, offline)

The phone **Settings** tab controls, and syncs to the server and all phones (each change
applies offline immediately, last-write-wins on reconnect):

- **Walk-up mode** (on/off)
- **Max capacity per window** (riders; 0 = unlimited)
- **Window length** (minutes)
- **Grace before / after** (minutes)
- **Time slots** — the event schedule (see below)

### Time slots

Define the slots in the **Settings** tab — two ways, freely mixable:

- **Generate:** first start time + slot length + (end time **or** number of slots) →
  builds the whole list (e.g. 15-min slots `09:00–09:15`, `09:15–09:30`, …).
- **Manual:** add individual slots by start/end time, or delete any slot.

The schedule defines the **capacity window** (the current configured slot is what
capacity is measured against; if none is defined it falls back to fixed clock-aligned
windows of the configured length). Slots **sync to every phone and apply offline
immediately** — if there's no server connection, the change is stored locally on the PWA
and pushed on reconnect.

## Install & update (one command)

On a fresh Debian/Ubuntu **Proxmox LXC**, run:

```bash
curl -fsSL https://raw.githubusercontent.com/angeeinstein/ticket-manager/main/deploy/bootstrap.sh | sudo bash
```

This bootstraps everything: it installs `git`/`curl`, clones the repo to
`/opt/ticket-checker/src`, then runs the full installer, which:

- installs system deps (incl. `libzbar0`), a Python venv, and the dependencies;
- **interactively asks** for configuration (event date, scanner token — generated or your
  own, walk-up mode, capacity, slot length, port);
- installs and starts the `ticket-checker` **systemd** service (uvicorn on
  `127.0.0.1:<port>`) and health-checks it;
- installs `cloudflared` and walks you through the **Cloudflare Tunnel** (token connector,
  guided named tunnel, or skip).

**To update later, run the exact same command.** The bootstrap re-fetches the latest code
from GitHub and the installer detects the existing install, refreshes the app + deps, and
restarts the service — keeping your `.env`. Add flags after `bash -s --`:

```bash
# Update from a specific branch, or re-run the config prompts:
curl -fsSL .../deploy/bootstrap.sh | sudo BRANCH=main bash
curl -fsSL .../deploy/bootstrap.sh | sudo bash -s -- --reconfigure
```

Non-interactive: append `-s -- --yes` (accepts defaults, generates a token, skips the
tunnel). Private repo: pass `GITHUB_TOKEN=...` before `bash`.

You can also run it from a manual checkout: `sudo bash deploy/install.sh`.

**Recommended:** also put **Cloudflare Access** (Zero Trust) in front of the hostname.

## Using it

1. On the Android phone, open `https://<your-hostname>/`, go to **Settings**, paste the
   scanner token, tap **Save token & sync**, then **Add to home screen**.
2. **Add tickets (optional):** on the **Add** tab, upload ticket PDFs (sales continue until
   slots start). You can also drop PDFs into `/opt/ticket-checker/inbox/` (e.g. via
   SFTP/Samba or an email-to-folder rule) — the watcher ingests them automatically. **No
   PDFs?** Turn on **Walk-up mode** in Settings and just scan — the database builds itself.
3. **Scan:** the **Scan** tab shows the camera + live stats. Scan a ticket → big
   green/red result. On BLOCKED/EARLY, **Allow anyway** records a manual override.
4. **Delays:** use the delay buttons on the scan screen as the cable car situation changes.

## Ticket PDF parser

`backend/parser.py` extracts the barcode + time slot, driven by `parser_config`
(regex/strategy in `backend/config.py`, overridable via `PARSER_CONFIG_PATH`). It reads the
text layer first and falls back to decoding an embedded barcode **image** (`pyzbar`).

> **Before going live:** tune the parser to a real ticket and confirm the value it extracts
> equals what the phone camera reads from the printed barcode. Add the sample as a test
> fixture (see `backend/tests/`).

## Development / tests

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r backend/requirements.txt pytest httpx
python -m pytest backend/tests -q          # parser + validity
uvicorn backend.app:app --reload           # run locally at http://127.0.0.1:8000
```
