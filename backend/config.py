"""Configuration loading for the ticket-checker backend.

All values come from environment variables (optionally via a .env file). The server is a
pure data layer, so configuration is intentionally small. The PDF parser is driven by a
JSON config file so its regexes/strategy can be tuned to the real ticket layout without
touching code.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

# The default parser config. Adapted to the real ticket once a sample PDF is available
# (see plan "Open item"). Override at runtime by pointing PARSER_CONFIG_PATH at a JSON file
# with the same shape; values there are merged over these defaults.
DEFAULT_PARSER_CONFIG: dict = {
    # Strategy for obtaining the barcode value:
    #   "auto"  -> try text first, fall back to decoding an embedded barcode image
    #   "text"  -> only read the barcode value from the PDF text (via barcode_regex)
    #   "image" -> only decode an embedded barcode image
    "barcode_strategy": "auto",
    # Regex with two capture groups (start, end) for the time slot, e.g. "09:15 - 09:30".
    "slot_regex": r"(\d{1,2}:\d{2})\s*[-–—to]+\s*(\d{1,2}:\d{2})",
    # Optional regex (one capture group) for the barcode value when present as text.
    # Tune to the ticket; the default matches a run of 8+ digits/uppercase letters.
    "barcode_regex": r"\b([A-Z0-9]{8,})\b",
    # strptime format for the captured slot times.
    "time_format": "%H:%M",
}


def _get_bool(name: str, default: bool) -> bool:
    val = os.getenv(name)
    if val is None:
        return default
    return val.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    db_path: Path = field(default_factory=lambda: Path(os.getenv("DB_PATH", str(BASE_DIR / "data" / "tickets.db"))))
    inbox_dir: Path = field(default_factory=lambda: Path(os.getenv("INBOX_DIR", str(BASE_DIR / "inbox"))))
    processed_dir: Path = field(default_factory=lambda: Path(os.getenv("PROCESSED_DIR", str(BASE_DIR / "inbox" / "processed"))))
    frontend_dir: Path = field(default_factory=lambda: Path(os.getenv("FRONTEND_DIR", str(BASE_DIR / "frontend"))))

    # The date the slots belong to (slots in the PDF are just HH:MM). Defaults to today.
    event_date: str = field(default_factory=lambda: os.getenv("EVENT_DATE", date.today().isoformat()))

    # Shared secret required on /api/* calls. Empty string disables auth (NOT recommended
    # for a public Cloudflare tunnel).
    scanner_token: str = field(default_factory=lambda: os.getenv("SCANNER_TOKEN", ""))

    host: str = field(default_factory=lambda: os.getenv("HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: int(os.getenv("PORT", "8080")))

    # Default settings seeded into app state on first run (operator changes them in the app,
    # after which the synced values win — these are only the initial seed).
    grace_before_minutes: int = field(default_factory=lambda: int(os.getenv("GRACE_BEFORE_MINUTES", "0")))
    grace_after_minutes: int = field(default_factory=lambda: int(os.getenv("GRACE_AFTER_MINUTES", "0")))
    # Max riders the cable car handles per window (0 = unlimited / not set).
    max_capacity_per_slot: int = field(default_factory=lambda: int(os.getenv("MAX_CAPACITY_PER_SLOT", "0")))
    # Length of a capacity/throughput window in minutes (also the ticket slot length).
    slot_length_minutes: int = field(default_factory=lambda: int(os.getenv("SLOT_LENGTH_MINUTES", "15")))
    # Walk-up mode: when on, scanning an unknown barcode records it (one-time use) instead
    # of rejecting it — lets the event run with no imported ticket data.
    walkup_mode: bool = field(default_factory=lambda: _get_bool("WALKUP_MODE", False))

    # How often (seconds) the watched-folder poller scans the inbox.
    watch_interval_seconds: int = field(default_factory=lambda: int(os.getenv("WATCH_INTERVAL_SECONDS", "10")))
    watch_enabled: bool = field(default_factory=lambda: _get_bool("WATCH_ENABLED", True))

    def parser_config(self) -> dict:
        cfg = dict(DEFAULT_PARSER_CONFIG)
        path = os.getenv("PARSER_CONFIG_PATH")
        if path and Path(path).exists():
            try:
                cfg.update(json.loads(Path(path).read_text()))
            except (json.JSONDecodeError, OSError):
                # Fall back to defaults rather than crash the data layer.
                pass
        return cfg

    def ensure_dirs(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.inbox_dir.mkdir(parents=True, exist_ok=True)
        self.processed_dir.mkdir(parents=True, exist_ok=True)


settings = Settings()
