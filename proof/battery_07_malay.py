"""Battery 07 — Malay / mixed Malay–English retrieval + lexical score-filtering probe.

C1 correction pass (pinned cognee==1.6.1, keyless route). Uses proof/data/malay_probe.txt
(synthetic Quellight-like content). Probes:

  A. semantic CHUNKS: successful, mixed/cross-lingual, and expected-failure queries
  B. CHUNKS_LEXICAL (BM25): token match, no-threshold zero-score behavior on Malay corpus
  C. score filtering: public-API retriever_specific_config={"with_scores": True} vs the
     direct BM25ChunksRetriever(with_scores=True) construction (source: registry passes
     only {"top_k": top_k} for CHUNKS_LEXICAL, so with_scores should be unreachable via
     the public API — tested here rather than assumed)
  D. extraction quality observation: what gliner_demo extracts from Malay text
"""

import asyncio
import time

from battery_common import Record, stamp


def hit_summary(result, limit=5) -> list[dict]:
    """Flatten a CHUNKS-style result envelope into {dataset, text} rows."""
    rows = []
    for r in result or []:
        sr = r.get("search_result") if isinstance(r, dict) else None
        ds = r.get("dataset_name") if isinstance(r, dict) else None
        for item in sr or []:
            if isinstance(item, dict) and item.get("text"):
                rows.append({"dataset": ds, "text": str(item["text"])[:160]})
            if len(rows) >= limit:
                return rows
    return rows


async def main() -> None:
    import cognee
    from cognee import SearchType

    rec = Record("battery_07_malay")
    raw = open("data/malay_probe.txt", encoding="utf-8").read()

    # Ingest each entry as its OWN document so per-query ranking is meaningful
    # (first version ingested the whole file as one chunk — every query returned
    # the same chunk and semantic discrimination was impossible).
    entries: list[str] = []
    for section in raw.split("--- entry ")[1:]:
        body = section.split("---", 1)[1].strip()
        if body:
            entries.append(body)
    assert len(entries) == 5, f"expected 5 entries, parsed {len(entries)}"

    t0 = time.perf_counter()
    for body in entries:
        await cognee.add(body, dataset_name="malay_probe")
    await cognee.cognify(datasets=["malay_probe"], extractor="gliner_demo")
    stamp(f"malay_probe cognified ({len(entries)} entries) in {time.perf_counter() - t0:.1f}s")

    # ---------- A. semantic CHUNKS ----------
    semantic_cases = [
        # (case, query, expectation)
        ("malay->malay (success-expected)", "Bila Nurul mahu ringkasan mingguannya?", "my-001/005 chunk first"),
        ("malay->malay lore (success-expected)", "Apakah peraturan siaran magic di Aetheria?", "my-002 chunk first"),
        ("english->malay cross-lingual", "Nurul weekly report deadline", "my-001/005 somewhere in top-k"),
        ("english->mixed content", "proposal 2026-091 rejection reason", "my-003 somewhere in top-k"),
        ("malay off-corpus (failure-expected)", "jadual penerbangan ke Pulau Pinang", "no relevant hit; observe what surfaces"),
        ("english off-corpus (failure-expected)", "quantum flux capacitor overheating", "no relevant hit; observe what surfaces"),
    ]
    for case, query, expectation in semantic_cases:
        t = time.perf_counter()
        res = await cognee.search(
            query_text=query, query_type=SearchType.CHUNKS,
            datasets=["malay_probe"], top_k=5,
        )
        rec.observe(f"CHUNKS {case}", "OBSERVED",
                    {"expectation": expectation, "hits": hit_summary(res)},
                    seconds=time.perf_counter() - t)

    # ---------- B. CHUNKS_LEXICAL (BM25) ----------
    lexical_cases = [
        ("malay token", "Nurul", "my-001/005 chunk"),
        ("malay entity phrase", "Majlis Serambi", "my-002 chunk"),
        ("mixed id", "PROPOSAL-2026-091", "my-003 chunk"),
        ("nonsense token (failure-expected)", "zzzqqqxyz", "top-k returned anyway at score 0 (no threshold)"),
    ]
    for case, query, expectation in lexical_cases:
        t = time.perf_counter()
        res = await cognee.search(
            query_text=query, query_type=SearchType.CHUNKS_LEXICAL,
            datasets=["malay_probe"], top_k=5,
        )
        rec.observe(f"BM25 {case}", "OBSERVED",
                    {"expectation": expectation, "hits": hit_summary(res)},
                    seconds=time.perf_counter() - t)

    # ---------- C. score filtering ----------
    # C1: public API — retriever_specific_config={"with_scores": True}.
    # Source expectation: CHUNKS_LEXICAL registry entry is (BM25ChunksRetriever, {"top_k": top_k}),
    # so with_scores never reaches the retriever and results arrive WITHOUT scores.
    res_cfg = await cognee.search(
        query_text="Nurul", query_type=SearchType.CHUNKS_LEXICAL,
        datasets=["malay_probe"], top_k=5,
        retriever_specific_config={"with_scores": True},
    )
    first = (res_cfg or [{}])[0]
    sr = first.get("search_result") if isinstance(first, dict) else None
    first_item = (sr or [None])[0]
    rec.observe("public API with_scores via retriever_specific_config", "OBSERVED",
                {"result_item_type": type(first_item).__name__,
                 "has_score_field": isinstance(first_item, tuple),
                 "first_item_keys": sorted(first_item.keys())[:8]
                 if isinstance(first_item, dict) else None,
                 "verdict": "scores returned" if isinstance(first_item, tuple)
                 else "NO scores — config silently dropped by CHUNKS_LEXICAL registry"})

    # C2: direct retriever construction — the path a pack could use.
    from cognee.modules.retrieval.bm25_retriever import BM25ChunksRetriever

    ret = BM25ChunksRetriever(top_k=5, with_scores=True)
    await ret.initialize()
    rec.observe("direct BM25ChunksRetriever chunk load", "OBSERVED",
                {"chunks_loaded_in_user_scope": len(ret.chunks)})

    for case, query in [("real token", "Nurul"), ("nonsense token", "zzzqqqxyz"),
                        ("mixed id", "PROPOSAL-2026-091")]:
        t = time.perf_counter()
        scored = await ret.get_retrieved_objects(query)
        rows = [
            {"score": round(float(s), 4), "text": str(p.get("text", ""))[:120]}
            for p, s in scored[:5]
        ]
        kept = [r for r in rows if r["score"] > 0.1]
        rec.observe(f"direct with_scores + threshold 0.1: {case}", "OBSERVED",
                    {"scored_hits": rows, "after_threshold": len(kept)},
                    seconds=time.perf_counter() - t)

    # ---------- D. extraction observation on Malay ----------
    from cognee.infrastructure.databases.graph import get_graph_engine

    engine = await get_graph_engine()
    nodes, edges = await engine.get_graph_data()
    entity_texts = sorted({
        str(n[1].get("text") or n[1].get("name"))
        for n in nodes
        if isinstance(n, tuple) and len(n) > 1 and isinstance(n[1], dict)
        and n[1].get("type") not in (None, "DocumentChunk", "TextSummary", "EntityType")
        and (n[1].get("text") or n[1].get("name"))
    })[:25]
    rec.observe("gliner_demo entities extracted from Malay corpus", "OBSERVED",
                {"node_count": len(nodes), "edge_count": len(edges),
                 "sample_entity_texts": entity_texts})

    rec.observe("suitability verdict inputs", "UNTESTED",
                {"note": "semantic cross-lingual quality and Malay extraction quality are "
                         "reported as observations on bge-small-en-v1.5 + gliner2.5-base-v1; "
                         "no non-English embedding/extraction model was benchmarked side-by-side"})

    rec.save()


if __name__ == "__main__":
    asyncio.run(main())
