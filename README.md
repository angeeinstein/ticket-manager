# Cable Car Ticket Checker

Offline-first ticket scanner for a timed cable-car descent. Customers hold tickets with a
**15-minute time slot** and a **barcode**, and may ride **down** only during their slot or
**after every slot has passed** (free-for-all). The operator scans tickets on an Android
phone and instantly sees **VALID / BLOCKED / EARLY**, with manual override and live delay
control.

- **Phone PWA** is the only operator interface — scanning, delay control, statistics, and
  PDF upload all happen there, and **everything works offline** from a local cache.
- **Server** is a pure data layer (FastAPI + SQLite): it parses/stores ticket PDFs and
  syncs the dataset, delay state, and scan log between phones. **No operator UI.**
- Hosted in a **Proxmox LXC**, exposed via a **Cloudflare Tunnel** (HTTPS — required for
  the phone camera).

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

## Statistics (scan screen)

Computed on-device from the cached tickets + scan log, using the live offset:
current-slot **scanned / total (%)** with a progress bar, **not-yet**, **no-shows**
(slots fully passed, never scanned), and **day totals**. Cross-phone accuracy improves on
sync (redemptions sync both ways, deduped).

## Install (Proxmox LXC, Debian/Ubuntu)

```bash
git clone <this repo> ticket-manager && cd ticket-manager
sudo bash deploy/install.sh
```

The script installs system deps (incl. `libzbar0`), a Python venv, a `ticket-checker`
systemd service (uvicorn on `127.0.0.1:8080`), and `cloudflared`. It generates a
**scanner token** and prints it — you enter that token in the phone app's Settings.

Then connect the tunnel (the script prints the exact commands). In short:

```bash
# Cloudflare Zero Trust dashboard: create a tunnel + public hostname -> http://127.0.0.1:8080
sudo cloudflared service install <CONNECTOR_TOKEN>
sudo systemctl enable --now cloudflared
```

**Recommended:** put **Cloudflare Access** in front of the hostname in addition to the
scanner token. Edit `/opt/ticket-checker/.env` to set `EVENT_DATE` and other options, then
`sudo systemctl restart ticket-checker`.

## Using it

1. On the Android phone, open `https://<your-hostname>/`, go to **Settings**, paste the
   scanner token, tap **Save token & sync**, then **Add to home screen**.
2. **Add tickets:** on the **Add** tab, upload ticket PDFs (sales continue until slots
   start). You can also drop PDFs into `/opt/ticket-checker/inbox/` (e.g. via SFTP/Samba or
   an email-to-folder rule) — the watcher ingests them automatically.
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
