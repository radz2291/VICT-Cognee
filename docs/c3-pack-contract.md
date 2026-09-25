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

**C4 corrections (current revision):** the retry key comes **exclusively from
`CapabilityContext.idempotencyKey`** — the durable driver derives it only when
the graph node declares a retry policy, and the sequential engine never
supplies one, so an unkeyed write invocation is refused by the binding (§1,
§7.3); every journal key is **bound to (operation, dataset, input
fingerprint)** and mismatched reuse is rejected `COGNEE_IDEMPOTENCY_MISMATCH`
(§7.3); **any worker exit during a pending mutation** (crash, kill, fault,
anything) is mapped to `COGNEE_WRITE_UNKNOWN` by the client (§7.2); the
**crash window** between Cognee's write and the journal commit is tested with
a forced crash for both add and cognify, proving item-level convergence (no
duplicate) and graph-level convergence (dataset searchable after reissue)
(§7.3, §11); VICT's key-uniqueness assumptions are verified and recorded
(§7.3).

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
| **The runtime derives a deterministic idempotencyKey** per logical invocation: `idem_<sha256(canonical{runId, activationVersion, lineage, nodeId, invocationId, schema:'vict.idempotency-key@1'}).slice(0,32)>`; `invocationId` is invariant across retries and restarts, so retries and post-restart replays re-invoke the handler with the **same key**. **C4 verification: the key is derived ONLY when the graph node declares a retry policy** (`node?.retry !== undefined`; `orchestration-driver.ts:403–412`) — a write node without a retry policy gets `idempotencyKey: null` and is never replayed; and the **sequential engine (capability-only graphs) never supplies a key at all** (`kernel/src/execute.ts:323–336` builds the invocation context without `DurableInvocationContext`) | `packages/runtime/src/orchestration-activation.ts:226–242` (`deriveIdempotencyKey`), `runtime.ts:624`, `orchestration-driver.ts:403–412`, `kernel/src/execute.ts:323–336` |
| **The kernel blocks replay of unkeyed writes**: a write attempt whose `idempotencyKey` is `null` returns `action: 'block'` — "A write capability without keyed idempotency has an unknown outcome after process loss; it is never replayed" | `packages/runtime/src/runtime.ts:392–400` |
| Permissions are enforced BEFORE the handler: an ungranted permission fails invocation with a structured error; "the handler was not invoked" | `packages/runtime/src/authority.ts:220` |
| `irreversible` is denied by default in normal mode (needs explicit `allowIrreversible`); in `simulate`/`test` modes real read/write/irreversible implementations are unreachable — a registered double is required, otherwise the request fails closed | `packages/runtime/src/effect-policy.ts` |
| `victCompatibility` is checked against the runtime compat version — currently `'0.1.0'` (`VICT_RUNTIME_COMPAT_VERSION`); example packs declare `'^0.1.0'` | `packages/runtime/src/pack-install.ts:38,54`; `pack.ts:424,457` |
| Contracts are executable parse promises: `{ ok: true, value } \| { ok: false, issues[] }`; contract rejection surfaces as `VICT_KERNEL_CONTRACT_REJECTED`; **every executable capability must declare BOTH an input and an output contract** (CONT-001 — `datasetsStatus` therefore carries an explicitly empty input contract) | `packages/contracts/src/define-contract.ts`; `packages/kernel/src/errors.ts`; pack-install validation | 
| **Graph-engine selection (C4 implementation finding):** a graph compiles to `vict.activation@2` (durable orchestration engine) when ANY node declares `retry` or `timeoutMs`, any node has a control `kind` (decision/fork/join/wait), or any edge is a non-success kind (route/branch/timeout/error) — `declaresControlSemantics`, `canonical.ts:185-201`. Clean capability-only graphs compile to `vict.activation@1` (sequential engine) | `packages/kernel/src/canonical.ts:185-201`, `compile.ts:1189`, `runtime.ts:869` |
| **Mode isolation is sequential-engine-only:** the durable orchestration engine ALWAYS invokes the pinned real binding — in `test`/`simulate` its `useDouble` decision is deliberately ignored ("Doubles are a Stage 02 sequential-engine facility", `orchestration-driver.ts` ~700). Durable graphs therefore touch the REAL worker/store in every mode; only the irreversible denial (`decision.allowed`) is enforced there | `packages/runtime/src/orchestration-driver.ts`, `effect-policy.ts` |
| **Edge contract compatibility is exact-id** (or the special `vict.neutral.json` contract): two adjacent nodes' contracts are statically compatible only when their contract IDs are equal or one side is `vict.neutral.json` — graph authors bridge differing contracts through explicit pure adapter nodes | `packages/runtime/src/registry.ts:580-588`, `kernel/src/compile.ts:980-1005` |
| Capability context carries `mode`, `attemptNumber?`, `idempotencyKey?`, `deadlineAt` (epoch-ms attempt deadline), `abortSignal`, and SCOPED config/secret readers (undeclared names unavailable) | `packages/sdk/src/capability.ts:37–51` (`CapabilityContext`) |
| Doubles are declared `{ capabilityId, modes: ['test','simulate'], revision }`; contracts of the original still apply to doubles | `pack.ts`; `capability.ts` (`DoubleInvoke`) |
| Reference write pattern (ledger pack): `effect:'write'`, `idempotency:'keyed'`, `ambiguity:'keyedRetry'`, permissions, required configuration, secrets, evaluations | `docs/builder-kit/capability-catalog.json` (`vict.example.ledger`) |

**Consequences for this pack:** every mutating capability declares
`idempotency: 'keyed'` **and** `ambiguity: 'keyedRetry'` with the reconciliation
semantics of §7.3; **graph nodes that invoke cognee write capabilities MUST
declare a retry policy** (otherwise the runtime derives no key and the binding
refuses the write — §7.3); invoking cognee writes through the sequential
engine (capability-only graphs) is refused for the same reason; scope and
authorization rails are enforced by the pack BEFORE any Cognee call (mirroring
VICT's pre-handler enforcement); `victCompatibility: '^0.1.0'`.

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
// cognee.add@1 — input (NO idempotencyKey here: the retry key comes
// exclusively from CapabilityContext.idempotencyKey via the invocation ctx)
{ datasetName: string;      // ^<ns>\.[^.\s]+$ , ns ∈ allowedNamespaces
  content: string }         // UTF-8 text, 1..512_000 chars
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

// cognee.datasetsStatus@1 — input (CONT-001: an explicitly empty contract)
{}                          // store-scoped (§3/§4); no params; non-object payloads rejected
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
- **Graph composition rule (VICT edge-compat):** differing contract ids across
  an edge are statically incompatible unless bridged by `vict.neutral.json` —
  callers compose cognee capabilities through explicit pure adapter nodes
  (verified in the C4 runtime run; see §11).

## 7. Caller rules (normative)

### 7.1 Search candidates
Search outputs are ranked **candidates with raw cosine-distance scores
(lower = better)**. They are not answers and carry no relevance guarantee: C1
observed off-corpus queries surfacing irrelevant top hits at small corpus size.
Callers MUST treat hits as retrieval candidates for downstream judgment; the pack
adopts **no score threshold** (none was validated) and performs no post-hoc
filtering.

### 7.2 Write timeouts and worker exits with unknown outcomes
- The Node-facing client enforces the attempt deadline (`CapabilityContext.deadlineAt`
  at the pack layer; a client-side deadline at the proof layer). If a **mutating** op
  (`add`, `cognify`, `forgetDataset`) does not complete by the deadline, the client
  reports **`COGNEE_WRITE_UNKNOWN`** carrying `{ datasetName, idempotencyKey }` — the
  operation's **outcome is unknown** (it may have landed, may be mid-flight, or may
  not have started).
- **Every worker exit while a mutation is pending is an unknown outcome** —
  regardless of cause: crash, kill, segfault, host loss, graceful-shutdown race,
  forced fault injection. The client maps **any** in-flight mutation at worker
  exit to `COGNEE_WRITE_UNKNOWN` (proven with a forced `os._exit(2)` after the
  Cognee write, §11). There is no window in which the client may assume the
  mutation did not happen.
- The worker **never internally retries** a mutating op. On a mutating timeout
  or mutating-op worker exit the client considers the worker **poisoned** and
  kills + respawns it before serving the next request (single-owner store
  discipline; C2 fork/lock findings).
- **One live worker per store at all times** (§3): a second concurrent worker
  cannot open the graph store while the first holds the ladybug lock (C4
  observed `Could not set lock on file` when a second worker ran a cognify
  alongside a live first worker). Supervision MUST park or kill the incumbent
  before another worker touches the store.
- `forgetDataset` has **no unknown-outcome retry path** and is **never journaled**:
  an interrupted forget MUST be reported `COGNEE_WRITE_UNKNOWN` and reconciled by
  observation only (`datasetsStatus` + scoped search); callers must NOT blindly
  re-issue. VICT's kernel likewise blocks unkeyed replay (§1); forget is
  `irreversible`, never `keyedRetry`.

### 7.3 Reconciliation (durable, keyed — implemented and proven)
VICT derives `idempotencyKey` deterministically per **logical invocation** and
re-invokes the handler with the **same key** after retries and process loss
(§1). The pack therefore implements durable keyed reconciliation **on that
key**, under the following rules (C4):

- **Key source — exclusively `CapabilityContext.idempotencyKey`.** The handler
  reads the key ONLY from the invocation context. A key supplied through input
  params is rejected `COGNEE_PARAMS_REJECTED` (proven). A mutating invocation
  whose context carries no key (sequential engine; write node without a retry
  policy) is rejected `COGNEE_PARAMS_REJECTED` — it can never be safely
  replayed, so it must not run.
- **Key-uniqueness assumptions (verified against VICT source).** The key is
  `sha256{runId, activationVersion, lineage, nodeId, invocationId}` (truncated,
  schema-tagged). Two distinct logical invocations collide only if runId,
  activationVersion, token lineage, nodeId, and invocationId ALL match — i.e.
  the same node, same token lineage, same run. Uniqueness therefore rests on
  (a) run-id uniqueness (runtime-injected id generator; a harness with
  deterministic ids can deliberately reproduce keys — VICT's own proofs do),
  and (b) lineage uniqueness within a run (kernel token state machine). The
  pack additionally binds keys to logical work (below), so a colliding reuse
  of a key for DIFFERENT work fails closed rather than silently replaying.
- **Durable journal with binding.** For every `add`/`cognify` the pack appends
  a `begun` record `{key, op, dataset, fingerprint, items_before, started_at}`
  and, after completion, a `completed` record `{..., items_after, ...}` to a
  journal inside the guarded system root (fsync per record). `fingerprint` is
  `sha256(canonical{op, dataset, content})` for add and
  `sha256(canonical{op, dataset})` for cognify. **Each key is durably bound to
  (operation, dataset, fingerprint)**: a request reusing a key with a different
  binding is rejected **`COGNEE_IDEMPOTENCY_MISMATCH`** before any Cognee call
  and without touching journal state (proven for all three mismatch axes:
  content, dataset, operation).
- **Reissue rules** (same key, matching binding):
  1. `completed` record exists → the logical write durably completed:
     **replay the recorded outcome without re-execution**
     (`reconciled: 'replayed-known-outcome'`).
  2. `begun` without `completed` → the previous attempt did **not** durably
     complete; outcome unknown. The pack **re-executes the operation**
     (`reconciled: 'reissued-after-interruption'`) — convergent by construction
     and proven under the exact crash window below.
  3. No record → fresh execution (`reconciled: 'fresh-execution'`).
- **Crash-window proof (item-level and graph-level convergence).** A PROOF-ONLY,
  env-gated fault hook (`C4_FAULT`, default OFF) forces `os._exit(2)` **after
  Cognee's write returns but BEFORE the journal commit** — the worst-case
  window: the external mutation has landed, the journal says only `begun`.
  Verified for both writes: the client reports `COGNEE_WRITE_UNKNOWN` (worker
  exit code 2 during a pending mutation), the journal shows
  begun-without-commit, the keyed reissue re-executes and **converges** —
  add: `itemsAfter === 1` with **no duplicate item** (the landed write +
  re-execution dedupe to exactly one data item), then replays; cognify: the
  dataset's **graph is searchable after the reissue** (scoped search returns
  hits) with stable item counts, then replays.
- **Item-level counts.** Every mutating receipt carries `itemsBefore` /
  `itemsAfter` from the Cognee registry. `itemsBefore` on a reissue is the
  durable pre-attempt count from the journal (0 for a crash-before-first-write,
  1 when the interrupted write had already landed); convergence is read from
  `itemsAfter` (exactly 1 for the proof corpora). Callers reconcile interrupted
  writes by re-issue with the SAME key and read the counts from the receipt.
- **No automatic replay outside §7.3.** The worker never retries mutations on
  its own; only the caller's keyed re-issue triggers reconciliation, and
  `forgetDataset` (§7.2) has no re-issue path at all.
- **Proof-layer honesty.** The reconciliation journal is implemented and
  exercised in the disposable worker proof (fsynced records verified on disk,
  including a `begun`-without-`completed` record for each crash-window
  attempt). It is NOT production code merely because its battery passes: the
  production pack must re-implement the journal for its own deployment (or
  declare `ambiguity: 'block'`), and the fault-injection hook is proof-only —
  it must be stripped or hard-gated in any shipped worker.

### 7.4 Missing datasets
Unknown or out-of-domain dataset names fail typed: `COGNEE_SCOPE_REJECTED`
(interface, before any Cognee call) or `COGNEE_DATASET_UNKNOWN`
(worker-resolved, pre-call) for mutating ops; the same code maps Cognee's strict
`DatasetNotFoundError`/`NoDataError` on read paths. Reusing an idempotency key
for different logical work fails `COGNEE_IDEMPOTENCY_MISMATCH` (§7.3). **No
silent no-ops cross the interface** (the Cognee `cognify` silent-no-op is
neutralized by the precheck; an unkeyed mutating invocation is refused rather
than run unkeyed).

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
  NDJSON over stdin/stdout. **stdout carries protocol messages** (≤ 1 MiB per
  line; oversized ⇒ connection aborted). **All diagnostics go to stderr** and are
  never parsed. cognee internals can leak non-protocol lines to stdout
  (observed: alembic migration prints on a fresh store's first connect); the
  worker pre-runs the relational migrations at startup with stdout captured
  (migration warm-up before serving), and the client DEMOTES any residual
  non-JSON stdout line to stderr with a `stdoutViolations` counter — demote,
  never parse, never fatal (the 1 MiB bound stays fatal).
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

`worker/worker.py` (v4) + `worker/client.mjs` + `worker/proof_c4.mjs` +
`worker/proof_c3.mjs` + `proof/c3_seed_foreign.py` implement the Node-facing
rules of this contract. **Every proof run builds a FRESH disposable store**
(`proof/.cognee-c3` / `proof/.cognee-c4`, own `.env`, own journal, guard
boundary = that store) — one worker, one store, one trust domain per run (§3).

C4 correction evidence (`worker/c4-results.json`: **32/32 PASS**, 231 s, fresh
store; journal `worker/c4-journal.jsonl`):
- retry-key exclusivity: a key in op params is rejected; a mutating op with no
  ctx key is rejected; a cognify without a ctx key is refused before the silent
  no-op path (c2);
- fresh execution → replay (≈10 ms, no re-exec) with item counts (c3);
- journal binding: same key + different content / different dataset / different
  op all rejected `COGNEE_IDEMPOTENCY_MISMATCH` with journal state intact
  (afterwards the original key still replays its original outcome) (c4);
- **forced crash after the add write, before the journal commit**
  (`C4_FAULT=add.after-write-before-commit`): worker exit 2 during the pending
  mutation → `COGNEE_WRITE_UNKNOWN`; journal shows exactly one `begun` without
  `completed`; keyed reissue re-executes and converges — itemsBefore 0 (durable
  pre-attempt count) → itemsAfter 1, **no duplicate**; then replays (c5);
- **forced crash after the cognify write, before the journal commit**
  (`C4_FAULT=cognify.after-write-before-commit`): same unknown-outcome
  behavior; keyed reissue re-executes and the **graph is searchable after the
  interruption** (scoped search hits, stable item counts) (c6);
- regressions re-run green in the same battery: scope rails, scoped
  datasetsStatus (seeded pre-existing foreign datasets hidden), bounds,
  both-sides summary isolation, restart persistence, forget receipt (files
  2→0) + typed post-delete failure + no journal record for forget
  (c7–c9); clean shutdown (c10).

C3 evidence retained (`worker/c3-results.json`: 26/26 PASS, fresh store):

**C4 runtime verification (pack installed into a REAL VICT runtime).**
`pack/` implements the manifest (`vict.capability-pack@1`, six capabilities,
`victCompatibility: '^0.1.0'`), executable input/output contracts (CONT-001 —
`datasetsStatus` carries an explicitly empty input contract), permission
declarations (`cognee.write` / `cognee.search` / `cognee.delete`), keyed-write
bindings with `ambiguity: 'keyedRetry'`, an `irreversible` forget binding, and
declared test/simulate doubles for add/cognify/forgetDataset. Supervision is
one instance per pack = one live worker per store (§3/§7.2). VICT is consumed
READ-ONLY from the local reference clone (imports of the committed
`packages/*/dist`); installation and invocation run against
`createRuntime` + `installCapabilityPack` from `@victframework/runtime` with
in-memory stores and a fresh disposable cognee store (`proof/.cognee-verify`).

Evidence (`worker/c4-verify-results.json`, `worker/c4-verify.log`; 14/14 checks
PASS + 1 recorded ABI OBSERVATION, 184 s):
- V0 manifest validates (`validateCapabilityPack`, compat `^0.1.0`); V1 pack
  installs atomically (all six capabilities);
- V2/V2b mode `test` on capability-only graphs: add+cognify run via the
  DECLARED DOUBLES with contract-valid receipts and ZERO worker spawns; the
  forget double likewise;
- V3 mode `test`: read (searchChunks, no double declared) FAILS CLOSED
  (`effect.blocked` → run `blocked`), no store touch;
- V4 runtime WITHOUT grants: the write invocation fails BEFORE the handler
  (permission pre-check; no worker spawn, no cognee call);
- V5 normal mode, REAL worker, durable orchestration driver (decision node +
  node retry policies + timeouts → `vict.activation@2`, runtime-derived
  idempotencyKeys): graph decide → add → adapt → cognify completes with item
  counts (itemsAfter 1), scoped search returns in-scope hits;
- V5b the SAME write graph without control semantics (sequential engine)
  invokes the real binding with NO context key → the binding REFUSES
  (unkeyed writes never run);
- V6 binding-level keyed semantics: same key replays the known outcome
  without re-execution; same key + different content →
  `COGNEE_IDEMPOTENCY_MISMATCH`;
- V7 `forgetDataset`: denied by default in normal mode; with run policy
  `allowIrreversible: true` it runs for real and the receipt shows a
  file-level purge (store files → 0);
- V8 resource/environment recording (below).
- **ABI OBSERVATION (recorded, not a check):** the durable orchestration
  engine runs the pinned REAL binding even in `test`/`simulate` — doubles and
  read fail-closed isolation hold only on capability-only (sequential-engine)
  graphs. Durable graphs must therefore be treated as real-effect graphs in
  every mode.

Resource use (V8, from `c4-verify-results.json`): 1 worker spawn, 0
kills/respawns, 9 worker ops, worker RSS ~343 MB after the run (startup
baseline recorded in `c3.log`/`c4.log` histories: ~250–400 MB; cognify peaks
~2.0 GB process-wide), wall clock 184 s, host free RAM 2.62 GB → 3.67 GB.
**Windows low-memory class (agent observations, C1/C2):** cognee cognify can
crash natively (`0xC0000005`) when free RAM drops toward ~1.9 GB; no native
crash occurred in the C4 runs (free RAM ≥ ~2.5 GB), and the supervision
poison+respawn policy contains any such death as `COGNEE_WRITE_UNKNOWN` /
`COGNEE_WORKER_UNAVAILABLE` without store corruption (single-owner journal +
cognee dedupe).

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

Evidence: `worker/c3-results.json` (26/26), `worker/c4-results.json` (32/32),
`worker/c3.log`, `worker/c4.log`, journals on disk (`proof/.cognee-*/system/`)
and committed as `worker/c3-journal.jsonl` / `worker/c4-journal.jsonl`. The
worker remains disposable proof code — it is not the pack implementation.

**Remaining limits (plainly):**
- The keyed-reconciliation journal is proven at the proof layer only; the
  production pack must re-implement it (a pack without it MUST declare
  `ambiguity: 'block'`, §7.3). Passing 32/32 does not make the proof worker
  production code.
- The crash-window fault hook (`C4_FAULT`) is PROOF-ONLY, env-gated, default
  OFF; a shipped worker must strip or hard-gate it.
- Cognify reissue convergence is proven observably (dataset searchable, item
  counts stable), not at graph-diff granularity: partial graph states from an
  interrupted cognify are not inspected directly.
- `add` convergence relies on Cognee's content-hash dedupe; re-issue of
  *changed* content with the same key is a caller error and is rejected by the
  fingerprint binding (§7.3), not silently converged.
- `replayed-known-outcome` replays trust the journal's record; the journal is
  fsynced but OS-crash durability of the underlying filesystem (beyond
  `fsync`) is unverified.
- Worker crashes (`0xC0000005`) under low free RAM remain an environment class
  (C1); the C4 batteries recorded no native crashes (free RAM ≥ ~2.5 GB), and
  one Cognee-internal `CognifyFailedError` (ladybug lock contention from a
  concurrently-live second worker — since made impossible by the §7.2
  one-worker rule) was reproduced as an agent observation and folded into the
  retry design of the c6 scenario.
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