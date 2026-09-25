"""Store-root guard for the disposable proof workspace (C2).

Before any script that can call ``prune_system`` (or otherwise delete/write
cognee storage), verify that cognee actually resolved EVERY destructive
storage root into this disposable proof workspace — for the normal ``.venv``
flow AND for ``PROOF_PY`` interpreter-reuse runs.

Motivation (observed in C1, source-confirmed in cognee 1.6.1):
  - cognee's dotenv discovery in script mode walks up from the INSTALLED
    PACKAGE (site-packages), not the CWD. An external interpreter whose venv
    sits under a directory with its own ``.env`` silently adopts that file,
    and with no ``.env`` at all cognee defaults to ``.cognee_system`` INSIDE
    SITE-PACKAGES. Either way a ``prune_system`` could wipe the wrong store.

Design: fail closed. Every root must (a) resolve without error, (b) be a
local filesystem path, (c) be strictly inside the allow-root. Uncertainty
(getter failure, unknown provider, relative/odd path) is a violation.

Usage as a module:
    from guard_store_roots import enforce_or_die
    enforce_or_die()          # sys.exit(2) with an explanation if unsafe

Usage standalone (guard tests / preflight):
    python guard_store_roots.py               # exit 0 | 2
    python guard_store_roots.py --json        # machine-readable verdict
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PROOF_DIR = Path(__file__).resolve().parent


def _norm(p: str | os.PathLike) -> str:
    """Normalize a storage root for containment comparison (Windows-aware)."""
    s = os.path.abspath(os.path.normpath(str(p)))
    if s.startswith("\\\\?\\"):
        s = s[4:]
    if os.name == "nt":
        s = s.lower()
    return s.rstrip("\\/") if len(s) > 3 else s


def _is_url(s: str) -> bool:
    return "://" in s


def collect_destructive_roots() -> tuple[dict[str, str], dict[str, str]]:
    """Resolve every destructive storage root cognee will write to or delete.

    Returns (roots, meta) where roots maps name -> resolved path string.
    Imports cognee (which applies dotenv resolution exactly as a battery
    would see it). Raises on any resolution failure — callers must treat
    that as a violation (fail closed).
    """
    import cognee  # noqa: F401  (dotenv side effects, same as any battery run)
    from cognee.base_config import get_base_config
    from cognee.infrastructure.databases.graph.config import get_graph_config
    from cognee.infrastructure.databases.vector.config import get_vectordb_config

    base = get_base_config()
    vec = get_vectordb_config()
    graph = get_graph_config()

    roots: dict[str, str] = {
        "system_root": base.system_root_directory,
        "data_root": base.data_root_directory,
        "cache_root": base.cache_root_directory,
        "logs_root": base.logs_root_directory,
        "repos_root": base.repos_root_directory,
    }

    if vec.vector_db_provider != "lancedb":
        raise RuntimeError(
            f"unexpected VECTOR_DB_PROVIDER={vec.vector_db_provider!r}; proof uses lancedb"
        )
    roots["vector_db_url"] = vec.vector_db_url  # directory for lancedb

    if graph.graph_database_provider not in ("ladybug", "kuzu"):
        raise RuntimeError(
            f"unexpected GRAPH_DATABASE_PROVIDER={graph.graph_database_provider!r}"
        )
    roots["graph_file_path"] = graph.graph_file_path  # database file

    meta = {
        "provider_vector": vec.vector_db_provider,
        "provider_graph": graph.graph_database_provider,
        "provider_relational": getattr(base, "db_provider", "sqlite"),
    }
    return roots, meta


def verify(allow_root: str | os.PathLike = PROOF_DIR) -> dict:
    """Fail-closed verification. Returns a verdict dict; never raises for
    expected violations. 'ok' is True only when every root is provably
    inside allow_root."""
    allow = _norm(allow_root)
    violations: list[str] = []
    notes: list[str] = []
    try:
        roots, meta = collect_destructive_roots()
    except Exception as exc:  # noqa: BLE001 — uncertainty IS a violation
        return {
            "ok": False,
            "violations": [f"UNRESOLVED: root collection failed: {type(exc).__name__}: {exc}"],
            "notes": ["fail-closed: cognee config could not be resolved"],
        }
    for name, val in roots.items():
        if not val:
            violations.append(f"EMPTY: {name}")
            continue
        if _is_url(val):
            violations.append(f"REMOTE-URL: {name}={val!r} (proof requires local paths)")
            continue
        norm = _norm(val)
        if norm == allow or norm.startswith(allow + os.sep):
            notes.append(f"{name} -> {val}")
        else:
            violations.append(f"OUTSIDE: {name}={val!r} is not inside allow-root {allow_root}")
    return {"ok": not violations, "violations": violations, "notes": notes, "meta": meta}


def enforce_or_die(allow_root: str | os.PathLike = PROOF_DIR, label: str = "") -> None:
    """Run verify(); sys.exit(2) (before ANY destructive work) if unsafe."""
    verdict = verify(allow_root)
    tag = f"[store-guard{':' + label if label else ''}] "
    if verdict["ok"]:
        print(tag + "OK — all destructive roots inside " + str(allow_root), flush=True)
        for note in verdict.get("notes", []):
            print(tag + "  " + note, flush=True)
        return
    print(tag + "REFUSING TO RUN — destructive storage roots are not verifiably "
          "inside the disposable proof workspace:", flush=True)
    for v in verdict["violations"]:
        print(tag + "  " + v, flush=True)
    print(tag + "This usually means the interpreter's dotenv walk-up adopted a "
          "foreign .env, or no .env was found and cognee defaulted to "
          "site-packages. Fix the interpreter/.env layout before running.",
          flush=True)
    sys.exit(2)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="Verify cognee destructive storage roots")
    ap.add_argument("--allow-root", default=str(PROOF_DIR))
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    verdict = verify(args.allow_root)
    if args.json:
        import json

        print(json.dumps(verdict, indent=2))
    else:
        for v in verdict.get("violations", []):
            print("VIOLATION:", v)
        for n in verdict.get("notes", []):
            print("inside:", n)
    sys.exit(0 if verdict["ok"] else 2)
