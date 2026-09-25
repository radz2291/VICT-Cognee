"""C2 battery 09a — dataset-level deletion, phase 1: setup + delete (in-process).

Paired with battery_09b_verify_after_restart.py which runs in a FRESH process.
Question: what does `cognee.forget(dataset=...)` actually remove — registry only,
or also the per-dataset graph (.lbug) / vector (.lance.db) files on disk?
"""

import asyncio
import json
import time
from pathlib import Path

import cognee
from cognee.modules.search.types import SearchType

from battery_common import PROOF, Record, stamp

DEL_A = "C2DEL-AA1-MARKER settlement audit trail one"
DEL_B = "C2DEL-BB2-MARKER settlement audit trail two"


def store_files(dataset_id: str):
    """Find per-dataset database files under the proof store."""
    hits = []
    for p in (PROOF / ".cognee" / "system" / "databases").rglob(f"{dataset_id}.*"):
        hits.append({"file": str(p.relative_to(PROOF)), "bytes": p.stat().st_size,
                     "mtime": p.stat().st_mtime})
    return hits


async def main():
    rec = Record("battery_09a_delete")

    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.modules.users.methods import get_default_user

    user = await get_default_user()

    t = time.perf_counter()
    await cognee.add(f"{DEL_A}\nsecond paragraph for chunking depth", dataset_name="c2_del",
                     user=user)
    await cognee.add(DEL_B, dataset_name="c2_del", user=user)
    await cognee.cognify(datasets=["c2_del"], user=user, extractor="gliner_demo")
    rec.observe("setup c2_del (2 docs) + cognify", "OBSERVED", {}, time.perf_counter() - t)

    (ds,) = await get_authorized_existing_datasets(["c2_del"], "read", user, strict=True)
    ds_id = str(ds.id)
    pre_files = store_files(ds_id)
    hits = await cognee.search(query_text="settlement audit", query_type=SearchType.CHUNKS,
                               datasets=["c2_del"])
    rec.observe("pre-delete: scoped CHUNKS search", "OBSERVED",
                {"dataset_id": ds_id, "hits": len(hits), "store_files": pre_files})

    t = time.perf_counter()
    res = await cognee.forget(dataset="c2_del")
    rec.observe("forget(dataset='c2_del')", "OBSERVED",
                {"returned": repr(res)[:200]}, time.perf_counter() - t)

    post_files = store_files(ds_id)
    try:
        after = await cognee.search(query_text="settlement audit", query_type=SearchType.CHUNKS,
                                    datasets=["c2_del"])
        after_note = {"hits": len(after)}
    except Exception as exc:  # noqa: BLE001 — typed failure IS the expected outcome
        after_note = {"typed_failure": f"{type(exc).__name__}: {str(exc)[:100]}"}
    rec.observe("post-delete (same process): name resolution + store files", "OBSERVED",
                {"search_after": after_note, "store_files_after": post_files,
                 "files_still_on_disk": len(post_files) > 0})

    out = {"battery": "09a", "dataset_id": ds_id, "user_id": str(user.id),
           "entries": rec.entries}
    with open("results/battery_09a_delete.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    stamp("BATTERY 09a COMPLETE")


if __name__ == "__main__":
    asyncio.run(main())
