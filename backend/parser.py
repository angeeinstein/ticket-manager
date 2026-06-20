"""Adaptive ticket-PDF parser.

Extracts a barcode value and a 15-minute time slot from a ticket PDF. Driven by a config
dict (see config.DEFAULT_PARSER_CONFIG) so the regexes/strategy can be tuned to the real
ticket layout without code changes.

Strategy:
  1. Text  - pull the slot (and optionally the barcode) from the PDF's text layer.
  2. Image - if the barcode value is not in the text, decode an embedded barcode image.

IMPORTANT (see plan "Open item"): once a sample ticket exists, confirm that the value this
parser produces equals what a phone camera reads from the printed barcode. Until then the
defaults are best-effort.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta
from typing import Any

try:  # PyMuPDF
    import fitz  # type: ignore
except Exception:  # pragma: no cover - import guard
    fitz = None

try:  # barcode image decoding is optional (needs libzbar0)
    from io import BytesIO

    from PIL import Image  # type: ignore
    from pyzbar.pyzbar import decode as zbar_decode  # type: ignore

    _IMAGE_DECODE_AVAILABLE = True
except Exception:  # pragma: no cover - import guard
    _IMAGE_DECODE_AVAILABLE = False

OK = "ok"
NEEDS_REVIEW = "needs_review"


def parse_ticket(pdf_bytes: bytes, parser_config: dict, event_date: str) -> dict[str, Any]:
    """Parse one PDF. Always returns a dict; status='needs_review' on partial failure."""
    if fitz is None:
        return _result(NEEDS_REVIEW, error="PyMuPDF (fitz) is not installed")

    try:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    except Exception as exc:  # corrupt / not a PDF
        return _result(NEEDS_REVIEW, error=f"could not open PDF: {exc}")

    try:
        raw_text = "\n".join(page.get_text() for page in doc)

        slot = _extract_slot(raw_text, parser_config, event_date)
        barcode = _extract_barcode(doc, raw_text, parser_config)

        if not barcode or not slot:
            missing = []
            if not barcode:
                missing.append("barcode")
            if not slot:
                missing.append("time slot")
            return _result(NEEDS_REVIEW, raw_text=raw_text, error=f"could not extract: {', '.join(missing)}")

        slot_start, slot_end = slot
        return _result(
            OK,
            barcode=barcode,
            slot_start=slot_start.isoformat(),
            slot_end=slot_end.isoformat(),
            raw_text=raw_text,
        )
    finally:
        doc.close()


def _extract_slot(raw_text: str, cfg: dict, event_date: str) -> tuple[datetime, datetime] | None:
    m = re.search(cfg["slot_regex"], raw_text)
    if not m:
        return None
    fmt = cfg.get("time_format", "%H:%M")
    try:
        start_t = datetime.strptime(m.group(1), fmt).time()
        end_t = datetime.strptime(m.group(2), fmt).time()
    except (ValueError, IndexError):
        return None
    base = datetime.fromisoformat(event_date)
    start = base.replace(hour=start_t.hour, minute=start_t.minute, second=0, microsecond=0)
    end = base.replace(hour=end_t.hour, minute=end_t.minute, second=0, microsecond=0)
    # Slot crossing midnight: roll end to the next day.
    if end <= start:
        end = end + timedelta(days=1)
    return start, end


def _extract_barcode(doc, raw_text: str, cfg: dict) -> str | None:
    strategy = cfg.get("barcode_strategy", "auto")

    if strategy in ("text", "auto"):
        val = _barcode_from_text(raw_text, cfg)
        if val:
            return val
        if strategy == "text":
            return None

    if strategy in ("image", "auto"):
        return _barcode_from_images(doc)

    return None


def _barcode_from_text(raw_text: str, cfg: dict) -> str | None:
    pattern = cfg.get("barcode_regex")
    if not pattern:
        return None
    m = re.search(pattern, raw_text)
    return m.group(1) if m else None


def _barcode_from_images(doc) -> str | None:
    if not _IMAGE_DECODE_AVAILABLE:
        return None
    for page in doc:
        for img in page.get_images(full=True):
            xref = img[0]
            try:
                base = doc.extract_image(xref)
                image = Image.open(BytesIO(base["image"]))
                results = zbar_decode(image)
            except Exception:
                continue
            if results:
                return results[0].data.decode("utf-8", errors="replace")
    return None


def _result(status: str, **kwargs) -> dict[str, Any]:
    out: dict[str, Any] = {
        "status": status,
        "barcode": None,
        "slot_start": None,
        "slot_end": None,
        "raw_text": None,
        "error": None,
    }
    out.update(kwargs)
    return out
