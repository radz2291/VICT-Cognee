"""Disposable cognee worker v4 for the C3/C4 pack-contract proofs (NOT a VICT pack).

Aligned to docs/c3-pack-contract.md (§7/§9/§11) + the C4 corrections:
  - stdout carries bounded NDJSON protocol messages ONLY (<= 1 MiB/line);
    all diagnostics go to stderr and are never parsed by the client.
  - Environment pins are set by the worker itself BEFORE cognee is imported
    (vector/graph subprocess layers disabled: killed workers would otherwise
    orphan fork holders of ladybug locks; single-thread + bounded kuzu pool).
  - Storage guard (proof/guard_store_roots.py) fail-closes at startup unless
    every destructive root resolves inside the --store-root boundary.
  - Trust boundary: ONE worker per store (one trust domain); namespace scope
    enforcement at the interface is a SAFETY RAIL, not per-actor authorization.
    datasetsStatus is scope-filtered: it never lists datasets whose interface
    address is not `<granted-ns>.<name>`.
  - Durable keyed reconciliation (C4 corrections):
      * the retry key comes EXCLUSIVELY from the request `ctx`
        (VICT CapabilityContext.idempotencyKey). A key supplied via op params
        is rejected (COGNEE_PARAMS_REJECTED) — exclusivity is enforced here;
      * every journal key is BOUND to (op, dataset, input fingerprint);
        reusing a key for another op/dataset/content is rejected with
        COGNEE_IDEMPOTENCY_MISMATCH (journal state unchanged);
      * completed entry  -> replay recorded outcome, NO re-execution;
      * begun w/o commit -> previous attempt did not durably complete;
        outcome unknown -> re-execute (convergent: cognee content-hash dedupe
        for add; pipeline re-run for cognify) and commit fresh counts;
      * no entry         -> fresh execution.
    Every response carries item-level counts (itemsBefore/itemsAfter).
    forget_dataset is NEVER journaled and NEVER auto-retried.
  - Every worker death with a pending mutation is an unknown outcome (client
    maps ANY in-flight mutation at worker exit to COGNEE_WRITE_UNKNOWN;
    kills + respawns; the journal makes the reissue reconcile).
  - PROOF-ONLY fault injection (C4 crash-window test): env C4_FAULT may be
    set to 'add.after-write-before-commit' or 'cognify.after-write-before-'
    'commit'; the worker then os._exit(2)s AFTER cognee's write returns but
    BEFORE the journal commit — deterministically creating the exact window
    between the external mutation and the durable journal record. Default is
    OFF; the hook is inert unless the env var is set explicitly.

Request:  {"id": "<n>", "op": "add|cognify|search_chunks|search_summaries|
           datasets_status|forget_dataset|status|ping|shutdown", ...params,
           "ctx": {"idempotencyKey": "...", "attemptNumber": 1}}
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
import pathlib
import re

# ---- explicit dotenv (C1 finding #9: cognee's own load_dotenv() walks up from
# site-packages and with override=True clobbers process env — neutralize it and
# load OUR env file explicitly, anchored to the worker's cwd) ----------------
_ENV_FILE = pathlib.Path.cwd() / ".env"
import dotenv

_orig_load_dotenv = dotenv.load_dotenv
dotenv.load_dotenv = lambda *a, **k: False   # neutralize cognee's walk-up load
_orig_load_dotenv(str(_ENV_FILE), override=True)  # explicit, cwd-anchored

MAX_LINE = 1024 * 1024            # 1 MiB bound on any single protocol line
MAX_TOP_K = 25                    # contract §4 bound
MAX_DATASETS = 8                  # per search request
MAX_CONTENT_CHARS = 512_000
MAX_QUERY_CHARS = 2_000
NAME_RE = re.compile(r"^[^.\s]+\.[^.\s]+$")
JOURNAL_NAME = "c4_idempotency_journal.jsonl"

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "proof"))


class ScopeViolation(Exception):
    """Request failed interface scope/authorization checks (no cognee call)."""


class ParamsViolation(Exception):
    """Request failed interface parameter bounds (no cognee call)."""


class IdempotencyMismatch(Exception):
    """Journal key bound to a different (op, dataset, fingerprint) — the
    caller re-uses a key for different logical work. Rejected without
    touching journal state (no cognee call)."""


def _fault(point: str) -> None:
    """PROOF-ONLY fault injection (env C4_FAULT, default OFF)."""
    hook = os.environ.get("C4_FAULT", "")
    if hook and hook == point:
        _dlog(f"FAULT-INJECTION: {point} -> os._exit(2) (forced crash)")
        os._exit(2)


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
                            ("QuotaPagedPoolUsage", ctypes.c_size_t),
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

    def filter_names(self, stored_names: list[str]) -> tuple[list[dict], int]:
        """Scope-filter a listing of stored cognee names for datasetsStatus.

        A stored name is exposed ONLY if it maps to '<granted-ns>.<name>'.
        Everything else (pre-existing un-namespaced datasets, datasets of
        non-granted namespaces) is HIDDEN — counted, never named. This is a
        store-safety rail for the one-store-per-trust-domain deployment; it is
        NOT per-actor authorization.
        """
        kept: list[dict] = []
        hidden = 0
        for stored in stored_names:
            ns, sep, rest = stored.partition("__")
            if sep and ns in self.namespaces and rest:
                kept.append({"name": f"{ns}.{rest}"})
            else:
                hidden += 1
        return kept, hidden


class IdempotencyJournal:
    """Durable begin/commit journal for mutating ops (VICT keyed writes).

    Layout: one JSON line per record, fsynced, inside the guarded system root:
      {"state": "begun", "key", "op", "dataset", "items_before", "started_at"}
      {"state": "completed", "key", "op", "dataset", "items_before",
       "items_after", "started_at", "completed_at", "duration_ms"}
    The latest record for a key decides reconciliation. Each key is BOUND to
    (op, dataset, fingerprint — C4): a request whose binding differs from the
    durable record is a COGNEE_IDEMPOTENCY_MISMATCH; the journal state is
    never changed by a mismatched request.
    """

    def __init__(self, path: str):
        self.path = path

    def find(self, key: str) -> dict | None:
        """Latest durable record for key, or None."""
        found = None
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue  # torn tail write: treat as absent
                    if rec.get("key") == key:
                        found = rec
        except FileNotFoundError:
            return None
        return found

    def _append(self, rec: dict) -> None:
        line = json.dumps(rec, default=str)
        with open(self.path, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
            fh.flush()
            os.fsync(fh.fileno())

    def begin(self, key: str, op: str, dataset: str, fingerprint: str,
              items_before: int) -> None:
        self._append({"state": "begun", "key": key, "op": op, "dataset": dataset,
                      "fingerprint": fingerprint, "items_before": items_before,
                      "started_at": time.time(), "pid": os.getpid()})

    def commit(self, key: str, op: str, dataset: str, fingerprint: str,
               items_before: int, items_after: int, started_at: float) -> None:
        self._append({"state": "completed", "key": key, "op": op,
                      "dataset": dataset, "fingerprint": fingerprint,
                      "items_before": items_before, "items_after": items_after,
                      "started_at": started_at, "completed_at": time.time(),
                      "pid": os.getpid()})


async def resolve_datasets(names: list[str], strict: bool = True):
    """Strict per-principal resolution; raises cognee's typed errors for
    unknown/cross-user names (mapped to COGNEE_DATASET_UNKNOWN by caller)."""
    from cognee.modules.data.methods import get_authorized_existing_datasets
    from cognee.modules.users.methods import get_default_user

    user = await get_default_user()
    return await get_authorized_existing_datasets(names, "read", user, strict=strict)


async def count_items(dataset_id) -> int:
    """Item-level count of a dataset's data rows (cognee registry)."""
    from cognee.modules.data.methods import get_dataset_data

    try:
        rows = await get_dataset_data(dataset_id)
        return len(rows or [])
    except Exception:  # noqa: BLE001 — counting must never crash a response
        return -1


async def _items_for_dataset_name(cognee_name: str) -> tuple[int, object | None]:
    """(items, dataset_row|None) — non-strict resolution for journal counts."""
    try:
        rows = await resolve_datasets([cognee_name], strict=False)
    except Exception:  # noqa: BLE001
        return 0, None
    if not rows:
        return 0, None
    return await count_items(rows[0].id), rows[0]


def _system_root() -> str:
    from cognee.base_config import get_base_config

    return get_base_config().system_root_directory


def _store_files(dataset_id: str):
    root = os.path.join(_system_root(), "databases")
    return [str(p) for p in pathlib.Path(root).rglob(f"{dataset_id}.*")]


def _bound_search(res, top_k: int, dataset_names: list[str]):
    """Normalize cognee search output and bound it (contract §4/§6).

    Declared hit fields are only those the worker can actually produce:
      text, score (raw cosine distance, LOWER = BETTER) and — only for
      single-dataset searches — datasetName. Any further chunk-payload fields
      are NOT part of the contract and are dropped.
    """
    rows = json.loads(json.dumps(res, default=str))
    flat: list[dict] = []
    if isinstance(rows, list) and rows and isinstance(rows[0], dict) \
            and "search_result" in rows[0]:
        for group in rows:
            flat.extend(group.get("search_result") or [])
    elif isinstance(rows, list):
        flat = rows
    else:
        return {"hits": [], "total": 0, "truncated": False,
                "rawShape": type(res).__name__}
    truncated = len(flat) > top_k
    hits = []
    for row in flat[:top_k]:
        if not isinstance(row, dict):
            hits.append({"text": str(row)[:500]})
            continue
        hit: dict = {}
        text = row.get("text") or row.get("summary") or row.get("name")
        if isinstance(text, str):
            hit["text"] = text[:4000]
        if "score" in row:
            try:
                hit["score"] = float(row["score"])
            except (TypeError, ValueError):
                pass
        if len(dataset_names) == 1:
            hit["datasetName"] = dataset_names[0]
        hits.append(hit)
    return {"hits": hits, "total": len(hits), "truncated": truncated}


async def dispatch(op: str, p: dict, scope: Scope, journal: IdempotencyJournal,
                   ctx: dict):
    import cognee
    from cognee.modules.search.types import SearchType

    if op == "ping":
        return {"pong": True}
    if op == "status":
        return {"rss_bytes": _rss_bytes(), "ops_served": p.get("_ops_served", 0),
                "pid": os.getpid()}

    if op in ("add", "cognify"):
        # ---- interface checks BEFORE any cognee call -----------------------
        scope.check_name(p.get("datasetName") or (p.get("datasets") or [None])[0])
        dataset = p.get("datasetName") or p["datasets"][0]
        # C4 exclusivity: the retry key comes EXCLUSIVELY from ctx
        # (VICT CapabilityContext.idempotencyKey). A key smuggled through op
        # params is rejected before anything else happens.
        if "idempotencyKey" in p or "retryKey" in p:
            raise ParamsViolation(
                f"{op} must not carry an idempotencyKey in params: the retry key "
                "comes exclusively from CapabilityContext (request ctx)")
        key = (ctx or {}).get("idempotencyKey")
        # The durable orchestration driver derives the key only when the graph
        # node declares a retry policy; a handler without a ctx key is a
        # non-keyed write — VICT never replays those, so the interface refuses.
        if not isinstance(key, str) or not key:
            raise ParamsViolation(
                f"{op} requires ctx.idempotencyKey (VICT CapabilityContext.idempotencyKey); "
                "declare a retry policy on the graph node so the runtime derives one")
        # C4 binding: key -> (op, dataset, input fingerprint).
        if op == "add":
            content = p.get("content") or p.get("text")
            if not isinstance(content, str) or not content:
                raise ParamsViolation("add requires non-empty content")
            if len(content) > MAX_CONTENT_CHARS:
                raise ParamsViolation(f"content exceeds {MAX_CONTENT_CHARS} chars")
            fingerprint = hashlib.sha256(json.dumps(
                {"op": op, "dataset": dataset, "content": content},
                sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        else:
            fingerprint = hashlib.sha256(json.dumps(
                {"op": op, "dataset": dataset}, sort_keys=True,
                ensure_ascii=False).encode("utf-8")).hexdigest()

        cognee_name = to_cognee_name(dataset)
        if op == "cognify":
            # existence precheck BEFORE journaling: cognee 1.6.1 cognify on a
            # missing dataset is a silent no-op (C2) — neutralize first
            await resolve_datasets([cognee_name], strict=True)
        started_at = time.time()
        t = time.perf_counter()

        # ---- durable reconciliation (key bound to op/dataset/fingerprint) --
        prior = journal.find(key)
        if prior:
            if (prior.get("op") != op or prior.get("dataset") != cognee_name
                    or prior.get("fingerprint") != fingerprint):
                raise IdempotencyMismatch(
                    f"idempotency key {key!r} is durably bound to "
                    f"({prior.get('op')}, {prior.get('dataset')}) with a different "
                    "input fingerprint; refusing to reuse it for different logical work")
        if prior and prior.get("state") == "completed":
            return {"datasetName": dataset, "idempotencyKey": key,
                    "reconciled": "replayed-known-outcome",
                    "itemsBefore": prior.get("items_before"),
                    "itemsAfter": prior.get("items_after"),
                    "deduplicated": prior.get("items_after") ==
                                    prior.get("items_before"),
                    "duration_ms": int((time.perf_counter() - t) * 1000)}

        if prior and prior.get("state") == "begun":
            # Previous attempt did not durably complete (worker death / lost
            # process). Outcome unknown -> re-execute (convergent), then commit.
            reconciled = "reissued-after-interruption"
            items_before = prior.get("items_before", 0)
        else:
            reconciled = "fresh-execution"
            items_before, _row = await _items_for_dataset_name(cognee_name)
            journal.begin(key, op, cognee_name, fingerprint, items_before)

        if op == "add":
            await cognee.add(content, dataset_name=cognee_name)
        else:  # cognify (precheck already done above)
            await cognee.cognify(datasets=[cognee_name])

        # C4 crash-window: PROOF-ONLY fault point AFTER cognee's write returns
        # but BEFORE the journal commit (env C4_FAULT, default OFF).
        _fault(f"{op}.after-write-before-commit")

        items_after, _row = await _items_for_dataset_name(cognee_name)
        journal.commit(key, op, cognee_name, fingerprint, items_before,
                       items_after, started_at)
        return {"datasetName": dataset, "idempotencyKey": key,
                "reconciled": reconciled, "itemsBefore": items_before,
                "itemsAfter": items_after,
                "deduplicated": items_after == items_before,
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
        out = _bound_search(res, top_k, datasets)
        out["datasets"] = datasets
        out["duration_ms"] = int((time.perf_counter() - t) * 1000)
        return out

    if op == "datasets_status":
        from cognee.modules.data.methods import get_authorized_existing_datasets
        from cognee.modules.users.methods import get_default_user

        user = await get_default_user()
        rows = await get_authorized_existing_datasets(None, "read", user)
        kept, hidden = scope.filter_names([r.name for r in rows])
        return {"datasets": sorted(kept, key=lambda d: d["name"]),
                "hiddenDatasets": hidden, "namespaces": scope.namespaces}

    if op == "forget_dataset":
        # irreversible: journaled NEVER, auto-retried NEVER. An interrupted
        # forget is an unknown outcome reconciled by observation only.
        scope.check_name(p.get("datasetName"))
        dataset = p["datasetName"]
        (dsrow,) = await resolve_datasets([to_cognee_name(dataset)])
        ds_id = str(dsrow.id)
        before = _store_files(ds_id)
        t = time.perf_counter()
        res = await cognee.forget(dataset=to_cognee_name(dataset))
        after = _store_files(ds_id)
        return {"datasetName": dataset, "datasetId": ds_id,
                "storeFilesBefore": len(before), "storeFilesAfter": len(after),
                "purged": "file-level" if before and not after else "not-observed",
                "duration_ms": int((time.perf_counter() - t) * 1000)}

    raise ParamsViolation(f"unknown op '{op}'")  # params-level: typed rejection


def main() -> int:
    t0 = time.perf_counter()
    ap = argparse.ArgumentParser()
    ap.add_argument("--allow-ns", action="append", default=[],
                    help="granted dataset namespace prefix (repeatable)")
    ap.add_argument("--store-root", default=None,
                    help="fail-closed containment boundary for the store guard")
    args = ap.parse_args()
    if not args.allow_ns:
        _dlog("FATAL: no --allow-ns granted; refusing to serve")
        return 2
    scope = Scope(args.allow_ns)

    # Guard FIRST (imports cognee; fail closed if roots are not in the boundary).
    from guard_store_roots import enforce_or_die

    # stdout is protocol-only: route the guard's human-readable report to stderr
    import contextlib
    import io

    boundary = args.store_root or (
        pathlib.Path(__file__).resolve().parents[1] / "proof")
    _guard_out = io.StringIO()
    try:
        with contextlib.redirect_stdout(_guard_out):
            enforce_or_die(label="worker startup", allow_root=boundary)
    except SystemExit:
        for _gline in _guard_out.getvalue().splitlines():
            _dlog(_gline)
        raise
    for _gline in _guard_out.getvalue().splitlines():
        _dlog(_gline)

    # ---- migration warm-up with stdout captured ----------------------------
    # cognee 1.6.1's first-connect alembic migrations PRINT to stdout (e.g.
    # "sync_operations table already exists, skipping creation") — that would
    # contaminate the protocol channel on a fresh store's first op. Force the
    # migrations NOW, with stdout redirected to stderr, before serving.
    async def _warmup() -> None:
        from cognee.infrastructure.databases.relational.create_db_and_tables import (
            create_db_and_tables,
        )

        await create_db_and_tables()

    with contextlib.redirect_stdout(sys.stderr):
        asyncio.run(_warmup())

    import_ms = int((time.perf_counter() - t0) * 1000)
    _emit({"type": "ready", "pid": os.getpid(), "rss_bytes": _rss_bytes(),
           "import_ms": import_ms, "protocol": "vict-cognee-worker/4",
           "allowed_namespaces": args.allow_ns,
           "store_root": str(boundary)})

    ops_served = 0
    journal = IdempotencyJournal(os.path.join(_system_root(), JOURNAL_NAME))
    _dlog(f"journal at {journal.path}")

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
        params = {k: v for k, v in req.items() if k not in ("id", "op", "ctx")}
        ctx = req.get("ctx") if isinstance(req.get("ctx"), dict) else None
        try:
            result = asyncio.run(dispatch(op, params, scope, journal, ctx))
            ops_served += 1
            ok(req_id, result)
        except ScopeViolation as exc:
            ops_served += 1
            err(req_id, "COGNEE_SCOPE_REJECTED", str(exc))
        except ParamsViolation as exc:
            ops_served += 1
            err(req_id, "COGNEE_PARAMS_REJECTED", str(exc))
        except IdempotencyMismatch as exc:
            ops_served += 1
            err(req_id, "COGNEE_IDEMPOTENCY_MISMATCH", str(exc),
                {"op": op, "idempotencyKey": (ctx or {}).get("idempotencyKey")})
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