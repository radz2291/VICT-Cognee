"""C2 battery 08 — retrieval scope enforcement: 2 datasets x 2 users (pinned cognee==1.6.1).

Questions (observed, not doc claims):
  1. Does `cognee.search(query_type=CHUNKS, datasets=[...])` enforce store-level
     dataset scope in the default proof env (ladybug+lancedb, access control ON)?
  2. Is dataset-name resolution strict (unknown name fails the request)?
  3. Can the direct scored BM25ChunksRetriever enforce dataset scope — default
     context vs `set_database_global_context_variables` (per-dataset store)?
  4. Does the NodeSet (`node_name`) filter work on chunks, and do chunk payloads
     carry `belongs_to_set` by default?
  5. Is the semantic CHUNKS `score` (cosine distance, lower=better) exposed via
     the public API, and does it separate on-corpus from off-corpus queries?
  6. Cross-user isolation on both paths (user B cannot see A's datasets).
"""

import asyncio
import json
import time

import cognee
from cognee.modules.search.types import SearchType
from cognee.modules.users.methods import create_user, get_default_user

from battery_common import Record, stamp

ALPHA_TOKEN = "C2ALPHA-QX7-MARKER"
BETA_TOKEN = "C2BETA-ZR3-MARKER"
GAMMA_TOKEN = "C2GAMMA-KW9-MARKER"
OFF_CORPUS = "quantum flux capacitor overheating zebra"


def hits_summary(hits):
    """Flatten AC-ON result shape: [{dataset_name, search_result: [{text, score?}]}]."""
    rows = []
    for r in hits or []:
        ds = r.get("dataset_name") if isinstance(r, dict) else None
        for payload in (r.get("search_result") or []) if isinstance(r, dict) else []:
            text = payload.get("text", "") if isinstance(payload, dict) else str(payload)
            rows.append({
                "dataset": ds,
                "score": payload.get("score") if isinstance(payload, dict) else None,
                "has_belongs_to_set": "belongs_to_set" in payload if isinstance(payload, dict) else False,
                "text_head": text[:70],
            })
    return rows


def leaks(rows, token):
    return sum(1 for r in rows if token in r["text_head"] or (r["text_head"] and token in str(r)))


async def main():
    rec = Record("battery_08_scope_retrieval")

    default_user = await get_default_user()
    try:
        user_b = await create_user(email="c2-scope-b@example.com", password="proof-password-123")
    except Exception:  # noqa: BLE001 — idempotent rerun: user exists from a prior battery run
        from cognee.modules.users.methods import get_user_by_email

        user_b = await get_user_by_email(user_email="c2-scope-b@example.com")
    stamp(f"users: A={str(default_user.id)[:8]} B={str(user_b.id)[:8]}")
    # ---- setup: A owns c2_alpha + c2_beta; B owns c2_gamma ----
    t = time.perf_counter()
    await cognee.add(
        f"Alpha ledger note {ALPHA_TOKEN}: Quellight settlement windows close 17:00 UTC.\n"
        f"Second alpha paragraph {ALPHA_TOKEN}-2 referencing hedging thresholds.",
        dataset_name="c2_alpha", user=default_user)
    await cognee.add(
        f"Beta ledger note {BETA_TOKEN}: Trading-OS-style position sizing caps at 2 percent.\n"
        f"Second beta paragraph {BETA_TOKEN}-2 referencing drawdown guards.",
        dataset_name="c2_beta", user=default_user)
    await cognee.add(
        f"Gamma private note {GAMMA_TOKEN}: user B private ledger, drawdown guard seven percent.",
        dataset_name="c2_gamma", user=user_b)
    rec.observe("add 3 datasets (A: alpha+beta, B: gamma)", "OBSERVED",
                {"docs": 3}, time.perf_counter() - t)

    t = time.perf_counter()
    await cognee.cognify(datasets=["c2_alpha", "c2_beta"], user=default_user,
                         extractor="gliner_demo")
    await cognee.cognify(datasets=["c2_gamma"], user=user_b, extractor="gliner_demo")
    rec.observe("cognify all three datasets", "OBSERVED",
                {"note": "per-user cognify"}, time.perf_counter() - t)

    # ---- Q3: scored lexical — default context FIRST (before any scoped search:
    # cognee's dataset context is a ContextVar that persists across sequential
    # ops in the same task; probing after scoped searches would be contaminated) ----
    from cognee.modules.retrieval.bm25_retriever import BM25ChunksRetriever

    t = time.perf_counter()
    try:
        ret = BM25ChunksRetriever(top_k=10, with_scores=True)
        scored = await ret.get_retrieved_objects("ledger")
        rows = [{"dataset": None, "text_head": (p.get("text", "") if isinstance(p, dict) else str(p))[:70],
                 "score": s} for p, s in scored]
        rows_alpha = sum(1 for r in rows if ALPHA_TOKEN.lower() in r["text_head"].lower())
        rows_beta = sum(1 for r in rows if BETA_TOKEN.lower() in r["text_head"].lower())
        rec.observe("A: direct BM25 clean default context (query 'ledger')", "OBSERVED",
                    {"hits": len(rows), "alpha_hits": rows_alpha, "beta_hits": rows_beta,
                     "note": "no dataset context ever set in this task: user-wide store across datasets; no dataset param exists",
                     "rows_head": rows[:6]}, time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: direct BM25 clean default context", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    t = time.perf_counter()
    try:
        BM25ChunksRetriever(top_k=5, with_scores=True, dataset="c2_alpha")
        rec.observe("BM25ChunksRetriever accepts dataset kwarg", "ERROR-UNEXPECTED",
                    {"note": "unexpectedly accepted"})
    except TypeError as exc:
        rec.observe("BM25ChunksRetriever accepts dataset kwarg", "EXPECTED-FAILURE",
                    {"error": str(exc)[:140]}, time.perf_counter() - t)

    # ---- Q1/Q2: semantic CHUNKS dataset scoping (public API) ----
    t = time.perf_counter()
    uns = await cognee.search(query_text=ALPHA_TOKEN, query_type=SearchType.CHUNKS)
    rows = hits_summary(uns)
    rec.observe("A: CHUNKS no scope (alpha query)", "OBSERVED",
                {"hits": len(rows), "alpha_leak": leaks(rows, ALPHA_TOKEN),
                 "beta_leak": leaks(rows, BETA_TOKEN),
                 "datasets_seen": sorted({r["dataset"] for r in rows})},
                time.perf_counter() - t)

    t = time.perf_counter()
    scoped = await cognee.search(query_text=ALPHA_TOKEN, query_type=SearchType.CHUNKS,
                                 datasets=["c2_alpha"])
    rows = hits_summary(scoped)
    rec.observe("A: CHUNKS datasets=[c2_alpha]", "OBSERVED",
                {"hits": len(rows), "alpha_leak": leaks(rows, ALPHA_TOKEN),
                 "beta_leak": leaks(rows, BETA_TOKEN),
                 "datasets_seen": sorted({r["dataset"] for r in rows})},
                time.perf_counter() - t)

    t = time.perf_counter()
    try:
        await cognee.search(query_text=ALPHA_TOKEN, query_type=SearchType.CHUNKS,
                            datasets=["c2_does_not_exist"])
        rec.observe("A: CHUNKS datasets=[nonexistent]", "ERROR-UNEXPECTED",
                    {"note": "no failure raised"})
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: CHUNKS datasets=[nonexistent]", "EXPECTED-FAILURE",
                    {"error": f"{type(exc).__name__}: {str(exc)[:120]}"},
                    time.perf_counter() - t)

    # ---- Q6: cross-user isolation (semantic + scoped) ----
    t = time.perf_counter()
    uns_b = await cognee.search(query_text="ledger", query_type=SearchType.CHUNKS, user=user_b)
    rows = hits_summary(uns_b)
    rec.observe("B: CHUNKS no scope", "OBSERVED",
                {"hits": len(rows), "alpha_leak": leaks(rows, ALPHA_TOKEN),
                 "beta_leak": leaks(rows, BETA_TOKEN),
                 "datasets_seen": sorted({r["dataset"] for r in rows})},
                time.perf_counter() - t)

    t = time.perf_counter()
    try:
        await cognee.search(query_text=ALPHA_TOKEN, query_type=SearchType.CHUNKS,
                            datasets=["c2_alpha"], user=user_b)
        rec.observe("B: CHUNKS datasets=[A's c2_alpha]", "ERROR-UNEXPECTED",
                    {"note": "B saw A's dataset"})
    except Exception as exc:  # noqa: BLE001
        rec.observe("B: CHUNKS datasets=[A's c2_alpha]", "EXPECTED-FAILURE",
                    {"error": f"{type(exc).__name__}: {str(exc)[:120]}"},
                    time.perf_counter() - t)

    # ---- Q3: scored lexical AFTER scoped searches in the same task:
    # documents the ContextVar persistence hazard for integrators ----
    t = time.perf_counter()
    try:
        ret = BM25ChunksRetriever(top_k=10, with_scores=True)
        scored = await ret.get_retrieved_objects("ledger")
        rows = [{"text_head": (p.get("text", "") if isinstance(p, dict) else str(p))[:70],
                 "score": s} for p, s in scored]
        rec.observe("A: direct BM25 AFTER scoped searches (same task)", "OBSERVED",
                    {"hits": len(rows), "rows_head": rows[:4],
                     "note": "CONTEXTVAR HAZARD: retriever sees the last-searched dataset's store, not the user-wide store — integrators must isolate contexts per request"},
                    time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: direct BM25 after scoped searches", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    # ---- Q3 decisive: direct scored BM25 INSIDE per-dataset store context ----
    from cognee.context_global_variables import set_database_global_context_variables
    from cognee.modules.data.methods import get_authorized_existing_datasets

    t = time.perf_counter()
    try:
        (alpha_ds,) = await get_authorized_existing_datasets(["c2_alpha"], "read",
                                                             default_user, strict=True)
        async with set_database_global_context_variables(alpha_ds.id, default_user.id):
            ret = BM25ChunksRetriever(top_k=10, with_scores=True)
            scored = await ret.get_retrieved_objects("ledger")
            rows = [{"text_head": (p.get("text", "") if isinstance(p, dict) else str(p))[:70],
                     "score": s} for p, s in scored]
            rows_alpha = sum(1 for r in rows if ALPHA_TOKEN.lower() in r["text_head"].lower())
            rows_beta = sum(1 for r in rows if BETA_TOKEN.lower() in r["text_head"].lower())
            rec.observe("A: direct BM25 inside dataset context (c2_alpha)", "OBSERVED",
                        {"hits": len(rows), "alpha_hits": rows_alpha, "beta_hits": rows_beta,
                         "note": "decisive: scores AND scope together if beta_hits==0",
                         "rows_head": rows[:6]}, time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: direct BM25 inside dataset context", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    # ---- lexical via public API is dataset-scoped (but scoreless, per C1) ----
    t = time.perf_counter()
    try:
        lex = await cognee.search(query_text="ledger", query_type=SearchType.CHUNKS_LEXICAL,
                                  datasets=["c2_alpha"])
        rows = hits_summary(lex)
        rec.observe("A: CHUNKS_LEXICAL datasets=[c2_alpha]", "OBSERVED",
                    {"hits": len(rows), "beta_leak": leaks(rows, BETA_TOKEN),
                     "datasets_seen": sorted({r["dataset"] for r in rows}),
                     "score_fields": sum(1 for r in rows if r["score"] is not None)},
                    time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: CHUNKS_LEXICAL datasets=[c2_alpha]", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    # ---- Q4: NodeSet filter mechanics ----
    t = time.perf_counter()
    try:
        any_hit = hits_summary(uns)[0] if uns else {}
        nn = await cognee.search(query_text=ALPHA_TOKEN, query_type=SearchType.CHUNKS,
                                 datasets=["c2_alpha"], node_name=["no-such-set"])
        rows = hits_summary(nn)
        rec.observe("A: CHUNKS node_name=[no-such-set]", "OBSERVED",
                    {"hits": len(rows),
                     "belongs_to_set_present_in_payloads": any_hit.get("has_belongs_to_set", False),
                     "note": "pre-filter via payload.belongs_to_set at the vector store"},
                    time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("A: CHUNKS node_name=[no-such-set]", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    # ---- Q5: semantic score exposure (distance, lower=better) ----
    t = time.perf_counter()
    try:
        on = hits_summary(await cognee.search(query_text="settlement windows close",
                                              query_type=SearchType.CHUNKS,
                                              datasets=["c2_alpha"]))
        off = hits_summary(await cognee.search(query_text=OFF_CORPUS,
                                               query_type=SearchType.CHUNKS,
                                               datasets=["c2_alpha"]))
        rec.observe("score separation probe (no threshold adopted)", "OBSERVED",
                    {"on_corpus_scores": [r["score"] for r in on][:5],
                     "off_corpus_scores": [r["score"] for r in off][:5],
                     "note": "raw cosine distances; separation observed, no universal threshold"},
                    time.perf_counter() - t)
    except Exception as exc:  # noqa: BLE001
        rec.observe("score separation probe", "ERROR-UNEXPECTED",
                    {"error": f"{type(exc).__name__}: {str(exc)[:140]}"})

    out = {"battery": "08", "users": {"A": str(default_user.id), "B": str(user_b.id)},
           "entries": rec.entries}
    with open("results/battery_08_scope_retrieval.json", "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, default=str)
    stamp(f"BATTERY 08 COMPLETE ({len(rec.entries)} probes)")


if __name__ == "__main__":
    asyncio.run(main())
