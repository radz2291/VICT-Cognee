# C3 — VICT Cognee Pack Contract (first release, corrected)

Date: 2026-09-25 · Repo: radz2291/VICT-Cognee @ `9cc6ea5a2f85189e06f20abcab68a19480e2a4ba`
VICT ABI reference (read-only): radz2291/vict-02 @ **`5ea0afe257d5e7f67e050fcae169746a25fd3cc4`** (2026-09-25, "fix(stage8-p1)" — clean tree; only `.pi/` untracked, untouched). Quellight (`5f709a5…`) and Trading OS (`38f654e2…`) untouched. VICT Stage 8 untouched.

**Correction pass (this revision):** trust boundary tightened to one
runtime/worker/store per trust domain (§3); the namespace allowlist is
reclassified as a store-safety rail, not per-actor authorization; the VICT ABI
statement about writes is corrected against `pack.ts`/`runtime.ts` ground truth
(§1); write reconciliation is re-specified on the **actual VICT idempotencyKey**
with a durable proof implementation and item-level counts (§7.3);
`datasetsStatus` is scope-filtered and tested against pre-existing
out-of-domain datasets (§4, §11); declared output fields were verified against
what the worker actually produces (§6, §11).

This document defines the contract for a future `vict.cognee.memory` capability
pack **as a design deliverable only**. No package is published, no VICT code is
modified, and no consumer adoption is claimed. The disposable proof in `worker/`
is aligned to this contract (§11) but remains proof code.

---

## 1. ABI ground truth (what VICT actually enforces)

Verified against the reference sources at the commit above:

| ABI fact | Source |
| --- | --- |
| Manifest schema `vict.capability-pack@1`; fields `id`, `version` (semver), `victCompatibility`, `capabilities[]`, `contracts[]`, `permissions[]`, `configuration[]`, `secrets[]`, `doubles[]`, `evaluations[]`, `documentation`, `provenance` | `packages/sdk/src/pack.ts` (manifest interfaces; `PACK_INVALID_*` diagnostics) |
| Effect vocabulary is closed: `pure \| read \| write \| irreversible` | `pack.ts:288` (`EFFECT_CLASSES`), `packages/sdk/src/capability.ts` (`EffectClass`) |
| **Corrected write rule:** a `write` capability MUST declare **`idempotency: 'keyed'`** **or** `ambiguity: 'block'` — a write with neither is rejected (`PACK_AMBIGUITY_NOT_DECLARED`). The ambiguity vocabulary is exactly `'block' \| 'keyedRetry'` (`PackAmbiguityPolicy`). `keyedRetry` is the natural declaration for keyed writes; `block` means the capability is never replayed | `pack.ts:31` (`PackAmbiguityPolicy`), `pack.ts:731–735` |
| **The runtime derives a deterministic idempotencyKey** per logical invocation: `idem_<sha256(canonical{runId, activationVersion, lineage, nodeId, invocationId, schema:'vict.idempotency-key@1'}).slice(0,32)>`; `invocationId` is invariant across retries and restarts, so retries and post-restart replays re-invoke the handler with the **same key** | `packages/runtime/src/orchestration-activation.ts:226–242` (`deriveIdempotencyKey`), `runtime.ts:624` |
| **The kernel blocks replay of unkeyed writes**: a write attempt whose `idempotencyKey` is `null` returns `action: 'block'` — "A write capability without keyed idempotency has an unknown outcome after process loss; it is never replayed" | `packages/runtime/src/runtime.ts:392–400` |
| Permissions are enforced BEFORE the handler: an ungranted permission fails invocation with a structured error; "the handler was not invoked" | `packages/runtime/src/authority.ts:220` |
| `irreversible` is denied by default in normal mode (needs explicit `allowIrreversible`); in `simulate`/`test` modes real read/write/irreversible implementations are unreachable — a registered double is required, otherwise the request fails closed | `packages/runtime/src/effect-policy.ts` |
| `victCompatibility` is checked against the runtime compat version — currently `'0.1.0'` (`VICT_RUNTIME_COMPAT_VERSION`); example packs declare `'^0.1.0'` | `packages/runtime/src/pack-install.ts:38,54`; `pack.ts:424,457` |
| Contracts are executable parse promises: `{ ok: true, value } \| { ok: false, issues[] }`; contract rejection surfaces as `VICT_KERNEL_CONTRACT_REJECTED` | `packages/contracts/src/define-contract.ts`; `packages/kernel/src/errors.ts` |
| Capability context carries `mode`, `attemptNumber?`, `idempotencyKey?`, `deadlineAt` (epoch-ms attempt deadline), `abortSignal`, and SCOPED config/secret readers (undeclared names unavailable) | `packages/sdk/src/capability.ts:37–51` (`CapabilityContext`) |
| Doubles are declared `{ capabilityId, modes: ['test','simulate'], revision }`; contracts of the original still apply to doubles | `pack.ts`; `capability.ts` (`DoubleInvoke`) |
| Reference write pattern (ledger pack): `effect:'write'`, `idempotency:'keyed'`, `ambiguity:'keyedRetry'`, permissions, required configuration, secrets, evaluations | `docs/builder-kit/capability-catalog.json` (`vict.example.ledger`) |

**Consequences for this pack:** every mutating capability declares
`idempotency: 'keyed'` **and** `ambiguity: 'keyedRetry'` with the reconciliation
semantics of §7.3; scope and authorization rails are enforced by the pack BEFORE
any Cognee call (mirroring VICT's pre-handler enforcement);
`victCompatibility: '^0.1.0'`.

## 2. Pack identity

- **Pack id:** `vict.cognee.memory` · **Version:** `0.1.0` (first release)
- **`victCompatibility`:** `'^0.1.0'`
- **Manifest schema:** `vict.capability-pack@1`; bindings separate (handlers never serialized)
- **Secrets: none.** First release is keyless (local fastembed embeddings, `gliner_demo`
  extraction, no LLM). A completion/LLM capability is out of scope (§12).
- **Configuration (required):**
  - `cognee.systemRoot` — absolute path of a **pack-owned** Cognee `SYSTEM_ROOT_DIRECTORY`
    (one per runtime/trust domain; never shared across runtimes or workspaces; §3/§8).
  - `cognee.allowedNamespaces` — comma-separated dataset namespace prefixes this
    runtime may address (e.g. `quellight,trading`). Drives the interface safety
    rails (§4) and the `datasetsStatus` filter (§4, §6).

## 3. Trust boundary (corrected)

VICT's `CapabilityContext` exposes run/graph/node identity but **no end-user
identity**, and no other trusted per-actor scope mechanism is demonstrated
today. Therefore:

**First-release rule: one VICT runtime, one worker, one Cognee store per trust
domain.**
- The pack binding host provisions exactly one Cognee service principal and one
  pack-owned system root **per VICT runtime**; sharing a store across runtimes,
  workspaces, or trust domains is forbidden (§8).
- All datasets are owned by that service principal. Cross-**Cognee-user**
  isolation is not relied upon in this release.
- **Actor isolation is NOT claimed.** The mandatory dataset namespaces
  (`<ns>.<name>`, from `cognee.allowedNamespaces`) are a **store-safety rail**
  preventing this runtime from addressing datasets outside its granted domain —
  including datasets that pre-exist in the store. They are **not** per-actor
  authorization: VICT currently gives the pack no per-actor identity, so no
  per-actor claim is made anywhere in this contract.
- If a second trust domain appears (another runtime), it gets its own worker,
  service principal, and store. It does not get a namespace in this store.
- Per-actor Cognee users remain a documented future option when VICT passes an
  actor identity in context (deferred; requires a VICT-side identity contract).

## 4. Scope discipline (mandatory, interface-enforced)

- Every request MUST carry an explicit dataset address: `datasetName` (singular ops)
  or `datasets` (search ops). **Unscoped requests are rejected** with
  `COGNEE_SCOPE_REJECTED` before any Cognee call.
- Every dataset name MUST match `^(<allowed-ns>)\.[^.\s]+$` for one of the
  configured namespaces. Names outside the granted namespaces are rejected with
  `COGNEE_SCOPE_REJECTED` — **store-safety rail, not per-actor authorization** (§3).
- **`datasetsStatus` is scope-filtered:** it lists only datasets whose interface
  address maps to a granted namespace. Datasets with no namespace or with a
  non-granted namespace are **never revealed** — not by name, not by id. The
  response carries only a count of hidden datasets (`hiddenDatasets`, count
  only, no identity). This is proven in the C3 proof against datasets that
  pre-exist in the store and are out of domain (`legacy_unscoped`,
  `outside.vault` — seeded before the scoped worker starts): they must not
  appear in any listing, and addressing them fails `COGNEE_SCOPE_REJECTED`.
- Search `topK` MUST be an integer in `1..25` (`COGNEE_PARAMS_REJECTED` otherwise);
  responses are bounded (§11): hits are truncated with `truncated: true` rather
  than growing unbounded.
- The worker additionally validates dataset existence for mutating ops (Cognee
  1.6.1 `cognify` on a nonexistent dataset is a **silent no-op** — C2 finding):
  `cognify` first resolves the dataset and fails `COGNEE_DATASET_UNKNOWN` if
  absent (precheck runs BEFORE any journal state is written).

## 5. Capability decisions (the seven C2 candidates)

| C2 candidate | Decision | Effect / permission / ambiguity | Why defensible |
| --- | --- | --- | --- |
| add | **RETAIN** `cognee.add@1` | `write`, keyed, `ambiguity:'keyedRetry'`; `cognee.write` | Content-hash dedupe (C1: same content does not duplicate); durable keyed reconciliation proven with item-level counts (§7.3, §11); mandatory scope |
| cognify | **RETAIN** `cognee.cognify@1` | `write`, keyed, `ambiguity:'keyedRetry'`; `cognee.write` | Durable keyed journal (§7.3); interrupted cognify re-executes and converges (proven searchable after interruption, §11); silent-no-op neutralized by existence precheck (§4) |
| chunk search | **RETAIN** `cognee.searchChunks@1` | `read`; `cognee.search` | Store-level dataset scoping proven (C2 battery_08); cosine-distance score exposed with **lower = better**; results are **candidates only** (§7.1) |
| summary search | **RETAIN** `cognee.searchSummaries@1` | `read`; `cognee.search` | Same search pipeline and strict dataset resolution; scope + isolation re-verified in the C3 fresh-store proof with **both sides populated** (§11) |
| graph context | **DEFER** (not in first release) | — | Dataset-scope enforcement for raw graph access was not demonstrated (C1 observed it only unscoped). Per the C2 lexical precedent: no capability without a proven scope story. Revisit post-release |
| dataset status/list | **RETAIN** `cognee.datasetsStatus@1` (scope-filtered) | `read` | Lists only datasets within the granted namespaces (§4); needed for reconciliation (§7.3) and existence prechecks; hiding of pre-existing out-of-domain datasets proven (§11) |
| dataset forget | **RETAIN** `cognee.forgetDataset@1` | **`irreversible`**; `cognee.delete` + runtime `allowIrreversible`; **no replay, no auto-retry** | File-level purge verified after restart (C2 battery_09); `irreversible` means VICT denies it by default in normal mode and never runs the real implementation in simulate/test — matching the verified-limits posture (§7.5). Interrupted forget = unknown outcome, reconciled by observation only (§7.2) |

**First-release surface: six capabilities.** Nothing else (no completion searches,
no item deletion, no direct retrievers — §12).

## 6. Typed inputs and outputs (verified against worker output)

Contracts are `defineContract` parse promises (fail-closed); shapes below are
the authoritative `expected` strings **and have been verified against actual
worker output** (§11, `c3-results.json` hitFields/details). All inputs/outputs
are JSON-serializable; every output repeats `datasetName`.

```ts
// cognee.add@1 — input
{ datasetName: string;      // ^<ns>\.[^.\s]+$ , ns ∈ allowedNamespaces
  content: string;          // UTF-8 text, 1..512_000 chars
  idempotencyKey: string }  // CapabilityContext.idempotencyKey (VICT-derived)
// cognee.add@1 — output (durable reconciliation receipt, §7.3)
{ datasetName: string; idempotencyKey: string;
  reconciled: 'fresh-execution' | 'replayed-known-outcome' |
              'reissued-after-interruption';
  itemsBefore: number; itemsAfter: number;  // data-item counts (registry)
  deduplicated: boolean }                   // itemsAfter === itemsBefore

// cognee.cognify@1 — input
{ datasetName: string; idempotencyKey: string }
// cognee.cognify@1 — output (same receipt shape as add; item counts refer to
// data items, which cognify does not change — the graph converges)

// cognee.searchChunks@1 — input
{ datasets: string[];       // 1..8 entries, each §4-valid
  query: string;            // 1..2_000 chars
  topK?: number }           // 1..25, default 5
// cognee.searchChunks@1 — output (CANDIDATES, not answers)
{ hits: Array<{ text: string; score: number;      // raw cosine distance,
               datasetName?: string }>;           // LOWER = BETTER; datasetName
                                                  // present ONLY for
                                                  // single-dataset queries
  datasets: string[]; total: number; truncated: boolean }

// cognee.searchSummaries@1 — input identical to searchChunks
// output: { hits: Array<{ text: string; score: number; datasetName?: string }>;
//   datasets: string[]; total: number; truncated: boolean }

// cognee.datasetsStatus@1 — input
{}                          // store-scoped (§3/§4); no params
// cognee.datasetsStatus@1 — output (scope-filtered)
{ datasets: Array<{ name: string }>;      // only <granted-ns>.<name> entries
  hiddenDatasets: number;                 // count of hidden rows (names NEVER)
  namespaces: string[] }

// cognee.forgetDataset@1 — input
{ datasetName: string }
// cognee.forgetDataset@1 — output (receipt with verified limits, §7.5)
{ datasetName: string; datasetId: string;
  purged: 'file-level' | 'not-observed';
  storeFilesBefore: number; storeFilesAfter: number }
```

Notes (worker-implementation reality, observed):
- Cognee 1.6.1 forbids dots in dataset names; the interface address
  `<ns>.<name>` maps to the storage name `<ns>__<name>` at the worker boundary.
  The interface never exposes storage names.
- Chunk/summary hits expose exactly `{ text, score[, datasetName] }`. Cognee
  results do not carry per-hit dataset identity for multi-dataset searches, so
  `datasetName` is only attached when a single dataset is queried; consumers
  needing per-hit provenance must issue single-dataset searches.
- `add` does not surface a stable document id; the receipt uses item counts
  instead of a `documentId`.
- Cognee raises the not-found pair from two different modules
  (`cognee.api.v1.exceptions` and `cognee.modules.data.exceptions`) — both, and
  `NoDataError` (items present but graph empty, i.e. an interrupted cognify),
  map to `COGNEE_DATASET_UNKNOWN`.

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
  reports **`COGNEE_WRITE_UNKNOWN`** carrying `{ datasetName, idempotencyKey }` — the
  operation's **outcome is unknown** (it may have landed, may be mid-flight, or may
  not have started).
- **Every worker death with a pending mutation is an unknown outcome** —
  regardless of cause (kill, crash, segfault, host loss). There is no window in
  which the client may assume the mutation did not happen.
- The worker **never internally retries** a mutating op. On a mutating timeout the
  client considers the worker **poisoned** and kills + respawns it before serving
  the next request (single-owner store discipline; C2 fork/lock findings).
- `forgetDataset` has **no unknown-outcome retry path** and is **never journaled**:
  an interrupted forget MUST be reported `COGNEE_WRITE_UNKNOWN` and reconciled by
  observation only (`datasetsStatus` + scoped search); callers must NOT blindly
  re-issue. VICT's kernel likewise blocks unkeyed replay (§1); forget is
  `irreversible`, never `keyedRetry`.

### 7.3 Reconciliation (durable, keyed — implemented and proven)
VICT derives `idempotencyKey` deterministically per **logical invocation** and
re-invokes the handler with the **same key** after retries and process loss
(§1). The pack therefore implements durable keyed reconciliation **on that
key**:

- **Durable journal.** For every `add`/`cognify` the pack appends a `begun`
  record `{key, op, dataset, items_before, started_at}` and, after completion, a
  `completed` record `{..., items_after, duration_ms}` to a journal inside the
  guarded system root (fsync per record). The journal is the pack-side twin of
  VICT's keyed replay: it survives worker death by construction.
- **Reissue rules** (same key):
  1. `completed` record exists → the logical write durably completed:
     **replay the recorded outcome without re-execution**
     (`reconciled: 'replayed-known-outcome'`).
  2. `begun` without `completed` → the previous attempt did **not** durably
     complete; outcome unknown. The pack **re-executes the operation**
     (`reconciled: 'reissued-after-interruption'`) — convergent by construction:
     `add` converges via Cognee content-hash dedupe; `cognify` converges via
     pipeline re-run (both proven in §11 with item-level counts).
  3. No record → fresh execution (`reconciled: 'fresh-execution'`).
- **Item-level counts.** Every mutating receipt carries `itemsBefore` /
  `itemsAfter` from the Cognee registry. The proof demonstrates: fresh add
  0→1; interrupted add reissue 0→1 with **no duplicate item** (count stays 1);
  interrupted cognify reissue converges (count unchanged 1→1, graph searchable
  afterwards — 3 scoped hits). Callers reconcile interrupted writes by re-issue
  with the SAME key and read the counts from the receipt.
- **`add` idempotency detail:** the interrupted attempt may have landed
  partially or fully; the re-executed add deduplicates by content hash, so the
  item count never grows beyond the logical dataset content (proven).
- **No automatic replay outside §7.3.** The worker never retries mutations on
  its own; only the caller's keyed re-issue triggers reconciliation, and
  `forgetDataset` (§7.2) has no re-issue path at all.
- **Proof-layer honesty.** The reconciliation journal is implemented and
  exercised in the disposable worker proof (fsynced records verified on disk,
  including a `begun`-without-`completed` record for each interrupted attempt).
  The production pack MUST carry an equivalent durable journal; a pack build
  that cannot demonstrate it must instead declare `ambiguity: 'block'` and
  prohibit replay entirely.

### 7.4 Missing datasets
Unknown or out-of-domain dataset names fail typed: `COGNEE_SCOPE_REJECTED`
(interface, before any Cognee call) or `COGNEE_DATASET_UNKNOWN`
(worker-resolved, pre-call) for mutating ops; the same code maps Cognee's strict
`DatasetNotFoundError`/`NoDataError` on read paths. **No silent no-ops cross the
interface** (the Cognee `cognify` silent-no-op is neutralized by the precheck).

### 7.5 Dataset deletion's verified limits
`forgetDataset` receipts state exactly what was verified: **file-level physical
purge** of the dataset's graph/vector stores observed and re-verified after
restart (C2 battery_09; re-proven in the C3 fresh-store run, files 2→0);
**unverified**: OS-level recovery of deleted files, behavior under concurrent
readers, backup/snapshot surfaces. There is **no item-level deletion** in this
release (C1 phantom-vector-residue finding stands). Callers requiring stronger
guarantees must implement them outside this pack.

## 8. Storage ownership and safety

- `cognee.systemRoot` MUST be a pack-owned, per-runtime directory **(§3: one
  store per trust domain)**. The worker resolves **all seven destructive roots**
  (system/data/cache/logs/repos + `vector_db_url` + `graph_file_path`) at
  startup and refuses to serve (process exit 2) unless every root is strictly
  inside the runtime's store boundary — reuse of the committed fail-closed guard
  (`proof/guard_store_roots.py`) with the runtime store as the containment
  boundary. Uncertainty is a violation.
- **Dotenv discipline (C1 finding #9, re-confirmed and hardened in C3):**
  Cognee's own `dotenv.load_dotenv(override=True)` walks up from site-packages
  and clobbers process env — in the proof the worker neutralizes that walk-up
  and loads its store's `.env` explicitly, anchored to its own working
  directory. A pack binding must replicate this: store selection must NEVER be
  left to dotenv walk-up.
- Sharing one system root across runtimes/workspaces/trust domains is forbidden.
- The worker pins its own environment before importing Cognee:
  `VECTOR_DB_SUBPROCESS_ENABLED=false`, `GRAPH_DATABASE_SUBPROCESS_ENABLED=false`
  (killed workers otherwise orphan fork holders of ladybug locks — C2),
  `OMP_NUM_THREADS=1`, `MKL_NUM_THREADS=1`, `KUZU_BUFFER_POOL_SIZE=268435456`.
- The idempotency journal (§7.3) lives inside the guarded system root.

## 9. Worker lifecycle and resource limits

- **Shape:** supervised child process (Python) driven by the binding host (Node);
  NDJSON over stdin/stdout. **stdout carries protocol messages only** (≤ 1 MiB per
  line; oversized ⇒ connection aborted); **all diagnostics go to stderr** (worker
  logs, Cognee logs) and are never parsed by the client.
- **One op at a time** per worker; ops run in isolated asyncio tasks (C2 ContextVar
  persistence finding). One worker per store per trust domain (§3).
- **Startup:** guard (§8) → ready message with versions (cognee, python) and the
  verified store boundary → ready budget 120–180 s (observed 10–36 s in the C3
  fresh-store runs on the RAM-constrained host).
- **Deadlines:** every op carries a client deadline; on expiry the client fails the
  op (`COGNEE_WRITE_UNKNOWN` for mutations / client timeout for reads) and applies
  the §7.2 poison-and-respawn policy for mutations.
- **Memory:** worker reports RSS per op (psutil); budget 2.5 GB (observed peak
  ~2.0 GB after cognify). Exceeding the budget ⇒ graceful restart after the op.
- **Shutdown:** `shutdown` op → graceful exit 0 (observed ~0.5 s in C3).
  Unsolicited worker death ⇒ `COGNEE_WORKER_UNAVAILABLE`; the client respawns
  before the next request; persistence across restarts is a demonstrated
  property (C2; re-proven in the C3 fresh-store run), and pending-mutation
  deaths are unknown outcomes reconciled per §7.2/§7.3.

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
version; writes keyed with `ambiguity:'keyedRetry'` (§7.3) — or `'block'` if the
durable journal cannot be demonstrated; effect vocabulary respected; contracts
parse fail-closed; permissions pre-checked; doubles registered for all mutating
capabilities (`modes: ['test','simulate']`, contract-valid outputs, no Cognee
touch — reads fail closed in simulate/test unless doubles are added later, per
effect policy).

**Explicit exclusions (this release):** Cognee's direct BM25 retriever and
`set_database_global_context_variables` internal context API (C2 ambient-store and
cross-user-content hazards); item-level deletion; LLM completion searches; HTTP
transport; shared system roots; publishing a package; claiming consumer adoption.

## 11. Proof alignment (hardened disposable worker, fresh store)

`worker/worker.py` (v3) + `worker/client.mjs` + `worker/proof_c3.mjs` +
`proof/c3_seed_foreign.py` implement the Node-facing rules of this contract.
**Every proof run builds a FRESH disposable store** (`proof/.cognee-c3`, own
`.env`, own journal, guard boundary = that store) — one worker, one store, one
trust domain per run (§3). Demonstrated (26/26 PASS, 300 s, fresh store):

- stdout reserved for bounded NDJSON; stderr diagnostics (s1); guard verifies
  roots inside the FRESH store boundary specifically (s1);
- unscoped / out-of-namespace / over-limit / **unkeyed-write** requests rejected
  typed (`COGNEE_SCOPE_REJECTED`, `COGNEE_PARAMS_REJECTED`) with no Cognee call
  (s3, s7);
- **`datasetsStatus` scope filtering**: pre-existing out-of-domain datasets
  (`legacy_unscoped`, `outside.vault` — seeded in the same store before the
  scoped worker starts) are never listed (counted in `hiddenDatasets` only) and
  addressing them is rejected (s3);
- **durable keyed reconciliation** (s2, s4):
  fresh add 0→1 → same key replays the known outcome in ~10 ms without
  re-execution; a ~494 KB add interrupted at a 400 ms deadline →
  `COGNEE_WRITE_UNKNOWN` → worker killed + respawned → keyed re-issue
  re-executes convergently (`reissued-after-interruption`, items 0→1, **no
  duplicate**) → further re-issue replays; a real cognify interrupted at a 4 s
  deadline → unknown → keyed re-issue re-executes (~175 s) and the graph is
  searchable afterwards (3 scoped hits). The fsynced journal records the
  `begun`/`completed` pairs for every mutating op, including the interruption
  evidence (verified on disk, §7.3);
- `cognify` on a scoped-but-nonexistent dataset → `COGNEE_DATASET_UNKNOWN`,
  with no journal record created (s5);
- restart persistence of previously written data (s6);
- scoped summary search with **BOTH sides populated** (qa_total = 1,
  zeta_total = 1) and zero cross-namespace leaks (s6);
- **declared output fields verified against actual output**: chunk hits carry
  exactly `{ text, score, datasetName }` (datasetName only for single-dataset
  queries), summaries likewise; `datasetsStatus` carries
  `{ datasets[{name}], hiddenDatasets, namespaces }` (s2, s6);
- `forgetDataset` receipt (purged `file-level`, store files 2→0) + post-delete
  typed failure (s8); clean shutdown (s9).

Evidence: `worker/c3-results.json` (26/26 PASS, fresh store), `worker/c3.log`,
journal on disk at `proof/.cognee-c3/system/c3_idempotency_journal.jsonl`. The
worker remains disposable proof code — it is not the pack implementation.

**Remaining limits (plainly):**
- The keyed-reconciliation journal is proven at the proof layer only; the
  production pack must re-implement it (a pack without it MUST declare
  `ambiguity: 'block'`, §7.3).
- Cognify reissue convergence is proven observably (dataset searchable, item
  counts stable), not at graph-diff granularity: partial graph states from an
  interrupted cognify are not inspected directly.
- `add` convergence relies on Cognee's content-hash dedupe; dedupe behavior
  across *different* content that maps to the same logical dataset is not
  exhausted (re-issue of *changed* content with the same key is a caller error
  and is not detected — the key is the logical-write identity).
- `replayed-known-outcome` replays trust the journal's record; the journal is
  fsynced but OS-crash durability of the underlying filesystem (beyond
  `fsync`) is unverified.
- Worker crashes (`0xC0000005`) under low free RAM remain an environment class
  (C1); the driver records them as AGENT-OBSERVATIONs and they did not occur in
  the final fresh-store run.
- Deletion limits stand as in §7.5 (no OS-recovery / concurrent-reader / backup
  verification).

**Storage-name mapping (worker-implementation detail, observed):** cognee 1.6.1
rejects dots in dataset names (`check_dataset_name`). The interface address
`<ns>.<name>` is mapped to the cognee storage name `<ns>__<name>` at
the worker boundary; the interface never exposes the storage name.

## 12. Unresolved / deferred

1. Per-actor Cognee users (needs a VICT actor-identity contract; until then
   §3's one-store-per-trust-domain rule is the whole isolation story).
2. `graphContext` scope story (deferred, §5).
3. Completion searches pending an LLM-key policy.
4. Relevance scoring/thresholds pending a validated evaluation set.
5. Doubles for read capabilities (simulate/test reads currently fail closed).
6. Concurrent ops per worker (single-op discipline is load-bearing for Cognee
   store locks on this host).
7. Production-grade durability of the reconciliation journal (OS-crash
   semantics beyond `fsync`; journal compaction/rotation).