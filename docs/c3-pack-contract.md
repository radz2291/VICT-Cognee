# C3 — VICT Cognee Pack Contract (first release)

Date: 2026-09-25 · Repo: radz2291/VICT-Cognee @ `606bc7d3a1412faa5e56fc5bef4c028a604dde27`
VICT ABI reference (read-only): radz2291/vict-02 @ **`5ea0afe257d5e7f67e050fcae169746a25fd3cc4`** (2026-09-25, "fix(stage8-p1)" — clean tree; only `.pi/` untracked, untouched). Quellight (`5f709a5…`) and Trading OS (`38f654e2…`) untouched. VICT Stage 8 untouched.

This document defines the contract for a future `vict.cognee.memory` capability pack
**as a design deliverable only**. No package is published, no VICT code is modified,
and no consumer adoption is claimed. The disposable proof in `worker/` is aligned to
this contract (§11) but remains proof code.

---

## 1. ABI ground truth (what VICT actually enforces)

Verified against the reference sources at the commit above:

| ABI fact | Source |
| --- | --- |
| Manifest schema `vict.capability-pack@1`; fields `id`, `version` (semver), `victCompatibility`, `capabilities[]`, `contracts[]`, `permissions[]`, `configuration[]`, `secrets[]`, `doubles[]`, `evaluations[]`, `documentation`, `provenance` | `packages/sdk/src/pack.ts` (manifest interfaces; `PACK_INVALID_*` diagnostics) |
| Effect vocabulary is closed: `pure \| read \| write \| irreversible` | `pack.ts:288` (`EFFECT_CLASSES`), `packages/sdk/src/capability.ts` (`EffectClass`) |
| **A `write` capability MUST declare `idempotency: 'keyed'`** — manifest validation fails otherwise | `pack.ts:719` |
| Permissions are enforced BEFORE the handler: an ungranted permission fails invocation with a structured error; "the handler was not invoked" | `packages/runtime/src/authority.ts:220` |
| `irreversible` is denied by default in normal mode (needs explicit `allowIrreversible`); in `simulate`/`test` modes real read/write/irreversible implementations are unreachable — a registered double is required, otherwise the request fails closed | `packages/runtime/src/effect-policy.ts` |
| `victCompatibility` is checked against the runtime compat version — currently `'0.1.0'` (`VICT_RUNTIME_COMPAT_VERSION`); example packs declare `'^0.1.0'` | `packages/runtime/src/pack-install.ts:38,54`; `pack.ts:424,457` |
| Contracts are executable parse promises: `{ ok: true, value } \| { ok: false, issues[] }`; contract rejection surfaces as `VICT_KERNEL_CONTRACT_REJECTED` | `packages/contracts/src/define-contract.ts`; `packages/kernel/src/errors.ts` |
| Capability context carries `mode`, `attemptNumber`, `idempotencyKey`, `deadlineAt` (epoch-ms attempt deadline), `abortSignal`, and SCOPED config/secret readers (undeclared names unavailable) | `packages/sdk/src/capability.ts` (`CapabilityContext`) |
| Doubles are declared `{ capabilityId, modes: ['test','simulate'], revision }`; contracts of the original still apply to doubles | `pack.ts`; `capability.ts` (`DoubleInvoke`) |
| Reference write pattern (ledger pack): `effect:'write'`, `idempotency:'keyed'`, `ambiguity:'keyedRetry'`, permissions, required configuration, secrets, evaluations | `docs/builder-kit/capability-catalog.json` (`vict.example.ledger`) |

**Consequences for this pack:** every mutating capability is a keyed `write` (or
`irreversible`); scope and authorization are enforced by the pack BEFORE any Cognee
call (mirroring VICT's pre-handler enforcement); `victCompatibility: '^0.1.0'`.

## 2. Pack identity

- **Pack id:** `vict.cognee.memory` · **Version:** `0.1.0` (first release)
- **`victCompatibility`:** `'^0.1.0'`
- **Manifest schema:** `vict.capability-pack@1`; bindings separate (handlers never serialized)
- **Secrets: none.** First release is keyless (local fastembed embeddings, `gliner_demo`
  extraction, no LLM). A completion/LLM capability is out of scope (§10).
- **Configuration (required):**
  - `cognee.systemRoot` — absolute path of a **pack-owned** Cognee `SYSTEM_ROOT_DIRECTORY`
    (one per VICT runtime; never shared across runtimes or workspaces; see §8).
  - `cognee.allowedNamespaces` — comma-separated dataset namespace prefixes this
    runtime may address (e.g. `quellight,trading`). Drives interface scope checks (§4).

## 3. Actor → Cognee-user mapping

VICT's `CapabilityContext` exposes run/graph/node identity but **no end-user
identity**. Cognee enforces isolation between Cognee users and strict per-user
dataset resolution (C2 battery_08), but a VICT pack cannot map actors it does not
receive.

**First-release decision: one Cognee user per VICT runtime (service principal).**
- The pack binding host provisions/uses exactly one Cognee user; all datasets are
  owned by that principal. Cross-**Cognee-user** isolation is not relied upon in
  this release; **actor isolation is enforced by mandatory dataset namespaces**
  (§4): every dataset address is `<namespace>.<name>`, namespaces come from
  `cognee.allowedNamespaces`, and requests outside them are rejected at the
  Node-facing interface before any Cognee call.
- Per-actor Cognee users remain the documented future option when VICT passes an
  actor identity in context (deferred; requires a VICT-side identity contract).

## 4. Scope discipline (mandatory, interface-enforced)

- Every request MUST carry an explicit dataset address: `datasetName` (singular ops)
  or `datasets` (search ops). **Unscoped requests are rejected** with
  `COGNEE_SCOPE_REJECTED` before any Cognee call.
- Every dataset name MUST match `^(<allowed-ns>)\.[^.\s]+$` for one of the
  configured namespaces. Names outside the granted namespaces are rejected with
  `COGNEE_SCOPE_REJECTED` (authorization) — same pre-call enforcement point.
- Search `top_k` MUST be an integer in `1..25` (`COGNEE_PARAMS_REJECTED` otherwise);
  responses are bounded (§11): hits are truncated with `truncated: true` rather than
  growing unbounded.
- The worker additionally validates dataset existence for mutating ops (Cognee
  1.6.1 `cognify` on a nonexistent dataset is a **silent no-op** — C2 finding):
  `cognify` first resolves the dataset and fails `COGNEE_DATASET_UNKNOWN` if absent.

## 5. Capability decisions (the seven C2 candidates)

| C2 candidate | Decision | Effect / permission | Why defensible |
| --- | --- | --- | --- |
| add | **RETAIN** `cognee.add@1` | `write`, keyed; `cognee.write` | Content-hash idempotency (C1: same content does not duplicate); mandatory scope; typed unknown-outcome path (§7) |
| cognify | **RETAIN** `cognee.cognify@1` | `write`, keyed; `cognee.write` | Key = canonical hash of dataset content set; re-issue reconciles (observed cheap re-cognify); silent-no-op neutralized by existence precheck (§4) |
| chunk search | **RETAIN** `cognee.searchChunks@1` | `read`; `cognee.search` | Store-level dataset scoping proven (C2 battery_08); cosine-distance score exposed with **lower = better**; results are **candidates only** (§7.3) |
| summary search | **RETAIN** `cognee.searchSummaries@1` | `read`; `cognee.search` | Same search pipeline and strict dataset resolution; scoped behavior re-verified through the hardened interface in C3 proof (worker/c3-results.json, probe s6) |
| graph context | **DEFER** (not in first release) | — | Dataset-scope enforcement for raw graph access was not demonstrated (C1 observed it only unscoped). Per the C2 lexical precedent: no capability without a proven scope story. Revisit post-release |
| dataset status/list | **RETAIN** `cognee.datasetsStatus@1` | `read` | Lists only the service principal's own datasets (Cognee strict per-user resolution); needed for reconciliation (§7.2) and existence prechecks |
| dataset forget | **RETAIN** `cognee.forgetDataset@1` | **`irreversible`**; `cognee.delete` **and** runtime `allowIrreversible` | File-level purge verified after restart (C2 battery_09). Classifying it `irreversible` means VICT denies it by default in normal mode and never runs the real implementation in simulate/test — matching the verified-limits posture (§7.5) |

**First-release surface: six capabilities.** Nothing else (no completion searches,
no item deletion, no direct retrievers — §10).

## 6. Typed inputs and outputs

Contracts are `defineContract` parse promises (fail-closed); shapes below are the
authoritative `expected` strings. All inputs/outputs are JSON-serializable; every
output repeats `datasetName`.

```ts
// cognee.add@1 — input
{ datasetName: string;   // ^<ns>\.[^.\s]+$ , ns ∈ allowedNamespaces
  content: string;       // UTF-8 text, 1..512_000 chars
  nodeSet?: string }     // optional NodeSet tag within the dataset
// cognee.add@1 — output (receipt)
{ datasetName: string; documentId: string; deduplicated: boolean }

// cognee.cognify@1 — input
{ datasetName: string }
// cognee.cognify@1 — output
{ datasetName: string; dataPoints: number; alreadyUpToDate: boolean }

// cognee.searchChunks@1 — input
{ datasets: string[];    // 1..8 entries, each §4-valid
  query: string;         // 1..2_000 chars
  topK?: number }        // 1..25, default 5
// cognee.searchChunks@1 — output (CANDIDATES, not answers)
{ hits: Array<{ datasetName: string; text: string; score: number;
               datasetId: string }>;  // score = raw cosine distance, LOWER = BETTER
  truncated: boolean }

// cognee.searchSummaries@1 — input / output
// input identical to searchChunks; output: { summaries: Array<{ datasetName:
//   string; summary: string }>; truncated: boolean }

// cognee.datasetsStatus@1 — input
{}                        // actor-scoped (service principal); no params
// cognee.datasetsStatus@1 — output
{ datasets: Array<{ name: string; datasetId: string; createdAt?: string }> }

// cognee.forgetDataset@1 — input
{ datasetName: string }
// cognee.forgetDataset@1 — output (receipt with verified limits, §7.5)
{ datasetName: string; purged: 'file-level'; verified: 'post-restart-observation';
  residueUnverified: ['os-file-recovery', 'concurrent-readers', 'backups'] }
```

## 7. Caller rules (normative)

### 7.1 Search candidates
Search outputs are ranked **candidates with raw cosine-distance scores
(lower = better)**. They are not answers and carry no relevance guarantee: C1
observed off-corpus queries surfacing irrelevant top hits at small corpus size.
Callers MUST treat hits as retrieval candidates for downstream judgment; the pack
adopts **no score threshold** (none was validated) and performs no post-hoc
filtering.

### 7.2 Write timeouts with unknown outcomes
- The Node-facing client enforces the attempt deadline (`CapabilityContext.deadlineAt`
  at the pack layer; a client-side deadline at the proof layer). If a **mutating** op
  (`add`, `cognify`, `forgetDataset`) does not complete by the deadline, the client
  reports **`COGNEE_WRITE_UNKNOWN`** carrying `{ datasetName, retryKey }` — the
  operation's **outcome is unknown** (it may have landed, may be mid-flight, or may
  not have started).
- The worker **never internally retries** a mutating op (C2: killed mid-add ⇒
  outcome unknown). On a mutating timeout the client considers the worker **poisoned**
  and kills + respawns it before serving the next request (single-owner store
  discipline; C2 fork/lock findings).
- `forgetDataset` has **no unknown-outcome retry path**: an interrupted forget MUST
  be reported `COGNEE_WRITE_UNKNOWN` and reconciled by observation only
  (`datasetsStatus` + scoped search); callers must NOT blindly re-issue.

### 7.3 Reconciliation
`retryKey` semantics: `add` keys on content hash; `cognify` keys on the canonical
dataset content-set hash. A caller may **re-issue the same logical write with the
same key**: a landed write deduplicates (`add` → `deduplicated: true`; `cognify` →
`alreadyUpToDate: true`), an unlanded write executes once. Re-issue with a *new*
key is a new logical write. Before re-issuing, callers SHOULD reconcile by
observation: `datasetsStatus` (existence) + scoped search (content presence).
C2 evidence: a SIGKILLed mid-add worker left the write **not** landed; keyed
re-issue is therefore both necessary and sufficient.

### 7.4 Missing datasets
Unknown or cross-namespace dataset names fail typed: `COGNEE_DATASET_UNKNOWN`
(worker-resolved, pre-call) for mutating ops; the same code maps Cognee's strict
`DatasetNotFoundError`/`NoDataError` on read paths. **No silent no-ops cross the
interface** (the Cognee `cognify` silent-no-op is neutralized by the precheck).

### 7.5 Dataset deletion's verified limits
`forgetDataset` receipts state exactly what was verified: **file-level physical
purge** of the dataset's graph/vector stores observed and re-verified after
restart (C2 battery_09); **unverified**: OS-level recovery of deleted files,
behavior under concurrent readers, backup/snapshot surfaces. There is **no
item-level deletion** in this release (C1 phantom-vector-residue finding stands).
Callers requiring stronger guarantees must implement them outside this pack.

## 8. Storage ownership and safety

- `cognee.systemRoot` MUST be a pack-owned, per-runtime directory. The worker
  resolves **all seven destructive roots** (system/data/cache/logs/repos +
  `vector_db_url` + `graph_file_path`) at startup and refuses to serve
  (`COGNEE_STORAGE_UNSAFE`, process exit 2) unless every root is strictly inside
  `cognee.systemRoot` — reuse of the committed fail-closed guard
  (`proof/guard_store_roots.py`). Uncertainty is a violation.
- Sharing one system root across runtimes/workspaces is forbidden (C1 finding #9:
  dotenv walk-up silently adopted a foreign store; the 6-chunk residue incident).
- The worker pins its own environment before importing Cognee:
  `VECTOR_DB_SUBPROCESS_ENABLED=false`, `GRAPH_DATABASE_SUBPROCESS_ENABLED=false`
  (killed workers otherwise orphan fork holders of ladybug locks — C2),
  `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `KUZU_BUFFER_POOL_SIZE=268435456`.

## 9. Worker lifecycle and resource limits

- **Shape:** supervised child process (Python) driven by the binding host (Node);
  NDJSON over stdin/stdout. **stdout carries protocol messages only** (≤ 1 MiB per
  line; oversized ⇒ connection aborted); **all diagnostics go to stderr** (worker
  logs, Cognee logs) and are never parsed by the client.
- **One op at a time** per worker; ops run in isolated asyncio tasks (C2 ContextVar
  persistence finding).
- **Startup:** guard (§8) → ready message with versions (cognee, python) → ready
  budget 120 s (observed 26–89 s on the RAM-constrained host).
- **Deadlines:** every op carries a client deadline; on expiry the client fails the
  op (`COGNEE_WRITE_UNKNOWN` for mutations / client timeout for reads) and applies
  the §7.2 poison-and-respawn policy for mutations.
- **Memory:** worker reports RSS per op (psutil); budget 2.5 GB (observed peak
  1.99 GB after cognify). Exceeding the budget ⇒ graceful restart after the op.
- **Shutdown:** `shutdown` op → graceful exit 0 (observed 3.8–15.2 s). Unsolicited
  worker death ⇒ `COGNEE_WORKER_UNAVAILABLE`; the client respawns before the next
  request; persistence across restarts is a demonstrated property (C2; re-proven in §11).

## 10. Version pins and compatibility requirements

| Component | Pin | Upgrade policy |
| --- | --- | --- |
| cognee | `==1.6.1` | exact pin; upgrades require a new contract revision + re-run of the full proof battery (C1–C3) |
| Python | `3.12.x` | minor-range pin |
| Node (binding host) | `>=22` | VICT runtime floor |
| Embeddings | fastembed `BAAI/bge-small-en-v1.5` (384d, local) | model change = data migration; new revision |
| Extraction | `gliner_demo` | no LLM key in this release |
| VICT | `victCompatibility: '^0.1.0'` (runtime compat version `0.1.0`) | re-validate on VICT compat bump |

Compatibility obligations: manifest schema `vict.capability-pack@1`; semver pack
version; writes keyed; effect vocabulary respected; contracts parse fail-closed;
permissions pre-checked; doubles registered for all mutating capabilities
(`modes: ['test','simulate']`, contract-valid outputs, no Cognee touch — reads
fail closed in simulate/test unless doubles are added later, per effect policy).

**Explicit exclusions (this release):** Cognee's direct BM25 retriever and
`set_database_global_context_variables` internal context API (C2 ambient-store and
cross-user-content hazards); item-level deletion; LLM completion searches; HTTP
transport; shared system roots; publishing a package; claiming consumer adoption.

## 11. Proof alignment (hardened disposable worker)

`worker/worker.py` (v2) + `worker/client.mjs` + `worker/proof_c3.mjs` implement the
Node-facing rules of this contract and demonstrate:

- stdout reserved for bounded NDJSON; stderr diagnostics (s1);
- unscoped / out-of-namespace / over-limit requests rejected typed
  (`COGNEE_SCOPE_REJECTED`, `COGNEE_PARAMS_REJECTED`) with no Cognee call (s3, s7);
- cross-namespace (cross-user-analogue) requests rejected at the interface (s3);
- delayed mutating write → deadline expiry → **`COGNEE_WRITE_UNKNOWN`**,
  worker poisoned + respawned, read-back reconciliation, keyed re-issue
  deduplicates (s4);
- `cognify` on a scoped-but-nonexistent dataset → `COGNEE_DATASET_UNKNOWN` (s5);
- restart persistence of previously written data (s6);
- scoped summary search across two namespaces returns only own-dataset data (s6);
- `forgetDataset` receipt + post-delete typed failure (s8); clean shutdown (s9).

Evidence: `worker/c3-results.json` (19/19 PASS), `worker/c3.log`. The worker
remains disposable proof code — it is not the pack implementation.

**Storage-name mapping (worker-implementation detail, observed):** cognee 1.6.1
rejects dots in dataset names (`check_dataset_name`). The interface address
`<ns>.<name>` is therefore mapped to the cognee storage name `<ns>__<name>` at
the worker boundary; the interface never exposes the storage name. Note for the
pack: Cognee's `DatasetNotFoundError` exists in two different modules
(`cognee.api.v1.exceptions` and `cognee.modules.data.exceptions`) — both must map
to `COGNEE_DATASET_UNKNOWN`, and the `NoDataError` raised when a dataset holds
items but an empty knowledge graph (interrupted cognify) maps there too.

## 12. Unresolved / deferred

1. Per-actor Cognee users (needs a VICT actor-identity contract).
2. `graphContext` scope story (deferred, §5).
3. Completion searches pending an LLM-key policy.
4. Relevance scoring/thresholds pending a validated evaluation set.
5. Doubles for read capabilities (simulate/test reads currently fail closed).
6. Concurrent ops per worker (single-op discipline is load-bearing for Cognee
   store locks on this host).
