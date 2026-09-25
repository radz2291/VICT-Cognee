"""Disposable cognee worker for the C2 feasibility proof (NOT a VICT pack).

Long-lived supervised child process driven over a bounded local protocol:
  - stdin/stdout carry NDJSON (one JSON object per line, max 1 MiB/line).
  - stderr carries diagnostics only (never protocol data).
  - Every destructive/storage decision is guarded at startup by
    proof/guard_store_roots.py (fail closed before the first op).

Request:  {"id": "<n>", "op": "add|cognify|search|forget_dataset|status|ping|shutdown", ...params}
Response: {"id": "<n>", "ok": true, "result": {...}} or
          {"id": "<n>", "ok": false, "error": {"code": "...", "message": "..."}}
One unsolicited line at startup: {"type": "ready", ...}

Protocol is deliberately minimal; Node side enforces per-op timeouts and
outcome-unknown semantics when the worker dies mid-request (see demo.mjs).
"""

from __future__ import annotations

import json
import sys
import time

MAX_LINE = 1024 * 1024  # 1 MiB bound on any single protocol line

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[1] / "proof"))


def _rss_bytes() -> int:
    """Best-effort RSS of this process: psutil (present via cognee deps),
    then Windows psapi, then POSIX resource, else 0 (diagnostics only)."""
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


def main() -> int:
    t0 = time.perf_counter()

    # Guard FIRST (imports cognee; fail closed if roots are not in proof workspace).
    from guard_store_roots import enforce_or_die

    enforce_or_die(label="worker startup")

    import cognee
    from cognee.modules.search.types import SearchType

    import_ms = int((time.perf_counter() - t0) * 1000)
    _emit({"type": "ready", "pid": None, "rss_bytes": _rss_bytes(),
           "import_ms": import_ms, "protocol": "vict-cognee-worker/1"})

    ops_served = 0

    def ok(req_id, result):
        _emit({"id": req_id, "ok": True, "result": result})

    def err(req_id, code, message, detail=None):
        _emit({"id": req_id, "ok": False,
               "error": {"code": code, "message": message, "detail": detail}})

    async def dispatch(op: str, params: dict):
        if op == "ping":
            return {"pong": True}
        if op == "status":
            return {"pid": None, "rss_bytes": _rss_bytes(),
                    "uptime_s": round(time.perf_counter() - t0, 2),
                    "ops_served": ops_served}
        if op == "add":
            dataset = params.get("dataset")
            text = params.get("text")
            if not dataset or not isinstance(text, str) or not text:
                raise ValueError("INVALID_PARAMS: add requires dataset and non-empty text")
            res = await cognee.add(text, dataset_name=dataset)
            return {"dataset": dataset, "returned": repr(res)[:300]}
        if op == "cognify":
            datasets = params.get("datasets")
            res = await cognee.cognify(datasets=datasets)
            return {"datasets": datasets, "returned": repr(res)[:300]}
        if op == "search":
            query = params.get("query")
            stype = params.get("query_type", params.get("search_type", "CHUNKS"))
            if not query:
                raise ValueError("INVALID_PARAMS: search requires query")
            kwargs = {"query_text": query, "query_type": SearchType[stype]}
            if params.get("datasets"):
                kwargs["datasets"] = params["datasets"]
            if params.get("node_name"):
                kwargs["node_name"] = params["node_name"]
            if params.get("top_k"):
                kwargs["top_k"] = int(params["top_k"])
            res = await cognee.search(**kwargs)
            return {"hits": json.loads(json.dumps(res, default=str))[:20]}
        if op == "forget_dataset":
            dataset = params.get("dataset")
            if not dataset:
                raise ValueError("INVALID_PARAMS: forget_dataset requires dataset")
            res = await cognee.forget(dataset=dataset)
            return {"dataset": dataset, "returned": repr(res)[:300]}
        raise KeyError(f"UNKNOWN_OP: {op}")

    import asyncio

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
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
            ok(req_id, {"bye": True, "rss_bytes": _rss_bytes(),
                        "ops_served": ops_served})
            return 0
        try:
            result = asyncio.run(dispatch(op, {k: v for k, v in req.items()
                                               if k not in ("id", "op")}))
            ops_served += 1
            ok(req_id, result)
        except KeyError as exc:
            ops_served += 1
            err(req_id, "UNKNOWN_OP", str(exc).strip("'"))
        except (ValueError, TypeError) as exc:
            ops_served += 1
            err(req_id, "INVALID_PARAMS", str(exc))
        except Exception as exc:  # noqa: BLE001 — structured error boundary
            code = type(exc).__name__
            err(req_id, "COGNEE_ERROR", f"{code}: {exc}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
