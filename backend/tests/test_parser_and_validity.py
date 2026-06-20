"""End-to-end-ish tests for the parser and validity rule.

We synthesize a ticket PDF in memory (text-layer barcode + slot) so the suite runs without
the real sample. Once the real ticket exists, add a fixture PDF and assert the extracted
barcode equals a phone scan of the same code (see plan "Open item").
"""
import sys
from datetime import datetime
from pathlib import Path

import fitz  # PyMuPDF

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.parser import OK, parse_ticket  # noqa: E402
from backend.validity import BLOCKED, EARLY, VALID, compute_validity  # noqa: E402

PARSER_CFG = {
    "barcode_strategy": "text",
    "slot_regex": r"(\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}:\d{2})",
    "barcode_regex": r"\b([A-Z0-9]{8,})\b",
    "time_format": "%H:%M",
}


def _make_pdf(barcode: str, slot: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 100), "Cable Car Event Ticket")
    page.insert_text((72, 130), f"Time slot: {slot}")
    page.insert_text((72, 160), f"Code: {barcode}")
    data = doc.tobytes()
    doc.close()
    return data


def test_parse_extracts_barcode_and_slot():
    pdf = _make_pdf("ABC123456789", "09:15 - 09:30")
    res = parse_ticket(pdf, PARSER_CFG, "2026-06-20")
    assert res["status"] == OK, res
    assert res["barcode"] == "ABC123456789"
    assert res["slot_start"].endswith("09:15:00")
    assert res["slot_end"].endswith("09:30:00")


def test_parse_needs_review_when_no_slot():
    pdf = _make_pdf("ABC123456789", "no time here")
    res = parse_ticket(pdf, PARSER_CFG, "2026-06-20")
    assert res["status"] != OK
    assert "time slot" in (res["error"] or "")


def _dt(s):
    return datetime.fromisoformat(s)


def test_validity_states_without_delay():
    start = _dt("2026-06-20T09:15:00")
    end = _dt("2026-06-20T09:30:00")
    last = _dt("2026-06-20T17:00:00")  # last slot ends much later
    delay = {"delay_base_minutes": 0, "delay_running_since": None,
             "grace_before_minutes": 0, "grace_after_minutes": 0}

    assert compute_validity(start, end, last, delay, _dt("2026-06-20T09:00:00"))["status"] == EARLY
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T09:20:00"))["status"] == VALID
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T10:00:00"))["status"] == BLOCKED
    # After the last slot ends -> free-for-all.
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T17:30:00"))["status"] == VALID


def test_delay_offset_shifts_slot():
    start = _dt("2026-06-20T09:15:00")
    end = _dt("2026-06-20T09:30:00")
    last = _dt("2026-06-20T17:00:00")
    delay = {"delay_base_minutes": 30, "delay_running_since": None,
             "grace_before_minutes": 0, "grace_after_minutes": 0}
    # 09:20 would normally be VALID, but +30min delay pushes the slot to 09:45-10:00.
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T09:20:00"))["status"] == EARLY
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T09:50:00"))["status"] == VALID


def test_grace_widens_slot():
    start = _dt("2026-06-20T09:15:00")
    end = _dt("2026-06-20T09:30:00")
    last = _dt("2026-06-20T17:00:00")
    delay = {"delay_base_minutes": 0, "delay_running_since": None,
             "grace_before_minutes": 5, "grace_after_minutes": 5}
    # 09:33 is past the slot but inside the 5-min after-grace.
    assert compute_validity(start, end, last, delay, _dt("2026-06-20T09:33:00"))["status"] == VALID
