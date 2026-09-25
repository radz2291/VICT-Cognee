"""Shared helpers for the C1 proof battery (pinned cognee==1.6.1, keyless route)."""

from __future__ import annotations

import json
import time
from pathlib import Path

PROOF = Path(__file__).resolve().parent
RESULTS = PROOF / "results"
RESULTS.mkdir(exist_ok=True)

T0 = time.perf_counter()


def stamp(msg: str) -> None:
    print(f"[+{time.perf_counter() - T0:8.2f}s] {msg}", flush=True)


class Record:
    """Collects observed results for one battery phase."""

    def __init__(self, name: str):
        self.name = name
        self.entries: list[dict] = []

    def observe(self, probe: str, outcome: str, detail: dict | str, seconds: float | None = None):
        e = {
            "probe": probe,
            "outcome": outcome,  # OBSERVED | EXPECTED-FAILURE | UNTESTED | ERROR-UNEXPECTED
            "detail": detail,
        }
        if seconds is not None:
            e["seconds"] = round(seconds, 3)
        self.entries.append(e)
        line = f"[{outcome}] {probe}"
        if seconds is not None:
            line += f" ({seconds:.2f}s)"
        print(line, flush=True)
        if isinstance(detail, str):
            print(f"    {detail[:400]}", flush=True)
        else:
            print(f"    {json.dumps(detail, default=str)[:400]}", flush=True)

    def save(self) -> Path:
        path = RESULTS / f"{self.name}.json"
        path.write_text(json.dumps(self.entries, indent=2, default=str), encoding="utf-8")
        stamp(f"record saved -> {path}")
        return path
