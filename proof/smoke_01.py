"""C1 smoke proof 01 — minimal end-to-end loop on pinned cognee==1.6.1 (keyless route).

Observed-behavior probe (not a doc claim):
  1. import + config surface
  2. add() synthetic text into dataset "smoke"
  3. cognify(extractor="gliner_demo")  -> LLM-free graph build
  4. search(SearchType.CHUNKS)         -> LLM-free retrieval
  5. datasets.list_datasets()

Each step is timed. Everything is recorded; failures are recorded as failures.
Run:  .venv/Scripts/python smoke_01.py   (from proof/, so .env is picked up)
"""

import asyncio
import json
import os
import time
from pathlib import Path

T0 = time.perf_counter()


def stamp(msg: str) -> None:
    print(f"[+{time.perf_counter() - T0:8.2f}s] {msg}", flush=True)


async def main() -> None:
    stamp("python start")
    import cognee
    from cognee import SearchType

    stamp(f"import cognee done — version={cognee.__version__}")

    # --- config observation -------------------------------------------------
    cfg = cognee.config.get_all()
    interesting = (
        "llm_provider",
        "llm_model",
        "embedding_provider",
        "embedding_model",
        "embedding_dimensions",
        "vector_db_provider",
        "graph_database_provider",
        "system_root_directory",
        "data_root_directory",
    )
    print(
        "config:",
        json.dumps({k: str(cfg.get(k)) for k in interesting if k in cfg}, indent=2, default=str),
    )
    stamp("config read")

    await cognee.prune.prune_data()
    await cognee.prune.prune_system(graph=True, vector=True, metadata=True, cache=True)
    stamp("prune (clean slate) done")

    # --- add -----------------------------------------------------------------
    text = (
        "Quellight release notes 2026-09-24. The Quellight agent exposes a quiet "
        "memory inbox where users confirm proposals. Alice confirmed the proposal "
        "that weekly reports are delivered on Fridays. Bob rejected the proposal "
        "about autonomous retention. Stage 07D added deep-purge deletion safety."
    )
    add_result = await cognee.add(text, dataset_name="smoke")
    stamp(f"add done — type={type(add_result).__name__}")

    # --- cognify (gliner, LLM-free) ------------------------------------------
    t = time.perf_counter()
    cognify_result = await cognee.cognify(datasets=["smoke"], extractor="gliner_demo")
    dt = time.perf_counter() - t
    print(f"cognify result type: {type(cognify_result).__name__}")
    try:
        print("cognify result repr (truncated):", repr(cognify_result)[:500])
    except Exception as e:  # noqa: BLE001
        print("cognify repr failed:", e)
    stamp(f"cognify done in {dt:.2f}s")

    # --- search: CHUNKS (no LLM needed) --------------------------------------
    t = time.perf_counter()
    chunks = await cognee.search(
        query_text="weekly reports", query_type=SearchType.CHUNKS, datasets=["smoke"], top_k=5
    )
    dt = time.perf_counter() - t
    print(f"CHUNKS results: {len(chunks)} in {dt:.2f}s")
    for r in chunks[:3]:
        print("  chunk:", repr(r)[:200])
    stamp("CHUNKS search done")

    # --- search: SUMMARIES (no LLM needed if summaries were built) ------------
    t = time.perf_counter()
    try:
        summaries = await cognee.search(
            query_text="release notes", query_type=SearchType.SUMMARIES, datasets=["smoke"], top_k=5
        )
        dt = time.perf_counter() - t
        print(f"SUMMARIES results: {len(summaries)} in {dt:.2f}s")
        for r in summaries[:3]:
            print("  summary:", repr(r)[:200])
    except Exception as e:  # noqa: BLE001
        print(f"SUMMARIES failed: {type(e).__name__}: {e}")
    stamp("SUMMARIES search done")

    # --- datasets -------------------------------------------------------------
    ds = await cognee.datasets.list_datasets()
    print("datasets:", ds)
    stamp("datasets.list done")

    stamp("SMOKE COMPLETE")


if __name__ == "__main__":
    asyncio.run(main())
