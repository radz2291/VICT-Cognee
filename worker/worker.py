"""Disposable cognee worker v2 for the C3 pack-contract proof (NOT a VICT pack).

Aligned to docs/c3-pack-contract.md §9/§11:
  - stdout carries bounded NDJSON protocol messages ONLY (<= 1 MiB/line);
    all diagnostics go to stderr and are never parsed by the client.
  - Environment pins are set by the worker itself BEFORE cognee is imported
    (vector/graph subprocess layers disabled: killed workers would otherwise
    orphan fork holders of ladybug locks; single-thread + bounded kuzu pool).
  - Storage guard (proof/guard_store_roots.py) fail-closes at startup unless
    every destructive root resolves inside the pack-owned system root.
  - Namespace scope enforcement at the interface: every request must carry a
    dataset address `<ns>.<name>` with ns in the --allow-ns list; unscoped or
    out-of-namespace requests are rejected (COGNEE_SCOPE_REJECTED) BEFORE any
    cognee call. top_k is bounded (1..25); responses are bounded with a
    truncated flag instead of growing unbounded.
  - Mutating ops are never internally retried; cognify resolves dataset
    existence first (cognee 1.6.1 cognify on a missing dataset is a silent
    no-op) and fails COGNEE_DATASET_UNKNOWN.
  - One op at a time; each op runs in its own asyncio task (cognee's dataset
    context is a ContextVar that persists across ops in one task).

Request:  {"id": "<n>", "op": "add|cognify|search_chunks|search_summaries|
           datasets_status|forget_dataset|status|ping|shutdown", ...params}
Response: {"id": "<n>", "ok": true, "result": {...}} or
          {"id": "<n>", "ok": false, "error": {"code": "...", "message": "..."}}
One unsolicited line at startup: {"type": "ready", ...}
"""

from __future__ import annotations

import json
import os
import sys
import time

# ---- worker-owned environment pins (MUST precede any cognee import) --------
os.environ.setdefault("VECTOR_DB_SUBPROCESS_ENABLED", "false")
os.environ.setdefault("GRAPH_DATABASE_SUBPROCESS_ENABLED", "false")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("KUZU_BUFFER_POOL_SIZE", "268435456")

import argparse
import asyncio
import hashlib
import pathlib  # noqa: F401 (used via __import__ below)
import re

MAX_LINE = 1024 * 1024            # 1 MiB bound on any single protocol line
MAX_TOP_K = 25                    # contract §4 bound
MAX_DATASETS = 8                  # per search request
MAX_CONTENT_CHARS = 512_000
MAX_QUERY_CHARS = 2_000
NAME_RE = re.compile(r"^[^.\s]+\.[^.\s]+$")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "proof"))


class ScopeViolation(Exception):
    """Request failed interface scope/authorization checks (no cognee call)."""


class ParamsViolation(Exception):
    """Request failed interface parameter bounds (no cognee call)."""


def _rss_bytes() -> int:
    try:
        import psutil

        return int(psutil.Process().memory_info().rss)
    except Exception:  # noqa: BLE001
        pass
    try:
        if sys.platform == "win32":
            import ctypes

            class _PMC(ctypes.Structure):
                _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                            ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]

            pmc = _PMC()
            pmc.cb = ctypes.sizeof(_PMC)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            if ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(pmc), pmc.cb):
                return int(pmc.WorkingSetSize)
            return 0
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024
    except Exception:  # noqa: BLE001 — diagnostics only
        return 0


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _dlog(msg: str) -> None:
    print(f"[worker] {msg}", file=sys.stderr, flush=True)


def content_key(*parts: str) -> str:
    return hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()[:32]


def to_cognee_name(addr: str) -> str:
    """Interface address '<ns>.<name>' -> cognee storage name (dots forbidden
    by cognee's check_dataset_name; use a double-underscore separator)."""
    ns, _, name = addr.partition(".")
    return f"{ns}__{name}"


def from_cognee_name(name: str) -> str:
    ns, sep, rest = name.partition("__")
    return f"{ns}.{rest}" if sep else name


class Scope:
    def __init__(self, namespaces: list[str]):
        self.namespaces = namespaces

    def check_name(self, dataset: str) -> None:
        if not isinstance(dataset, str) or not dataset:
            raise ScopeViolation("request is unscoped: datasetName is required")
        if not NAME_RE.match(dataset):
            raise ScopeViolation(f"datasetName must look like '<ns>.<name>': {dataset!r}")
        ns = dataset.split(".", 1)[0]
        if ns not in self.namespaces:
            raise ScopeViolation(
                f"namespace '{ns}' is not granted (allowed: {self.namespaces})")

    def check_names(self, datasets) -> list[str]:
        if not isinstance(datasets, list) or not (1 <= len(datasets) <= MAX_DATASETS):
            raise ParamsViolation(f"datasets must be a list of 1..{MAX_DATASETS} names")
        for d in datasets:
            self.check_name(d)
        return datasets


def _store_files(dataset_id: str):
    root = pathlib.Path(os.environ.get("SYSTEM_ROOT_DIRECTORY",
                                       ".cognee/system")) / "databases"
    return [str(p) for p in root.rglob(f"{dataset_id}.*")]


async def resolve_datasets(names: list[str]):
    """Strict per-principal resolution; raises cognee's typed errors for
    unknown/cross-user names (mapped to COGNEE_DATASET_UNKNOWN by caller)."""
    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.modules.users.methods import get_default_user

    user = await get_default_user()
    return await get_authorized_existing_datasets(names, "read", user, strict=True)


def _bound_search(res, top_k: int):
    """Normalize cognee search output and bound it (contract §4)."""
    rows = json.loads(json.dumps(res, default=str))
    truncated = False
    if isinstance(rows, list) and rows and isinstance(rows[0], dict) \
            and "search_result" in rows[0]:
        count = 0
        for group in rows:
            sr = group.get("search_result") or []
            if len(sr) > top_k:
                group["search_result"] = sr[:top_k]
                truncated = True
            count += len(group["search_result"])
        return {"shape": "grouped", "groups": rows, "total": count,
                "truncated": truncated}
    if isinstance(rows, list):
        truncated = len(rows) > top_k
        return {"shape": "flat", "hits": rows[:top_k], "total": min(len(rows), top_k),
                "truncated": truncated}
    return {"shape": "other", "raw": rows, "total": 0, "truncated": False}


async def dispatch(op: str, p: dict, scope: Scope):
    import cognee
    from cognee.modules.search.types import SearchType

    if op == "ping":
        return {"pong": True}
    if op == "status":
        return {"rss_bytes": _rss_bytes(), "ops_served": p.get("_ops_served", 0),
                "pid": os.getpid()}

    if op == "add":
        scope.check_name(p.get("datasetName") or p.get("dataset"))
        content = p.get("content") or p.get("text")
        if not isinstance(content, str) or not content:
            raise ParamsViolation("add requires non-empty content")
        if len(content) > MAX_CONTENT_CHARS:
            raise ParamsViolation(f"content exceeds {MAX_CONTENT_CHARS} chars")
        dataset = p["datasetName"] if "datasetName" in p else p["dataset"]
        t = time.perf_counter()
        res = await cognee.add(content, dataset_name=to_cognee_name(dataset))
        return {"datasetName": dataset,
                "retryKey": p.get("retryKey") or content_key(dataset, content),
                "returned": repr(res)[:200],
                "duration_ms": int((time.perf_counter() - t) * 1000)}

    if op == "cognify":
        scope.check_name(p.get("datasetName") or (p.get("datasets") or [None])[0])
        dataset = p.get("datasetName") or p["datasets"][0]
        await resolve_datasets([to_cognee_name(dataset)])  # precheck: silent no-op otherwise (C2)
        t = time.perf_counter()
        res = await cognee.cognify(datasets=[to_cognee_name(dataset)])
        return {"datasetName": dataset,
                "retryKey": p.get("retryKey") or content_key("cognify", dataset),
                "returned": repr(res)[:200],
                "duration_ms": int((time.perf_counter() - t) * 1000)}

    if op in ("search_chunks", "search_summaries"):
        datasets = scope.check_names(p.get("datasets"))
        query = p.get("query")
        if not isinstance(query, str) or not query:
            raise ParamsViolation("query is required")
        if len(query) > MAX_QUERY_CHARS:
            raise ParamsViolation(f"query exceeds {MAX_QUERY_CHARS} chars")
        top_k = p.get("topK", p.get("top_k", 5))
        if not isinstance(top_k, int) or isinstance(top_k, bool) \
                or not (1 <= top_k <= MAX_TOP_K):
            raise ParamsViolation(f"topK must be an integer in 1..{MAX_TOP_K}")
        stype = SearchType.CHUNKS if op == "search_chunks" else SearchType.SUMMARIES
        t = time.perf_counter()
        res = await cognee.search(query_text=query, query_type=stype,
                                  datasets=[to_cognee_name(d) for d in datasets],
                                  top_k=top_k)
        out = _bound_search(res, top_k)
        out["datasets"] = datasets
        out["duration_ms"] = int((time.perf_counter() - t) * 1000)
        return out

    if op == "datasets_status":
        from cognee.modules.data.methods import get_authorized_existing_datasets
        from cognee.modules.users.methods import get_default_user

        user = await get_default_user()
        rows = await get_authorized_existing_datasets(None, "read", user)
        listing = [{"name": from_cognee_name(r.name), "datasetId": str(r.id)}
                   for r in rows]
        return {"datasets": sorted(listing, key=lambda d: d["name"]), "key": "all"}

    if op == "forget_dataset":
        scope.check_name(p.get("datasetName"))
        dataset = p["datasetName"]
        (dsrow,) = await resolve_datasets([to_cognee_name(dataset)])
        ds_id = str(dsrow.id)
        before = _store_files(ds_id)
        t = time.perf_counter()
        res = await cognee.forget(dataset=to_cognee_name(dataset))
        after = _store_files(ds_id)
        return {"datasetName": dataset, "datasetId": ds_id,
                "returned": repr(res)[:200],
                "storeFilesBefore": len(before), "storeFilesAfter": len(after),
                "purged": "file-level" if before and not after else "not-observed",
                "duration_ms": int((time.perf_counter() - t) * 1000)}

    raise ParamsViolation(f"unknown op '{op}'")  # params-level: typed rejection


def main() -> int:
    t0 = time.perf_counter()
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-ns", action="append", default=[],
                    help="granted dataset namespace prefix (repeatable)")
    args = ap.parse_args()
    if not args.allow_ns:
        _dlog("FATAL: no --allow-ns granted; refusing to serve")
        return 2
    scope = Scope(args.allow_ns)

    # Guard FIRST (imports cognee; fail closed if roots are not in system root).
    from guard_store_roots import enforce_or_die

    # stdout is protocol-only: route the guard's human-readable report to stderr
    import contextlib
    import io

    _guard_out = io.StringIO()
    try:
        with contextlib.redirect_stdout(_guard_out):
            enforce_or_die(label="worker startup")
    except SystemExit:
        for _gline in _guard_out.getvalue().splitlines():
            _dlog(_gline)
        raise
    for _gline in _guard_out.getvalue().splitlines():
        _dlog(_gline)

    import_ms = int((time.perf_counter() - t0) * 1000)
    _emit({"type": "ready", "pid": os.getpid(), "rss_bytes": _rss_bytes(),
           "import_ms": import_ms, "protocol": "vict-cognee-worker/2",
           "allowed_namespaces": args.allow_ns})

    ops_served = 0

    def ok(req_id, result):
        _emit({"id": req_id, "ok": True, "result": result})

    def err(req_id, code, message, detail=None):
        _emit({"id": req_id, "ok": False,
               "error": {"code": code, "message": message, "detail": detail}})

    from cognee.api.v1.exceptions.exceptions import DatasetNotFoundError as _ApiDnf
    from cognee.modules.data.exceptions.exceptions import DatasetNotFoundError as _DataDnf
    from cognee.modules.retrieval.exceptions.exceptions import NoDataError

    # cognee raises the not-found pair from two different modules; both map to
    # the same contract code (COGNEE_DATASET_UNKNOWN).
    typed_map = (_ApiDnf, _DataDnf, NoDataError)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        _dlog(f"recv line bytes={len(line)}")
        if len(line) > MAX_LINE:
            _emit({"id": None, "ok": False,
                   "error": {"code": "LINE_TOO_LARGE",
                             "message": f"protocol line exceeds {MAX_LINE} bytes"}})
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"id": None, "ok": False,
                   "error": {"code": "BAD_REQUEST", "message": f"malformed JSON: {exc}"}})
            continue
        req_id = req.get("id")
        op = req.get("op")
        if op == "shutdown":
            ok(req_id, {"bye": True, "rss_bytes": _rss_bytes(), "ops_served": ops_served})
            return 0
        params = {k: v for k, v in req.items() if k not in ("id", "op")}
        try:
            result = asyncio.run(dispatch(op, params, scope))
            ops_served += 1
            ok(req_id, result)
        except ScopeViolation as exc:
            ops_served += 1
            err(req_id, "COGNEE_SCOPE_REJECTED", str(exc))
        except ParamsViolation as exc:
            ops_served += 1
            err(req_id, "COGNEE_PARAMS_REJECTED", str(exc))
        except typed_map as exc:
            ops_served += 1
            err(req_id, "COGNEE_DATASET_UNKNOWN",
                f"{type(exc).__name__}: {str(exc)[:160]}")
        except Exception as exc:  # noqa: BLE001 — structured error boundary
            ops_served += 1
            err(req_id, "COGNEE_ERROR", f"{type(exc).__name__}: {str(exc)[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
