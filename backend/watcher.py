"""Watched-folder ingestion.

A background thread polls the inbox directory for new PDFs, parses each one, upserts the
ticket, and moves the file to processed/ (or processed/needs_review/). Polling (rather than
inotify) keeps it dependency-free and robust across SFTP/Samba writes.
"""
from __future__ import annotations

import shutil
import threading
import time
from pathlib import Path

from . import db
from .parser import OK, parse_ticket


class InboxWatcher:
    def __init__(self, inbox: Path, processed: Path, parser_config: dict, event_date: str, interval: int):
        self.inbox = inbox
        self.processed = processed
        self.review_dir = processed / "needs_review"
        self.parser_config = parser_config
        self.event_date = event_date
        self.interval = max(2, interval)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self.inbox.mkdir(parents=True, exist_ok=True)
        self.processed.mkdir(parents=True, exist_ok=True)
        self.review_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._run, name="inbox-watcher", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                self._scan_once()
            except Exception as exc:  # never let the loop die
                print(f"[watcher] error: {exc}", flush=True)

    def _scan_once(self) -> None:
        for pdf in sorted(self.inbox.glob("*.pdf")):
            if not pdf.is_file():
                continue
            self._ingest_file(pdf)

    def _ingest_file(self, pdf: Path) -> None:
        try:
            data = pdf.read_bytes()
        except OSError:
            return  # likely still being written; retry next pass
        result = parse_ticket(data, self.parser_config, self.event_date)
        if result["status"] == OK:
            db.upsert_ticket(
                barcode=result["barcode"],
                slot_start=result["slot_start"],
                slot_end=result["slot_end"],
                source_file=pdf.name,
                raw_text=result.get("raw_text"),
            )
            dest = _unique(self.processed / pdf.name)
            print(f"[watcher] ingested {pdf.name} -> {result['barcode']}", flush=True)
        else:
            dest = _unique(self.review_dir / pdf.name)
            print(f"[watcher] needs review {pdf.name}: {result.get('error')}", flush=True)
        shutil.move(str(pdf), str(dest))


def _unique(dest: Path) -> Path:
    if not dest.exists():
        return dest
    stem, suffix, n = dest.stem, dest.suffix, 1
    while True:
        candidate = dest.with_name(f"{stem}_{n}{suffix}")
        if not candidate.exists():
            return candidate
        n += 1
