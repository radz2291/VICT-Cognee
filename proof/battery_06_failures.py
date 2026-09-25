"""Battery 06 — failure behavior (pinned cognee==1.6.1, keyless route).

Probes how failures surface (exception types, safe messages):
  1. search on a nonexistent dataset
  2. cognify on an empty/nonexistent dataset
  3. add with an unsupported input type
  4. forget on a nonexistent dataset / data id
  5. completion search without any LLM key (known expected failure)
  6. dataset status / progress surface after a failed cognify
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_06_failures")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    # 1. search nonexistent dataset
    t = time.perf_counter()
    try:
        r = await cognee.search(
            query_text="anything", query_type=SearchType.CHUNKS, datasets=["no_such_dataset"]
        )
        rec.observe(
            "search nonexistent dataset", "OBSERVED", {"count": len(r), "note": "empty result?"},
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "search nonexistent dataset",
            "OBSERVED",
            f"{type(e).__name__}: {str(e)[:250]}",
            time.perf_counter() - t,
        )

    # 2. cognify nonexistent dataset
    t = time.perf_counter()
    try:
        await cognee.cognify(datasets=["no_such_dataset"], extractor="gliner_demo")
        rec.observe("cognify nonexistent dataset", "OBSERVED", "returned without error?")
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "cognify nonexistent dataset", "OBSERVED", f"{type(e).__name__}: {str(e)[:250]}"
        )

    # 3. add unsupported input type
    t = time.perf_counter()
    try:
        await cognee.add(12345, dataset_name="badinput")
        rec.observe("add(int)", "OBSERVED", "accepted?!")
    except Exception as e:  # noqa: BLE001
        rec.observe("add(int) unsupported input", "OBSERVED", f"{type(e).__name__}: {str(e)[:250]}")

    # 4. forget nonexistent
    import uuid

    t = time.perf_counter()
    try:
        f = await cognee.forget(data_id=uuid.uuid4(), dataset_id=uuid.uuid4())
        rec.observe("forget(random uuid)", "OBSERVED", {"result": repr(f)[:250]})
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "forget(random uuid)", "OBSERVED", f"{type(e).__name__}: {str(e)[:250]}",
            time.perf_counter() - t,
        )

    # 5. completion search without LLM key (after seeding one dataset so the
    #    warm-up short-circuit doesn't mask it)
    await cognee.add("Tiny fact: the studio door code is 5522.", dataset_name="tiny")
    await cognee.cognify(datasets=["tiny"], extractor="gliner_demo")
    t = time.perf_counter()
    try:
        r = await cognee.search(
            query_text="what is the studio door code?",
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=["tiny"],
        )
        rec.observe(
            "GRAPH_COMPLETION without LLM key", "OBSERVED", {"count": len(r), "preview": repr(r)[:200]},
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "GRAPH_COMPLETION without LLM key",
            "EXPECTED-FAILURE",
            f"{type(e).__name__}: {str(e)[:250]}",
            time.perf_counter() - t,
        )

    # 6. status/progress surface
    try:
        ds_list = await cognee.datasets.list_datasets()
        ids = [getattr(d, "id", None) for d in ds_list]
        status = await cognee.datasets.get_status([i for i in ids if i])
        rec.observe("datasets.get_status", "OBSERVED", {"status": {str(k): str(v) for k, v in status.items()} if isinstance(status, dict) else repr(status)[:200]})
    except Exception as e:  # noqa: BLE001
        rec.observe("datasets.get_status", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:250]}")

    # raw third-party message hygiene (CONT-005 analog): did any failure embed
    # raw invalid input? recorded qualitatively from the messages above.
    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
