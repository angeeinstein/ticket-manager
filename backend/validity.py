"""Validity rule for a ride-down ticket, mirrored on the phone in frontend/validity.js.

Keep this in lock-step with the JS version. The rule:

    A ticket may ride down DURING its slot, or AFTER every slot has passed
    (free-for-all). Between the end of its own slot and the last slot end it is BLOCKED.

A global delay offset (minutes) shifts every slot; an optional grace window widens each
slot. The offset is built from the phone-controlled delay state.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

EARLY = "early"
VALID = "valid"
BLOCKED = "blocked"


def effective_offset_minutes(delay: dict[str, Any], now: datetime) -> float:
    """Frozen accumulated delay plus any currently-running delay's elapsed minutes."""
    base = float(delay.get("delay_base_minutes", 0) or 0)
    running_since = delay.get("delay_running_since")
    if running_since:
        started = _parse(running_since)
        if started is not None and now > started:
            base += (now - started).total_seconds() / 60.0
    return max(0.0, base)


def compute_validity(
    slot_start: datetime,
    slot_end: datetime,
    last_slot_end: datetime,
    delay: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """Return {status, reason, offset_minutes} for one ticket at time `now`."""
    offset = effective_offset_minutes(delay, now)
    off = timedelta(minutes=offset)
    g_before = timedelta(minutes=float(delay.get("grace_before_minutes", 0) or 0))
    g_after = timedelta(minutes=float(delay.get("grace_after_minutes", 0) or 0))

    start = slot_start + off
    end = slot_end + off
    last_end = last_slot_end + off

    if now >= last_end:
        status, reason = VALID, "all slots passed (free-for-all)"
    elif start - g_before <= now <= end + g_after:
        status, reason = VALID, "within assigned slot"
    elif now < start - g_before:
        status, reason = EARLY, "slot has not started yet"
    else:
        status, reason = BLOCKED, "slot passed; ride down not yet open for everyone"

    return {"status": status, "reason": reason, "offset_minutes": round(offset, 2)}


def _parse(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except (ValueError, TypeError):
        return None
