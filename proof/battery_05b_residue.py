"""Battery 05b — deletion-residue micro-probe (pinned cognee==1.6.1).

Reproduces the battery-05 finding with full evidence:
  add 1 doc -> cognify -> search (baseline) -> forget(data_id) -> verify data gone
  -> cognify -> search again (RESIDUE?) -> direct graph/vector inspection
"""

import asyncio

from battery_common import Record, stamp


def hit_texts(result) -> list[str]:
    out = []
    for r in result or []:
        sr = r.get("search_result") if isinstance(r, dict) else None
        for item in sr or []:
            if isinstance(item, dict) and item.get("text"):
                out.append(str(item["text"])[:150])
    return out


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_05b_residue")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    doc = "Playbook: when the nightly ETL fails, page the on-call analyst, snapshot staging, open a bridge."
    r = await cognee.add(doc, dataset_name="residue")
    # locate data id
    ds_list = await cognee.datasets.list_datasets()
    ds_id = next(
        getattr(d, "id", None)
        for d in ds_list
        if getattr(d, "name", "") == "residue" or str(d) == "residue"
    )
    items = await cognee.datasets.list_data(ds_id)
    data_id = getattr(items[0], "id")

    await cognee.cognify(datasets=["residue"], extractor="gliner_demo")

    base = await cognee.search(
        query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["residue"]
    )
    rec.observe("baseline search (before forget)", "OBSERVED",
                {"hits": len(base), "texts": hit_texts(base)})

    f = await cognee.forget(data_id=data_id, dataset_id=ds_id)
    items_after = await cognee.datasets.list_data(ds_id)
    rec.observe("forget(data_id) + registry count", "OBSERVED",
                {"forget_result": f, "data_items": len(items_after)})

    await cognee.cognify(datasets=["residue"], extractor="gliner_demo")
    stamp("re-cognify after forget")

    after = await cognee.search(
        query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["residue"]
    )
    rec.observe("RESIDUE PROBE: search after forget + re-cognify", "OBSERVED",
                {"hits": len(after), "texts": hit_texts(after)})

    # graph-level residue
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine

        engine = await get_graph_engine()
        nodes, edges = await engine.get_graph_data()
        rec.observe(
            "graph contents after forget (residue?)",
            "OBSERVED",
            {
                "node_count": len(nodes),
                "edge_count": len(edges),
                "node_types": sorted({str(n[1].get("type")) for n in nodes
                                      if isinstance(n, tuple) and len(n) > 1
                                      and isinstance(n[1], dict)})[:15],
            },
        )
    except Exception as e:  # noqa: BLE001
        rec.observe("graph inspection", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:200]}")

    # dataset-level forget as the cleanup path
    f2 = await cognee.forget(dataset="residue")
    rec.observe("forget(dataset) result", "OBSERVED", f2)
    try:
        after2 = await cognee.search(
            query_text="nightly ETL failure", query_type=SearchType.CHUNKS, datasets=["residue"]
        )
        rec.observe("search after dataset forget", "OBSERVED",
                    {"hits": len(after2), "texts": hit_texts(after2)})
    except Exception as e:  # noqa: BLE001
        rec.observe("search after dataset forget", "EXPECTED-FAILURE",
                    f"{type(e).__name__}: {str(e)[:200]}")

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
