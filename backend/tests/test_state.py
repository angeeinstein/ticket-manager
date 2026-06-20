"""Tests for the app-state data layer: delay vs settings groups and their independent
last-write-wins, plus what /api/sync exposes."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend import db  # noqa: E402


def _fresh(tmp_path) -> None:
    db._conn = None  # reset module singleton between tests
    db.init_db(
        tmp_path / "t.db",
        event_date="2026-06-20",
        grace_before=0,
        grace_after=0,
        max_capacity_per_slot=0,
        slot_length_minutes=15,
        walkup_mode=False,
    )


def test_seeded_settings_in_snapshot(tmp_path):
    _fresh(tmp_path)
    snap = db.sync_snapshot()
    s = snap["settings"]
    assert s["walkup_mode"] is False
    assert s["max_capacity_per_slot"] == 0
    assert s["slot_length_minutes"] == 15
    # Delay block no longer carries grace; grace lives in settings.
    assert "grace_before_minutes" not in snap["delay"]
    assert s["grace_before_minutes"] == 0


def test_settings_update_last_write_wins(tmp_path):
    _fresh(tmp_path)
    # Newer write applies (far-future timestamp beats the wall-clock seed).
    db.update_settings_state(0, 0, 600, 15, True, [], "2099-01-01T10:00:00", "phoneA")
    s = db.sync_snapshot()["settings"]
    assert s["walkup_mode"] is True and s["max_capacity_per_slot"] == 600

    # Older write is ignored (stale clock).
    db.update_settings_state(0, 0, 999, 15, False, [], "2099-01-01T09:00:00", "phoneB")
    s = db.sync_snapshot()["settings"]
    assert s["max_capacity_per_slot"] == 600 and s["walkup_mode"] is True


def test_slots_round_trip(tmp_path):
    _fresh(tmp_path)
    assert db.sync_snapshot()["settings"]["slots"] == []
    slots = [{"start": "09:00", "end": "09:15"}, {"start": "09:15", "end": "09:30"}]
    db.update_settings_state(0, 0, 100, 15, False, slots, "2099-01-01T10:00:00", "phoneA")
    assert db.sync_snapshot()["settings"]["slots"] == slots


def test_delay_and_settings_are_independent(tmp_path):
    _fresh(tmp_path)
    # A settings change followed by a delay change with an EARLIER timestamp must not
    # clobber the settings (separate LWW groups).
    db.update_settings_state(0, 0, 300, 20, True, [], "2099-01-01T12:00:00", "phoneA")
    db.update_delay_state(45, None, "2099-01-01T11:00:00", "phoneB")
    snap = db.sync_snapshot()
    assert snap["settings"]["max_capacity_per_slot"] == 300
    assert snap["settings"]["slot_length_minutes"] == 20
    assert snap["delay"]["delay_base_minutes"] == 45
