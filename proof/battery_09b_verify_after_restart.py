"""C2 battery 09b — dataset-level deletion, phase 2: verification AFTER a restart.

Runs in a fresh process (true restart semantics; pair with battery_09a_delete.py).
Checks what survives on disk and in user-facing paths after forget(dataset):
name resolution, vector search, graph data, and the raw per-dataset files.
"""

import asyncio
import json
import time
from pathlib import Path

import cognee
from cognee.modules.search.types import SearchType

from battery_common import PROOF, Record, stamp


def store_files(dataset_id: str):
    hits = []
    for p in (PROOF / ".cognee" / "system" / "databases").rglob(f"{dataset_id}.*"):
        hits.append({"file": str(p.relative_to(PROOF)), "bytes": p.stat().st_size,
                     "mtime": p.stat().st_mtime})
    return hits


async def main():
    rec = Record("battery_09b_verify_after_restart")
    prev = json.load(open("results/battery_09a_delete.json", encoding="utf-8"))
    ds_id = prev["dataset_id"]

    t = time.perf_counter()
    try:
        hits = await cognee.search(query_text="settlement audit",
                                   query_type=SearchType.CHUNKS)
        rows = json.loads(json.dumps(hits, default=str))
        leaked = [str(r)[:80] for r in rows if "C2DEL" in str(r)]
        rec.observe("restart: user-wide CHUNKS search", "OBSERVED",
                    {"total_hits": len(rows), "deleted_content_hits": len(leaked),
                     "leaked_heads": leaked[:3]}, time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("restart: user-wide CHUNKS search", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    t = time.perf_counter()
    try:
        await cognee.search(query_text="settlement audit", query_type=SearchType.CHUNKS,
                            datasets=["c2_del"])
        rec.observe("restart: scoped search on deleted name", "ERROR-UNEXPECTED",
                    {"note": "name still resolves"})
    except Exception as exc:  # noqa: BLE001 — typed failure expected
        rec.observe("restart: scoped search on deleted name", "EXPECTED-FAILURE",
                    {"error": f"{type(exc).__name__}: {str(exc)[:110]}"},
                    time.perf_counter() - t)

    files = store_files(ds_id)
    rec.observe("restart: per-dataset store files on disk", "OBSERVED",
                {"dataset_id": ds_id, "files": files,
                 "physical_purge": "not performed" if files else "files removed"})

    out = {"battery": "09b", "dataset_id": ds_id, "entries": rec.entries}
    with open("results/battery_09b_verify_after_restart.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    stamp("BATTERY 09b COMPLETE")


if __name__ == "__main__":
    asyncio.run(main())
