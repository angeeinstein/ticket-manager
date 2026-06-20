"""SQLite data layer for the ticket checker.

Three concerns live here:
  * tickets      - barcode -> assigned 15-minute slot (the source of truth, from PDFs)
  * redemptions  - every scan/override (audit + cross-phone live statistics)
  * app_state    - key/value: the global delay state, grace, event date, data_version

`data_version` is a monotonically increasing integer bumped on every change to tickets,
redemptions, or delay/grace state. Phones pass their last seen version to /api/sync and
get back everything (the dataset is small, so we send a full snapshot).
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

_lock = threading.Lock()
_conn: sqlite3.Connection | None = None
_db_path: Path | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_slots(raw: str) -> list:
    """Parse the stored slots JSON, tolerating bad data rather than breaking sync."""
    try:
        val = json.loads(raw or "[]")
        return val if isinstance(val, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def init_db(
    db_path: Path,
    event_date: str,
    grace_before: int,
    grace_after: int,
    max_capacity_per_slot: int = 0,
    slot_length_minutes: int = 15,
    walkup_mode: bool = False,
    manual_entry: bool = False,
) -> None:
    """Open the connection and create the schema. Safe to call once at startup."""
    global _conn, _db_path
    _db_path = db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    _conn = sqlite3.connect(str(db_path), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.execute("PRAGMA journal_mode=WAL;")
    _conn.execute("PRAGMA foreign_keys=ON;")
    _conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS tickets (
            barcode     TEXT PRIMARY KEY,
            slot_start  TEXT NOT NULL,   -- ISO datetime
            slot_end    TEXT NOT NULL,   -- ISO datetime
            source_file TEXT,
            raw_text    TEXT,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS redemptions (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            barcode         TEXT NOT NULL,
            scanned_at      TEXT NOT NULL,   -- ISO datetime (when the scan happened)
            device_id       TEXT NOT NULL,
            result          TEXT NOT NULL,   -- valid | blocked | early | override
            override_reason TEXT,
            created_at      TEXT NOT NULL,
            UNIQUE (barcode, device_id, scanned_at)  -- dedup re-synced scans
        );

        CREATE TABLE IF NOT EXISTS app_state (
            key   TEXT PRIMARY KEY,
            value TEXT
        );
        """
    )
    _conn.commit()
    _seed_state(
        event_date, grace_before, grace_after,
        max_capacity_per_slot, slot_length_minutes, walkup_mode, manual_entry,
    )


def _seed_state(
    event_date: str,
    grace_before: int,
    grace_after: int,
    max_capacity_per_slot: int,
    slot_length_minutes: int,
    walkup_mode: bool,
    manual_entry: bool,
) -> None:
    defaults = {
        "data_version": "1",
        "event_date": event_date,
        "delay_base_minutes": "0",
        "delay_running_since": "",  # empty = not running
        "delay_updated_at": _now_iso(),
        "delay_updated_by": "server",
        # Settings group (own last-write-wins timestamp; see update_settings_state).
        "grace_before_minutes": str(grace_before),
        "grace_after_minutes": str(grace_after),
        "max_capacity_per_slot": str(max_capacity_per_slot),
        "slot_length_minutes": str(slot_length_minutes),
        "walkup_mode": "1" if walkup_mode else "0",
        "manual_entry": "1" if manual_entry else "0",
        "slots": "[]",  # JSON list of {"start":"HH:MM","end":"HH:MM"} — the event schedule
        "settings_updated_at": _now_iso(),
        "settings_updated_by": "server",
    }
    assert _conn is not None
    cur = _conn.execute("SELECT key FROM app_state")
    existing = {r["key"] for r in cur.fetchall()}
    for k, v in defaults.items():
        if k not in existing:
            _conn.execute("INSERT INTO app_state (key, value) VALUES (?, ?)", (k, v))
    _conn.commit()


def _conn_required() -> sqlite3.Connection:
    if _conn is None:
        raise RuntimeError("db.init_db() has not been called")
    return _conn


# --------------------------------------------------------------------------- state

def get_state() -> dict[str, str]:
    conn = _conn_required()
    with _lock:
        rows = conn.execute("SELECT key, value FROM app_state").fetchall()
    return {r["key"]: r["value"] for r in rows}


def _set_state_locked(updates: dict[str, str]) -> None:
    conn = _conn_required()
    for k, v in updates.items():
        conn.execute(
            "INSERT INTO app_state (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (k, str(v)),
        )


def _bump_version_locked() -> int:
    conn = _conn_required()
    row = conn.execute("SELECT value FROM app_state WHERE key='data_version'").fetchone()
    version = int(row["value"]) + 1 if row else 1
    conn.execute(
        "INSERT INTO app_state (key, value) VALUES ('data_version', ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (str(version),),
    )
    return version


def get_data_version() -> int:
    return int(get_state().get("data_version", "1"))


def update_delay_state(
    delay_base_minutes: int,
    delay_running_since: str | None,
    updated_at: str,
    updated_by: str,
) -> dict:
    """Apply a delay update from a phone using last-write-wins by `updated_at`.

    Returns the resulting state (whether or not this update won) plus data_version.
    """
    conn = _conn_required()
    with _lock:
        current = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM app_state").fetchall()}
        current_ts = current.get("delay_updated_at", "")
        # Only apply if this update is newer than what we have (last-write-wins).
        if updated_at >= current_ts:
            updates = {
                "delay_base_minutes": str(max(0, int(delay_base_minutes))),
                "delay_running_since": delay_running_since or "",
                "delay_updated_at": updated_at,
                "delay_updated_by": updated_by,
            }
            _set_state_locked(updates)
            _bump_version_locked()
        conn.commit()
        rows = conn.execute("SELECT key, value FROM app_state").fetchall()
    return {r["key"]: r["value"] for r in rows}


def update_settings_state(
    grace_before_minutes: int,
    grace_after_minutes: int,
    max_capacity_per_slot: int,
    slot_length_minutes: int,
    walkup_mode: bool,
    manual_entry: bool,
    slots: list | None,
    updated_at: str,
    updated_by: str,
) -> dict:
    """Apply a settings update from a phone using last-write-wins by `settings_updated_at`.

    Settings live in their own group with their own timestamp so that frequent delay
    changes never clobber an operator's (rare) settings change and vice-versa.
    """
    conn = _conn_required()
    with _lock:
        current = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM app_state").fetchall()}
        if updated_at >= current.get("settings_updated_at", ""):
            updates = {
                "grace_before_minutes": str(max(0, int(grace_before_minutes))),
                "grace_after_minutes": str(max(0, int(grace_after_minutes))),
                "max_capacity_per_slot": str(max(0, int(max_capacity_per_slot))),
                "slot_length_minutes": str(max(1, int(slot_length_minutes))),
                "walkup_mode": "1" if walkup_mode else "0",
                "manual_entry": "1" if manual_entry else "0",
                "slots": json.dumps(slots if slots is not None else []),
                "settings_updated_at": updated_at,
                "settings_updated_by": updated_by,
            }
            _set_state_locked(updates)
            _bump_version_locked()
        conn.commit()
        rows = conn.execute("SELECT key, value FROM app_state").fetchall()
    return {r["key"]: r["value"] for r in rows}


# --------------------------------------------------------------------------- tickets

def upsert_ticket(
    barcode: str,
    slot_start: str,
    slot_end: str,
    source_file: str | None,
    raw_text: str | None,
) -> None:
    conn = _conn_required()
    now = _now_iso()
    with _lock:
        conn.execute(
            """
            INSERT INTO tickets (barcode, slot_start, slot_end, source_file, raw_text, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(barcode) DO UPDATE SET
                slot_start=excluded.slot_start,
                slot_end=excluded.slot_end,
                source_file=excluded.source_file,
                raw_text=excluded.raw_text,
                updated_at=excluded.updated_at
            """,
            (barcode, slot_start, slot_end, source_file, raw_text, now, now),
        )
        _bump_version_locked()
        conn.commit()


def get_tickets() -> list[dict[str, Any]]:
    conn = _conn_required()
    with _lock:
        rows = conn.execute(
            "SELECT barcode, slot_start, slot_end, source_file, updated_at FROM tickets"
        ).fetchall()
    return [dict(r) for r in rows]


def count_tickets() -> int:
    conn = _conn_required()
    with _lock:
        return conn.execute("SELECT COUNT(*) AS n FROM tickets").fetchone()["n"]


# ----------------------------------------------------------------------- redemptions

def add_redemptions(items: Iterable[dict[str, Any]]) -> int:
    """Insert one or more redemptions, ignoring duplicates. Returns rows added."""
    conn = _conn_required()
    now = _now_iso()
    added = 0
    with _lock:
        for it in items:
            cur = conn.execute(
                """
                INSERT OR IGNORE INTO redemptions
                    (barcode, scanned_at, device_id, result, override_reason, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    it["barcode"],
                    it["scanned_at"],
                    it.get("device_id", "unknown"),
                    it.get("result", "valid"),
                    it.get("override_reason"),
                    now,
                ),
            )
            added += cur.rowcount
        if added:
            _bump_version_locked()
        conn.commit()
    return added


def get_redemptions() -> list[dict[str, Any]]:
    conn = _conn_required()
    with _lock:
        rows = conn.execute(
            "SELECT barcode, scanned_at, device_id, result, override_reason FROM redemptions"
        ).fetchall()
    return [dict(r) for r in rows]


# ----------------------------------------------------------------------------- sync

def sync_snapshot() -> dict[str, Any]:
    """Full snapshot the phone caches into IndexedDB."""
    state = get_state()
    return {
        "data_version": int(state.get("data_version", "1")),
        "event_date": state.get("event_date"),
        "delay": {
            "delay_base_minutes": int(state.get("delay_base_minutes", "0")),
            "delay_running_since": state.get("delay_running_since") or None,
            "updated_at": state.get("delay_updated_at"),
            "updated_by": state.get("delay_updated_by"),
        },
        "settings": {
            "grace_before_minutes": int(state.get("grace_before_minutes", "0")),
            "grace_after_minutes": int(state.get("grace_after_minutes", "0")),
            "max_capacity_per_slot": int(state.get("max_capacity_per_slot", "0")),
            "slot_length_minutes": int(state.get("slot_length_minutes", "15")),
            "walkup_mode": state.get("walkup_mode", "0") == "1",
            "manual_entry": state.get("manual_entry", "0") == "1",
            "slots": _load_slots(state.get("slots", "[]")),
            "updated_at": state.get("settings_updated_at"),
            "updated_by": state.get("settings_updated_by"),
        },
        "tickets": get_tickets(),
        "redemptions": get_redemptions(),
    }
