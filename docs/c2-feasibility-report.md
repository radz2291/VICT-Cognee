# C2 Feasibility Report — `@victframework/cognee` worker + scope + deletion

Date: 2026-09-25 · Branch `main` · Base reviewed commit `5f66a77` · This report: commit `81e2507` + doc commit
Repo: https://github.com/radz2291/VICT-Cognee (disposable proofs only; VICT / Quellight / Trading OS untouched; no VICT pack manifest or package API authored — explicit stop).

---

## 1. Exact versions and host

| Component | Version |
| --- | --- |
| cognee (pinned, `proof/.venv`) | 1.6.1 (source read at `upstream/cognee` @ same pin) |
| Python (proof venv) | 3.12.10 |
| Node (worker driver) | v22.13.1 (no npm dependencies) |
| Embeddings / extractor | fastembed `BAAI/bge-small-en-v1.5` (384d) / `gliner_demo` (keyless route) |
| Stores | lancedb + ladybug (per-dataset files), sqlite registry — all inside `proof/.cognee/` |
| Host | Windows 11 MINGW64, ~11.8 GB RAM (runs at 1–4 GB free), single-process discipline |

Reproduce (Windows, MINGW64):
```
cd proof && bash run_proof.sh                 # batteries 01–07, guard-enforced
# worker demo:
node worker/demo.mjs > worker/demo.log 2>&1
# scope + deletion batteries:
cd proof
.venv/Scripts/python.exe battery_08_scope_retrieval.py
.venv/Scripts/python.exe battery_09a_delete.py && .venv/Scripts/python.exe battery_09b_verify_after_restart.py
```
All destructive scripts fail closed at import via `proof/guard_store_roots.py` (see §2).

## 2. Proof-run safety (committed before any proof run)

**Finding (source-confirmed + observed):** cognee 1.6.1 resolves `.env` by dotenv
walk-up anchored at the **installed package** (script mode), and
`load_dotenv(override=True)` clobbers process-env overrides. An external interpreter
(`PROOF_PY`) can silently adopt a foreign `.env`; with none found it defaults to
`.cognee_system` **inside site-packages**. A misdirected `prune_system` would wipe
the wrong store.

**Fix:** `proof/guard_store_roots.py` resolves **all seven destructive roots**
(system/data/cache/logs/repos + `vector_db_url` + `graph_file_path`) in the target
interpreter and verifies each is strictly inside the disposable proof workspace.
Uncertainty (resolution failure, remote URL, unexpected provider) is a violation —
fail closed, exit 2 **before any destructive call**. Wired into `battery_common`
(every battery, `.venv` or `PROOF_PY`) and into `run_proof.sh`.

**Guard tests (no destructive battery executed):** misdirected `.env`
(`SYSTEM_ROOT_DIRECTORY` → temp dir) → guard exits 2; `battery_05b` (holds
`prune_system`) under the same misdirection refuses at import — battery body never
ran, misdirected dir untouched; `.env` restored → guard passes. Committed `17b1edc`.

## 3. Demonstrated deployment shape (disposable worker, not a pack)

`worker/worker.py` (Python, guard-enforced) + `worker/demo.mjs` (Node driver):
**supervised long-lived child process**, NDJSON over stdin/stdout (1 MiB line cap),
diagnostics on stderr only, per-op timeouts on the Node side, structured errors
`{code, message}`, graceful `shutdown`, RSS reported via psutil.

Two operational findings shaped the shape:
- **cognee's vector *and* graph layers default to subprocess forks**
  (`*_subprocess_enabled=True`). Killed workers left orphaned forks holding
  ladybug `.lbug` file locks; the next worker failed with lock errors. The worker
  therefore runs with `VECTOR_DB_SUBPROCESS_ENABLED=false` and
  `GRAPH_DATABASE_SUBPROCESS_ENABLED=false` — one supervised process owns its store;
  SIGKILL then releases locks with the process.
- **cognee's dataset context is a ContextVar that persists across sequential ops in
  the same asyncio task** (observed: a direct retriever after a scoped search still
  saw the previous dataset's store). The worker dispatches **each op in its own
  `asyncio.run`** — per-request context isolation is structural, not disciplinary.

**Child-process route met the requirements; local HTTP was not needed** (no TCP
surface, lifecycle tied to supervisor, startup cost identical). HTTP remains the
documented fallback only if a future requirement (multi-consumer fan-in) appears.

### Demonstrated scenarios + measurements (`worker/demo-results.json`)

| Scenario | Result | Measurement |
| --- | --- | --- |
| Cold startup (spawn→ready) | OK | 26.5–88.9 s across runs (host RAM-dependent; import dominates) |
| RSS at ready | OK | ~328 MB |
| Scoped add (c2_worker_demo) | OK | 1.8–5.2 s |
| Scoped cognify (2-doc dataset, gliner) | OK | 30.6–50.3 s |
| Scoped search CHUNKS | OK | 0.94–1.1 s warm worker; 12–33 s incl. model reload after restart |
| RSS after cognify | OK | 1.93–1.99 GB |
| Clean shutdown (exit 0) | OK | 3.8–15.2 s |
| Restart + persistence | OK, previous data returned | warm start 24–30 s |
| Structured errors | `UNKNOWN_OP`, `INVALID_PARAMS` typed codes; malformed JSON → `BAD_REQUEST` | — |
| `cognify(nonexistent dataset)` | **silent success (no-op)** — nuance vs battery 06's typed error on a dataset-less user; contract decision: pack must validate dataset existence itself | — |
| Killed worker (SIGKILL mid-add) | Node gets `WORKER_DIED`; mutating op reported **`outcome: "unknown"`**; **no automatic retry**; read-back reconciliation reported the write had **not** landed | kill detected in <1 s |

## 4. Isolation results (battery_08, 2 datasets × 2 users)

Setup: user A owns `c2_alpha` + `c2_beta`, user B owns `c2_gamma`, each with unique
marker tokens. Default env: ladybug + lancedb per-dataset handlers → backend access
control **on** (`ENABLE_BACKEND_ACCESS_CONTROL` unset ⇒ auto-enable when supported).

Observed:
- **Public dataset-scoped search is enforced at store level**: `search(CHUNKS,
  datasets=["c2_alpha"])` returned only alpha content (`datasets_seen=["c2_alpha"]`);
  unscoped search returned the user-wide union (A's datasets only, not B's).
- **Strict resolution**: unknown dataset name → typed failure (`NoDataError` for a
  valid-but-empty resolution path; `DatasetNotFoundError` for cross-user names).
  Names resolve only among datasets the caller may read — **B querying A's dataset
  name fails**; user isolation holds on semantic and lexical public paths.
- **Direct scored BM25 (`BM25ChunksRetriever(with_scores=True)`) is unsafe as a pack
  surface**: no dataset/scope constructor kwarg (TypeError); in a clean default task
  it resolved to an **ambient store, returning only user B's private content while
  running under user A's identity**; after scoped searches in the same task it kept
  seeing the last-searched dataset's store (ContextVar persistence). The only safe
  scored usage is inside `set_database_global_context_variables(dataset_id,
  owner_id)` — an internal context API that yields **scores AND correct scope**
  (decisive probe: alpha only, score present, zero beta) — but "internal API" is not
  a first-release contract.
- **Public lexical (`CHUNKS_LEXICAL`) with `datasets=[...]` is dataset-scoped but
  returns no scores** (registry drops `with_scores`; C1 finding re-confirmed in
  scoped mode).
- **NodeSet (`node_name`) pre-filter works at the vector store**
  (`array_has_*` on `payload.belongs_to_set`; nonexistent set → 0 hits). Chunk
  payloads carry `belongs_to_set` by default, but meaningful NodeSet scoping
  requires a tagging strategy — a Stage-9 contract decision.
- **Semantic CHUNKS exposes scores via the supported public API**: each hit carries
  `score` = raw cosine distance, **lower = better** (on-corpus 0.279 vs off-corpus
  0.474 on this tiny probe). Separation observed; **no universal threshold adopted**
  from the five-entry C1 probe — results without a validated relevance test are
  **candidates only** (C1's off-corpus top-hit failures remain the operative caveat).

### Scope verdict (per the C2 question)
The direct scored BM25 retriever **cannot enforce exact dataset/NodeSet scope
through a supported API together with scores**. Consequence applied: **scored
lexical search is REMOVED from the proposed first-release boundary.** No post-hoc
filtering compensation (that would require retrieving unauthorized content first).
Dataset and NodeSet scoping remain available on the semantic CHUNKS path.

## 5. Dataset-level deletion (battery_09a + 09b, true restart)

- `forget(dataset="c2_del")` → `{'status': 'success'}`; same-process: name
  resolution fails typed; **per-dataset store files removed from disk**.
- After **restart** (fresh process): user-wide search returns **0** deleted-content
  hits; scoped search on the deleted name → typed `DatasetNotFoundError`;
  `<user>/<dataset>.{lance.db,.lbug,.lbug.wal}` absent on disk.
- Verdict (revises the C1 caution for datasets): dataset-level forget performs a
  **file-level physical purge** of the dataset's graph and vector databases in the
  per-dataset (access-control) layout. C1's residue finding concerned **item-level**
  forget — that path remains out of the boundary.
- Still unverified about physical purge: OS-level recovery of deleted files,
  any write-back caching outside the observed files, snapshot/backup surfaces
  (none configured), behavior under concurrent readers during delete.

## 6. Revised first-release candidate list

| # | Capability | Status vs C1 | Notes |
| --- | --- | --- | --- |
| 1 | `add` (dataset-scoped) | kept | idempotent by content hash (C1) |
| 2 | `cognify` (dataset-scoped) | kept | long-running; worker must validate dataset existence (silent no-op observed) |
| 3 | `searchChunks` (semantic) | kept, refined | top-k **candidates**; cosine-distance `score` exposed (lower=better); optional `datasets` and `node_name` scopes (store-level pre-filter); no threshold adopted |
| 4 | `searchSummaries` | kept | unchanged since C1; not re-tested in C2 |
| 5 | `graphContext` | kept | unchanged since C1; not re-tested in C2 |
| 6 | `datasetsStatus` / list | kept | unchanged |
| 7 | `forgetDataset` | kept, strengthened | file-level purge observed after restart (§5); dataset scope only — **no item-level deletion** |
| — | **scored lexical search** | **REMOVED** | cannot combine scores with safe scoping via supported APIs (§4) |

## 7. Unresolved contract decisions (for the owner / Stage 9)

1. **Bridge mechanics**: child process met requirements (§3) — confirm stdio-supervised
   worker as the direction; keep HTTP only as documented fallback.
2. **Completion-type searches** need an LLM key — out of scope until a key policy exists.
3. **Actor mapping**: one cognee user per VICT actor vs a service principal + VICT-side
   checks (cross-user isolation is enforced by cognee when users differ; same-user
   scoping is dataset/node_name only).
4. **NodeSet tagging strategy**: how VICT scopes map to `belongs_to_set` membership
   (ingestion-time tagging required for meaningful `node_name` filters).
5. **Deletion guarantees**: is file-level purge sufficient for VICT effect classes,
   or is a verification step (post-delete search + disk check) mandatory per delete?
6. **`cognify` semantics**: sync vs background job, and pack-side dataset-existence
   validation (silent no-op observed).
7. **Subprocess settings**: disabling cognee's vector/graph subprocess forks is
   load-bearing for the worker (lock leaks on kill) — confirm as a supported
   long-term posture or get upstream guidance.
8. **Pin/upgrade cadence**: all findings are pinned to cognee 1.6.1 + Node 22.

## 8. Limits

Single Windows host, small synthetic corpora, RAM-constrained machine (timings are
envelopes, not SLOs); no LLM key (completion paths untested); battery_08's
ambient-store probe is recorded as a hazard, not fully characterized; cold-start
variance (26–89 s) reflects host memory pressure. The worker is disposable proof
code in `worker/` — **no VICT manifest, no pack API, no Stage-9 design** (explicit
stop).
