"""Battery 02 — retrieval evidence (pinned cognee==1.6.1, keyless route).

Seeds two datasets (quellight_like, trading_like) via gliner cognify, then probes:
  - CHUNKS, CHUNKS_LEXICAL, SUMMARIES (LLM-free)
  - GRAPH_COMPLETION with only_context=True (graph retrieval, no LLM completion)
  - GRAPH_COMPLETION normal (expected to fail without an LLM key — recorded)
  - recall() routing (session-first rule-based router)
Everything observed is recorded; nothing is assumed from docs.
"""

import asyncio
import time

from battery_common import Record, stamp


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_02_retrieval")
    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("clean slate")

    ql_text = open("data/quellight_like.txt", encoding="utf-8").read()
    tr_text = open("data/trading_like.txt", encoding="utf-8").read()

    await cognee.add(ql_text, dataset_name="quellight_like")
    await cognee.add(tr_text, dataset_name="trading_like")
    stamp("both datasets added")

    t = time.perf_counter()
    await cognee.cognify(datasets=["quellight_like", "trading_like"], extractor="gliner_demo")
    rec.observe(
        "cognify both datasets (gliner)",
        "OBSERVED",
        "cognify completed on both datasets",
        time.perf_counter() - t,
    )

    # ---- retrieval probes --------------------------------------------------
    async def probe_search(label, qtype, query, datasets=None, **kw):
        t = time.perf_counter()
        try:
            res = await cognee.search(
                query_text=query, query_type=qtype, datasets=datasets, **kw
            )
            dt = time.perf_counter() - t
            rec.observe(
                f"search {qtype.value} :: {query!r}",
                "OBSERVED",
                {
                    "count": len(res),
                    "first_result_preview": repr(res[0])[:300] if res else None,
                    "result_types": sorted({type(r).__name__ for r in res}),
                },
                dt,
            )
            return res
        except Exception as e:  # noqa: BLE001
            dt = time.perf_counter() - t
            rec.observe(
                f"search {qtype.value} :: {query!r}",
                "ERROR-UNEXPECTED",
                f"{type(e).__name__}: {e}",
                dt,
            )
            return []

    # LLM-free retrieval types
    await probe_search("chunks", SearchType.CHUNKS, "weekly report deadline", ["quellight_like"])
    await probe_search("chunks", SearchType.CHUNKS, "position size rule", ["trading_like"])
    await probe_search(
        "chunks cross-dataset", SearchType.CHUNKS, "Alice preferences", ["quellight_like", "trading_like"]
    )
    await probe_search("lexical", SearchType.CHUNKS_LEXICAL, "FOMC", ["trading_like"])
    await probe_search("lexical-miss", SearchType.CHUNKS_LEXICAL, "zzz_no_such_term", ["trading_like"])
    await probe_search("summaries", SearchType.SUMMARIES, "risk rules", ["trading_like"])

    # graph retrieval context (no completion)
    t = time.perf_counter()
    try:
        ctx = await cognee.search(
            query_text="Who confirmed the weekly report proposal?",
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=["quellight_like"],
            only_context=True,
        )
        rec.observe(
            "graph context (only_context=True)",
            "OBSERVED",
            {"count": len(ctx), "preview": repr(ctx)[:400]},
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "graph context (only_context=True)", "ERROR-UNEXPECTED", f"{type(e).__name__}: {e}"
        )

    # completion type — expected to fail without an LLM key
    t = time.perf_counter()
    try:
        res = await cognee.search(
            query_text="When is Alice's weekly report delivered?",
            query_type=SearchType.GRAPH_COMPLETION,
            datasets=["quellight_like"],
        )
        rec.observe(
            "graph completion answer",
            "OBSERVED",
            {"count": len(res), "preview": repr(res)[:300]},
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe(
            "graph completion answer (no LLM key configured)",
            "EXPECTED-FAILURE",
            f"{type(e).__name__}: {str(e)[:300]}",
            time.perf_counter() - t,
        )

    # recall() router
    t = time.perf_counter()
    try:
        res = await cognee.recall("position size percent", datasets=["trading_like"])
        rec.observe(
            "recall() routing (no session)",
            "OBSERVED",
            {
                "count": len(res) if hasattr(res, "__len__") else "?",
                "sources": sorted({getattr(r, "source", "?") for r in res})
                if isinstance(res, list)
                else type(res).__name__,
                "preview": repr(res)[:300],
            },
            time.perf_counter() - t,
        )
    except Exception as e:  # noqa: BLE001
        rec.observe("recall() routing", "ERROR-UNEXPECTED", f"{type(e).__name__}: {e}")

    # dataset count sanity via datasets API
    ds = await cognee.datasets.list_datasets()
    rec.observe("datasets.list_datasets", "OBSERVED", {"datasets": [str(d) for d in ds]})

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
