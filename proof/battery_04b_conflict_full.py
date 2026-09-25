"""Battery 04b — conflict/correction full-evidence capture (pinned cognee==1.6.1).

Re-runs the battery-04 scenarios but stores FULL chunk texts and FULL graph
context strings (battery_04 truncated at 400 chars). Also probes:
  - graph node contents directly via the graph engine (read-only)
  - CHUNKS hits for each side of the conflict separately
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_04b_conflict_full")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    # ---- conflict scenario ----------------------------------------------------
    await cognee.add(
        "Rule: the backup job runs on Saturday. "
        "Contradicting memo: the backup job was moved to Sunday.",
        dataset_name="conflict",
    )
    await cognee.cognify(datasets=["conflict"], extractor="gliner_demo")
    stamp("conflict cognified")

    r_sat = await cognee.search(
        query_text="backup job Saturday", query_type=SearchType.CHUNKS, datasets=["conflict"]
    )
    r_sun = await cognee.search(
        query_text="backup job Sunday", query_type=SearchType.CHUNKS, datasets=["conflict"]
    )

    def full_texts(results):
        out = []
        for r in results or []:
            for item in (r.get("search_result") or []) if isinstance(r, dict) else []:
                if isinstance(item, dict) and item.get("text"):
                    out.append(str(item["text"]))
        return out

    rec.observe(
        "conflict: side-specific chunk retrieval",
        "OBSERVED",
        {
            "saturday_query_texts": full_texts(r_sat),
            "sunday_query_texts": full_texts(r_sun),
        },
    )

    ctx = await cognee.search(
        query_text="when does the backup job run",
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=["conflict"],
        only_context=True,
    )
    full_ctx = ""
    for c in ctx or []:
        if isinstance(c, dict):
            sr = c.get("search_result")
            if isinstance(sr, str):
                full_ctx += sr + "\n"
    rec.observe("conflict: FULL graph context", "OBSERVED", {"context": full_ctx[:3000]})

    # direct graph read (provider-level, evidence only)
    try:
        from cognee.infrastructure.databases.graph import get_graph_engine

        engine = await get_graph_engine()
        nodes, edges = await engine.get_graph_data()
        node_summaries = [
            str(n[1].get("name") or n[1].get("text") or n[1])[:120]
            for n in nodes
            if isinstance(n, tuple) and len(n) > 1 and isinstance(n[1], dict)
        ][:30]
        edge_triples = [f"{str(e[0])[:8]} -[{e[2]}]-> {str(e[1])[:8]}" for e in edges[:30]]
        rec.observe(
            "direct graph read (nodes/edges)",
            "OBSERVED",
            {"node_count": len(nodes), "edge_count": len(edges),
             "nodes": node_summaries, "edges": edge_triples},
        )
    except Exception as e:  # noqa: BLE001
        rec.observe("direct graph read", "ERROR-UNEXPECTED", f"{type(e).__name__}: {str(e)[:250]}")

    # ---- correction scenario ---------------------------------------------------
    await cognee.add(
        "Original policy: the API rate limit is 100 requests per minute.",
        dataset_name="corrections",
    )
    await cognee.cognify(datasets=["corrections"], extractor="gliner_demo")
    await cognee.add(
        "Policy update: the API rate limit is now 250 requests per minute; "
        "the old 100 rpm limit no longer applies.",
        dataset_name="corrections",
    )
    await cognee.cognify(datasets=["corrections"], extractor="gliner_demo")
    stamp("correction cognified")

    r_old = await cognee.search(
        query_text="100 requests per minute old limit",
        query_type=SearchType.CHUNKS, datasets=["corrections"],
    )
    r_new = await cognee.search(
        query_text="250 requests per minute new limit",
        query_type=SearchType.CHUNKS, datasets=["corrections"],
    )
    rec.observe(
        "correction: side-specific chunk retrieval",
        "OBSERVED",
        {
            "old_query_texts": full_texts(r_old),
            "new_query_texts": full_texts(r_new),
        },
    )

    ctx2 = await cognee.search(
        query_text="API rate limit per minute",
        query_type=SearchType.GRAPH_COMPLETION,
        datasets=["corrections"],
        only_context=True,
    )
    full_ctx2 = ""
    for c in ctx2 or []:
        if isinstance(c, dict):
            sr = c.get("search_result")
            if isinstance(sr, str):
                full_ctx2 += sr + "\n"
    rec.observe("correction: FULL graph context", "OBSERVED", {"context": full_ctx2[:3000]})

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
