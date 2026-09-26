"""Dump the full graph (nodes + edges) of a cognee store for equivalence diffing.

C4-exit cognify-retry proof: compare graph NODES, EDGES, identities, and
properties between (a) an uninterrupted cognify run and (b) a forced
post-write/pre-commit crash + keyed reissue, in two ISOLATED stores.

Usage (cwd = the store directory holding its own .env):
    python graph_dump_c4.py --dump graph.json [--raw]

The dump is normalized for cross-store comparison:
  - node identity  := (type, name)  — raw node ids are per-store random UUIDs
  - edge identity  := (src identity, dst identity, relationship_name)
  - VOLATILE_PROPERTIES are dropped from node/edge properties (per-store
    random ids, timestamps, pipeline-run provenance); everything else is
    compared byte-exactly. --raw dumps unnormalized for inspection.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import pathlib

# worker-owned environment pins (MUST precede any cognee import)
os.environ.setdefault("VECTOR_DB_SUBPROCESS_ENABLED", "false")
os.environ.setdefault("GRAPH_DATABASE_SUBPROCESS_ENABLED", "false")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("KUZU_BUFFER_POOL_SIZE", "268435456")

# Explicit, cwd-anchored .env (neutralize cognee's dotenv walk-up) — same
# discipline as the pack worker (contract §8).
import pathlib

_ENV_FILE = pathlib.Path.cwd() / ".env"
import dotenv

_orig_load_dotenv = dotenv.load_dotenv
dotenv.load_dotenv = lambda *a, **k: False
_orig_load_dotenv(str(_ENV_FILE), override=True)

# Node/edge properties that embed per-store random identity or wall-clock
# time and are therefore NOT part of graph-structure equivalence. Everything
# else (names, types, texts, source_content_hash, counts, index fields,
# weights, pipeline/task names, default-user email) is compared exactly —
# as MULTISETS (per-identity multiplicity included; CORRECTION PASS 2: the
# previous key→props maps silently overwrote duplicate identities).
# Per-property justification (why the field cannot be compared across two
# independently initialized stores):
#   id, source_chunk_id, edge_object_id, document_id, source_node_id,
#     target_node_id  -> per-store random UUIDs (new UUID() per record;
#                         provably not reproducible across stores)
#   created_at / updated_at -> wall-clock epoch millis (store-init time;
#                         differs by construction between runs)
#   raw_data_location      -> embeds the store-root path + per-run UUID;
#                         store A and store B live at different roots
#   dataset_id / belongs_to_dataset_id / dataset_owner_id -> per-store
#                         dataset/user surrogate keys (random UUIDs)
#   source_run_ids / source_run_refs / source_ref_keys / source_dataset_ids
#                         -> pipeline-run provenance: per-run random UUIDs
#                         recorded by cognee at ingestion time
VOLATILE_NODE_PROPERTIES = {
    "id", "created_at", "updated_at", "source_chunk_id", "dataset_id",
    "belongs_to_dataset_id", "dataset_owner_id", "document_id",
    "raw_data_location",
    "source_run_ids", "source_run_refs", "source_ref_keys", "source_dataset_ids",
}
VOLATILE_EDGE_PROPERTIES = {
    "edge_object_id", "created_at", "updated_at", "source_node_id",
    "target_node_id",
    "source_run_ids", "source_run_refs", "source_ref_keys", "source_dataset_ids",
}

EXCLUSION_JUSTIFICATION = {
    "id": "per-store random UUID (new UUID per node)",
    "created_at": "wall-clock epoch millis (store-init time)",
    "updated_at": "wall-clock epoch millis",
    "source_chunk_id": "per-store random UUID",
    "dataset_id": "per-store dataset surrogate key (random UUID)",
    "belongs_to_dataset_id": "per-store dataset surrogate key (random UUID)",
    "dataset_owner_id": "per-store user surrogate key (random UUID)",
    "document_id": "per-store random UUID",
    "raw_data_location": "store-root path + per-run UUID (roots differ by design)",
    "edge_object_id": "per-store random UUID",
    "source_node_id": "per-store random node UUID (edge endpoint surrogate)",
    "target_node_id": "per-store random node UUID (edge endpoint surrogate)",
    "source_run_ids": "pipeline-run provenance (per-run random UUIDs)",
    "source_run_refs": "pipeline-run provenance (per-run random UUIDs)",
    "source_ref_keys": "pipeline-run provenance (per-run random UUIDs)",
    "source_dataset_ids": "pipeline-run provenance (per-run random UUIDs)",
}


def _clean(props: dict, volatile: set[str]) -> dict:
    out = {}
    for k in sorted(props.keys()):
        if k in volatile:
            continue
        v = props[k]
        try:
            json.dumps(v)
            out[k] = v
        except (TypeError, ValueError):
            out[k] = str(v)
    return out


async def dump(raw: bool) -> dict:
    # cognee 1.6.1 + ladybug: EACH DATASET has its own graph DB at
    #   <system_root>/databases/<owner_id>/<dataset_id>.lbug
    # The global engine (get_graph_engine) only holds the schema. Equivalence
    # must therefore diff EVERY per-dataset graph file (fail closed: if none
    # is found, the dump is empty and the comparison would be vacuous).
    from cognee.base_config import get_base_config
    from cognee.infrastructure.databases.graph.ladybug.adapter import LadybugAdapter

    root = pathlib.Path(get_base_config().system_root_directory) / "databases"
    graph_files = sorted(root.glob("*/*.lbug"))
    if not graph_files:
        raise RuntimeError(
            f"no per-dataset .lbug graph files under {root} — refusing to "
            "produce a vacuous (empty) dump")

    all_nodes, all_edges = [], []
    for gf in graph_files:
        engine = LadybugAdapter(db_path=str(gf))
        nodes, edges = await engine.get_graph_data()
        all_nodes.extend(nodes)
        all_edges.extend(edges)
        try:
            await engine.close()
        except Exception:  # noqa: BLE001 — close is best-effort
            pass

    nodes, edges = all_nodes, all_edges

    node_identity = {}
    for node_id, props in nodes:
        name = props.get("name")
        ntype = props.get("type")
        node_identity[node_id] = {"type": ntype, "name": name}
        if raw:
            continue
    if raw:
        return {
            "graphFiles": [str(g) for g in graph_files],
            "nodes": [{"id": nid, **(props or {})} for nid, props in nodes],
            "edges": [{"source": s, "target": t, "relationship": r, "properties": p}
                      for s, t, r, p in edges],
        }

    # MULTISET normalization (correction pass 2): each identity key maps to a
    # LIST of property variants — duplicate identities are preserved, never
    # overwritten (the previous dict-based normalization silently collapsed
    # duplicates, which would have hidden multiplicity differences).
    norm_nodes = {}
    for _nid, props in nodes:
        key = json.dumps({"type": props.get("type"), "name": props.get("name")},
                         sort_keys=True, ensure_ascii=False)
        norm_nodes.setdefault(key, []).append(_clean(props or {}, VOLATILE_NODE_PROPERTIES))
    norm_edges = {}
    for s, t, rel, props in edges:
        sn, tn = node_identity.get(s, {}), node_identity.get(t, {})
        key = json.dumps({
            "source": {"type": sn.get("type"), "name": sn.get("name")},
            "target": {"type": tn.get("type"), "name": tn.get("name")},
            "relationship": rel,
        }, sort_keys=True, ensure_ascii=False)
        norm_edges.setdefault(key, []).append(_clean(props or {}, VOLATILE_EDGE_PROPERTIES))
    return {
        "graphFiles": [str(g) for g in graph_files],
        "nodeCount": len(nodes), "edgeCount": len(edges),
        "nodeIdentityCount": len(norm_nodes), "edgeIdentityCount": len(norm_edges),
        "duplicateNodeInstances": sum(len(v) - 1 for v in norm_nodes.values()),
        "duplicateEdgeInstances": sum(len(v) - 1 for v in norm_edges.values()),
        "exclusionJustification": EXCLUSION_JUSTIFICATION,
        "nodes": norm_nodes, "edges": norm_edges,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dump", required=True)
    ap.add_argument("--raw", action="store_true")
    args = ap.parse_args()
    data = asyncio.run(dump(args.raw))
    with open(args.dump, "w", encoding="utf8") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False, sort_keys=True)
    print(f"dumped {data.get('nodeCount', '?')} nodes / {data.get('edgeCount', '?')} edges -> {args.dump}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())