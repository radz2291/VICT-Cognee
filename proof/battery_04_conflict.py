"""Battery 04 — conflicting and corrected information (pinned cognee==1.6.1, keyless route).

Probes what retrieval does when:
  1. two conflicting statements exist (Friday vs Thursday deadline)
  2. a correction is ingested AFTER the graph exists (superseded rule)
  3. update() rewrites a document in place
Observed at CHUNKS / graph-context level; completion-level conflict resolution
needs an LLM and is recorded as untested.
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_04_conflict")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    # ---- 1. conflicting statements ingested together ------------------------
    await cognee.add(
        "Rule: the backup job runs on Saturday. "
        "Contradicting memo: the backup job was moved to Sunday.",
        dataset_name="conflict",
    )
    await cognee.cognify(datasets=["conflict"], extractor="gliner_demo")
    stamp("conflict dataset cognified")

    r = await cognee.search(
        query_text="when does the backup job run",
        query_type=SearchType.CHUNKS,
        datasets=["conflict"],
    )
    rec.observe(
        "conflicting statements (both present at ingestion)",
        "OBSERVED",
        {
            "chunk_hits": len(r),
            "previews": [repr(x)[:150] for x in r[:4]],
            "note": "CHUNKS is passage-level: both passages should be visible",
        },
    )

    ctx = await cognee.search(
        query_text="when does the backup job run",
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=["conflict"],
        only_context=True,
    )
    rec.observe(
        "conflicting statements (graph context)",
        "OBSERVED",
        {"preview": repr(ctx)[:400], "note": "does graph context keep both claims?"},
    )

    # ---- 2. correction AFTER the graph exists -------------------------------
    await cognee.add(
        "Original policy: the API rate limit is 100 requests per minute.",
        dataset_name="corrections",
    )
    await cognee.cognify(datasets=["corrections"], extractor="gliner_demo")
    stamp("original policy cognified")

    await cognee.add(
        "Policy update: the API rate limit is now 250 requests per minute; "
        "the old 100 rpm limit no longer applies.",
        dataset_name="corrections",
    )
    await cognee.cognify(datasets=["corrections"], extractor="gliner_demo")
    stamp("correction cognified on top of existing graph")

    r2 = await cognee.search(
        query_text="API rate limit per minute",
        query_type=SearchType.CHUNKS,
        datasets=["corrections"],
    )
    rec.observe(
        "correction retrieval (CHUNKS)",
        "OBSERVED",
        {
            "hits": len(r2),
            "previews": [repr(x)[:150] for x in r2[:4]],
            "note": "both old and new passages expected at chunk level",
        },
    )

    ctx2 = await cognee.search(
        query_text="API rate limit per minute",
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=["corrections"],
        only_context=True,
    )
    rec.observe(
        "correction retrieval (graph context)",
        "OBSERVED",
        {
            "preview": repr(ctx2)[:400],
            "note": "did graph merge/replace/keep-both the rate-limit entity?",
        },
    )

    # ---- 3. update() in place ------------------------------------------------
    ds_list = await cognee.datasets.list_datasets()
    target = None
    for d in ds_list:
        if getattr(d, "name", None) == "corrections" or str(d) == "corrections":
            target = d
            break
    if target is None:
        rec.observe("locate corrections dataset", "ERROR-UNEXPECTED", f"datasets: {ds_list!r}")
    else:
        ds_id = getattr(target, "id", None)
        data_items = await cognee.datasets.list_data(ds_id)
        first = data_items[0] if data_items else None
        rec.observe(
            "datasets.list_data",
            "OBSERVED",
            {
                "dataset": str(target),
                "data_count": len(data_items),
                "first_item": repr(first)[:200],
            },
        )
        if first is not None:
            data_id = getattr(first, "id", None) or (
                first.get("id") if isinstance(first, dict) else None
            )
            t = time.perf_counter()
            try:
                upd = await cognee.update(
                    data_id=data_id,
                    dataset_id=ds_id,
                    data="Replaced document: the API rate limit is 500 requests per minute "
                    "as of the 2026-09-25 revision. All earlier limits are obsolete.",
                )
                rec.observe(
                    "update() in place",
                    "OBSERVED",
                    {"result": repr(upd)[:200]},
                    time.perf_counter() - t,
                )
                await cognee.cognify(datasets=["corrections"], extractor="gliner_demo")
                r3 = await cognee.search(
                    query_text="API rate limit",
                    query_type=SearchType.CHUNKS,
                    datasets=["corrections"],
                )
                rec.observe(
                    "post-update retrieval (CHUNKS)",
                    "OBSERVED",
                    {
                        "hits": len(r3),
                        "previews": [repr(x)[:120] for x in r3[:4]],
                        "note": "does the replaced document remove the old passages?",
                    },
                )
            except Exception as e:  # noqa: BLE001
                rec.observe(
                    "update() in place", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:300]}"
                )

    # untested: completion-level conflict adjudication (needs LLM)
    rec.observe(
        "completion-level conflict adjudication (which answer wins?)",
        "UNTESTED",
        "requires an LLM key; keyless route cannot observe answer synthesis",
    )

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
