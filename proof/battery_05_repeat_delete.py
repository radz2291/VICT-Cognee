"""Battery 05 — repeated ingestion and deletion (pinned cognee==1.6.1, keyless route).

Probes:
  1. repeated add() of the identical document into one dataset (dedup/idempotency)
  2. repeated cognify() of an unchanged dataset (incremental loading)
  3. forget(data_id=...) single-item deletion, with retrieval verification
  4. forget(dataset=...) dataset deletion, with retrieval verification
  5. datasets.empty_dataset vs forget(memory_only=True) surface differences
Deletion compensation semantics (VICT effect model) are judged from these results.
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_05_repeat_delete")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    doc = (
        "Playbook: when the nightly ETL fails, page the on-call analyst, "
        "snapshot the staging tables, and open a bridge channel."
    )

    # ---- 1. repeated identical add() ----------------------------------------
    r1 = await cognee.add(doc, dataset_name="repeat")
    r2 = await cognee.add(doc, dataset_name="repeat")
    r3 = await cognee.add(doc, dataset_name="repeat")
    rec.observe(
        "add() x3 identical document",
        "OBSERVED",
        {
            "run1": repr(r1)[:120],
            "run2": repr(r2)[:120],
            "run3": repr(r3)[:120],
            "note": "does ingestion deduplicate by content hash?",
        },
    )

    ds_list = await cognee.datasets.list_datasets()
    ds_id = None
    for d in ds_list:
        if getattr(d, "name", "") == "repeat" or str(d) == "repeat":
            ds_id = getattr(d, "id", None)
    items = await cognee.datasets.list_data(ds_id)
    rec.observe(
        "stored data items after triple add",
        "OBSERVED",
        {"count": len(items), "ids": [str(getattr(i, "id", i))[:8] for i in items]},
    )

    await cognee.cognify(datasets=["repeat"], extractor="gliner_demo")
    r = await cognee.search(
        query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["repeat"]
    )
    rec.observe(
        "retrieval after triple add + single cognify",
        "OBSERVED",
        {"hits": len(r), "previews": [repr(x)[:100] for x in r[:3]]},
    )

    # ---- 2. repeated cognify() on unchanged dataset -------------------------
    t = time.perf_counter()
    await cognee.cognify(datasets=["repeat"], extractor="gliner_demo")
    dt1 = time.perf_counter() - t
    t = time.perf_counter()
    await cognee.cognify(datasets=["repeat"], extractor="gliner_demo")
    dt2 = time.perf_counter() - t
    r2b = await cognee.search(
        query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["repeat"]
    )
    rec.observe(
        "cognify() twice on unchanged dataset",
        "OBSERVED",
        {
            "first_seconds": round(dt1, 2),
            "second_seconds": round(dt2, 2),
            "hits_after": len(r2b),
            "note": "incremental loading should make re-cognify cheap and non-duplicating",
        },
    )

    # ---- 3. forget single item ----------------------------------------------
    first_id = getattr(items[0], "id", None)
    if first_id is not None:
        t = time.perf_counter()
        f1 = await cognee.forget(data_id=first_id, dataset_id=ds_id)
        rec.observe(
            "forget(data_id=first of 3)",
            "OBSERVED",
            {"result": repr(f1)[:250]},
            time.perf_counter() - t,
        )
        items_after = await cognee.datasets.list_data(ds_id)
        rec.observe(
            "data items after single forget", "OBSERVED", {"count": len(items_after)}
        )
        await cognee.cognify(datasets=["repeat"], extractor="gliner_demo")
        r3b = await cognee.search(
            query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["repeat"]
        )
        rec.observe(
            "retrieval after single forget + re-cognify",
            "OBSERVED",
            {
                "hits": len(r3b),
                "note": "if chunks survive because duplicates remain, evidence shows retention",
            },
        )

    # ---- 4. forget entire dataset -------------------------------------------
    t = time.perf_counter()
    f2 = await cognee.forget(dataset="repeat")
    rec.observe("forget(dataset='repeat')", "OBSERVED", {"result": repr(f2)[:250]})
    await cognee.cognify(datasets=["repeat"], extractor="gliner_demo")
    try:
        r4 = await cognee.search(
            query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["repeat"]
        )
        rec.observe(
            "retrieval after dataset forget",
            "OBSERVED",
            {"hits": len(r4), "note": "expected 0 or a dataset-missing failure"},
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "retrieval after dataset forget",
            "EXPECTED-FAILURE",
            f"{type(e).__name__}: {str(e)[:200]}",
        )

    ds_after = await cognee.datasets.list_datasets()
    rec.observe(
        "datasets after forget(dataset)",
        "OBSERVED",
        {"datasets": [str(d) for d in ds_after], "note": "is the dataset registry row gone?"},
    )

    rec.observe(
        "delete compensation (VICT irreversible/write classification input)",
        "UNTESTED",
        "long-term provenance of deleted edges (re-ingestion after forget) "
        "partially covered here; cross-user cascade untested keylessly",
    )

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
