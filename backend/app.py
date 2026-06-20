"""FastAPI application — the data layer for the cable car ticket checker.

This server has NO operator UI. It only:
  * parses & stores ticket PDFs (upload endpoint + watched folder)
  * syncs the ticket dataset + delay state + redemptions to phones
  * receives delay updates and scan logs from phones
  * serves the PWA static files

All operator interaction happens in the phone PWA. All validation/delay math also runs
on the phone (see frontend/validity.js); the server mirror in validity.py exists for tests.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import db
from .config import settings
from .parser import OK, parse_ticket
from .watcher import InboxWatcher

app = FastAPI(title="Cable Car Ticket Checker", docs_url=None, redoc_url=None)

_watcher: InboxWatcher | None = None


@app.middleware("http")
async def no_cache_shell(request, call_next):
    """Never let the browser HTTP cache or an upstream CDN (Cloudflare) pin a stale PWA
    shell or, critically, a stale service worker — that is what leaves a deployed update
    unreachable on a phone. Offline support is provided by the service worker's own Cache
    Storage, so disabling HTTP caching of these files is safe.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


# ------------------------------------------------------------------- auth dependency

def require_token(
    x_scanner_token: Optional[str] = Header(default=None),
    token: Optional[str] = Query(default=None),
) -> None:
    """Require the shared scanner token on /api/* calls (unless auth is disabled)."""
    expected = settings.scanner_token
    if not expected:
        return  # auth disabled (not recommended on a public tunnel)
    provided = x_scanner_token or token
    if provided != expected:
        raise HTTPException(status_code=401, detail="invalid or missing scanner token")


# ------------------------------------------------------------------------ lifecycle

@app.on_event("startup")
def _startup() -> None:
    global _watcher
    settings.ensure_dirs()
    db.init_db(
        settings.db_path,
        settings.event_date,
        settings.grace_before_minutes,
        settings.grace_after_minutes,
        settings.max_capacity_per_slot,
        settings.slot_length_minutes,
        settings.walkup_mode,
    )
    if settings.watch_enabled:
        _watcher = InboxWatcher(
            inbox=settings.inbox_dir,
            processed=settings.processed_dir,
            parser_config=settings.parser_config(),
            event_date=settings.event_date,
            interval=settings.watch_interval_seconds,
        )
        _watcher.start()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _watcher is not None:
        _watcher.stop()


# --------------------------------------------------------------------------- models

class DelayUpdate(BaseModel):
    delay_base_minutes: int
    delay_running_since: Optional[str] = None  # ISO datetime or null
    updated_at: str  # ISO datetime — drives last-write-wins
    updated_by: str  # device id


class Slot(BaseModel):
    start: str  # "HH:MM"
    end: str    # "HH:MM"


class SettingsUpdate(BaseModel):
    grace_before_minutes: int = 0
    grace_after_minutes: int = 0
    max_capacity_per_slot: int = 0   # 0 = unlimited / not set
    slot_length_minutes: int = 15
    walkup_mode: bool = False
    slots: list[Slot] = []           # the event time-slot schedule
    updated_at: str  # ISO datetime — drives last-write-wins (own settings timestamp)
    updated_by: str  # device id


class Redemption(BaseModel):
    barcode: str
    scanned_at: str
    device_id: str
    result: str = "valid"
    override_reason: Optional[str] = None


class RedeemBatch(BaseModel):
    redemptions: list[Redemption]


# --------------------------------------------------------------------------- routes

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "tickets": db.count_tickets(), "data_version": db.get_data_version()}


@app.get("/api/sync", dependencies=[Depends(require_token)])
def sync(since: int = Query(default=0)) -> JSONResponse:
    """Return the full snapshot. `since` lets the phone skip the body when unchanged."""
    version = db.get_data_version()
    if since and since >= version:
        return JSONResponse({"unchanged": True, "data_version": version})
    return JSONResponse(db.sync_snapshot())


@app.post("/api/ingest", dependencies=[Depends(require_token)])
async def ingest(files: list[UploadFile] = File(...)) -> dict:
    """Parse uploaded PDFs and upsert tickets. Returns a per-file result for the phone."""
    results = []
    cfg = settings.parser_config()
    for f in files:
        data = await f.read()
        res = parse_ticket(data, cfg, settings.event_date)
        if res["status"] == OK:
            db.upsert_ticket(
                barcode=res["barcode"],
                slot_start=res["slot_start"],
                slot_end=res["slot_end"],
                source_file=f.filename,
                raw_text=res.get("raw_text"),
            )
        results.append(
            {
                "filename": f.filename,
                "status": res["status"],
                "barcode": res.get("barcode"),
                "slot_start": res.get("slot_start"),
                "slot_end": res.get("slot_end"),
                "error": res.get("error"),
            }
        )
    ok = sum(1 for r in results if r["status"] == OK)
    return {"ingested": ok, "total": len(results), "data_version": db.get_data_version(), "results": results}


@app.get("/api/config", dependencies=[Depends(require_token)])
def get_config() -> dict:
    snap = db.sync_snapshot()
    return {"delay": snap["delay"], "settings": snap["settings"], "data_version": snap["data_version"]}


@app.put("/api/config", dependencies=[Depends(require_token)])
def put_config(update: DelayUpdate) -> dict:
    state = db.update_delay_state(
        delay_base_minutes=update.delay_base_minutes,
        delay_running_since=update.delay_running_since,
        updated_at=update.updated_at,
        updated_by=update.updated_by,
    )
    return {
        "delay_base_minutes": int(state.get("delay_base_minutes", "0")),
        "delay_running_since": state.get("delay_running_since") or None,
        "updated_at": state.get("delay_updated_at"),
        "updated_by": state.get("delay_updated_by"),
        "data_version": int(state.get("data_version", "1")),
    }


@app.put("/api/settings", dependencies=[Depends(require_token)])
def put_settings(update: SettingsUpdate) -> dict:
    state = db.update_settings_state(
        grace_before_minutes=update.grace_before_minutes,
        grace_after_minutes=update.grace_after_minutes,
        max_capacity_per_slot=update.max_capacity_per_slot,
        slot_length_minutes=update.slot_length_minutes,
        walkup_mode=update.walkup_mode,
        slots=[s.model_dump() for s in update.slots],
        updated_at=update.updated_at,
        updated_by=update.updated_by,
    )
    return db.sync_snapshot()["settings"] | {"data_version": int(state.get("data_version", "1"))}


@app.post("/api/redeem", dependencies=[Depends(require_token)])
def redeem(batch: RedeemBatch) -> dict:
    added = db.add_redemptions([r.model_dump() for r in batch.redemptions])
    return {"added": added, "data_version": db.get_data_version()}


# The PWA static files. Mounted LAST so /api/* routes take precedence. html=True serves
# index.html at "/". The PWA shell is public; the API requires the scanner token.
app.mount("/", StaticFiles(directory=str(settings.frontend_dir), html=True), name="frontend")
