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

**C4 exit corrections (this revision):**
- **Durable-mode fail-closed guard** — upstream VICT issue UV-1
  (`docs/upstream-vict-issues.md`): the durable orchestration engine ignores
  the effect policy's `useDouble` decision and invokes the pinned REAL binding
  in `test`/`simulate`. Every real Cognee binding now refuses
  `ctx.mode !== 'normal'` (COGNEE_MODE_REFUSED) BEFORE any worker request or
  store effect; verified for durable graphs containing reads, `add`,
  `cognify`, and `forgetDataset` in both modes: no worker spawn, no store
  change (§1, §11).
- **Fail-closed deadlines** — an expired or insufficient
  `CapabilityContext.deadlineAt` fails BEFORE the worker request
  (COGNEE_DEADLINE_EXCEEDED); the ABSOLUTE `deadlineAt` survives queue wait
  and worker startup, is re-checked immediately before dispatch, and is
  NEVER replaced with a fresh full timeout; post-dispatch expiry of a
  mutation reports an UNKNOWN outcome (§7.2).
- **Idempotency-key contract corrected** — upstream VICT issue UV-2:
  VICT's `deriveIdempotencyKey` accepts `invocationId` but never hashes it.
  The ABI statement in §1 and the uniqueness analysis in §7.3 were corrected
  against the source; the pack's fingerprint binding covers the latent
  collision path, and the residual risk is stated (§7.3).
- **Exclusive store ownership** — a store-owner lock (atomic create inside
  the store root) is claimed by every pack instance at construction, fails
  closed on a live owner (COGNEE_STORE_OWNED), recovers a verifiably stale
  owner, and is released on orderly shutdown; a live owner's lock is never
  deleted (§8).
- **Distributable worker** — the pack resolves its OWN bundled worker
  (`pack/src/worker/cognee_worker.py`, protocol `vict-cognee-worker/5`); the
  `C4_FAULT` hook is REMOVED from the shipped worker and crash injection
  lives only in the proof harness `worker/worker_proof.py` (§9, §11).
- **cognify retry semantics settled** — see §7.3 for the graph-equivalence
  proof and the resulting `ambiguity` declaration.

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
| **The runtime derives a deterministic idempotencyKey** per logical invocation — **UV-2 correction:** `deriveIdempotencyKey` ACCEPTS `invocationId` in its signature but the hashed payload contains only `{activationVersion, lineage, nodeId, runId, schema:'vict.idempotency-key@1'}` — `invocationId` is silently dropped (`orchestration-activation.ts:226–242`; confirmed in the committed `dist` bundle). Because `deriveInvocationId` is itself a deterministic function of exactly `{runId, activationVersion, lineage, nodeId}` (245–260), the omission is redundancy today, NOT collision — but the signature contract is broken; see §7.3 for the uniqueness analysis and residual risk. `invocationId` is invariant across retries and restarts, so retries and post-restart replays re-invoke the handler with the **same key**. **C4 verification: the key is derived ONLY when the graph node declares a retry policy** (`node?.retry !== undefined`; `orchestration-driver.ts:403–412`) — a write node without a retry policy gets `idempotencyKey: null` and is never replayed; and the **sequential engine (capability-only graphs) never supplies a key at all** (`kernel/src/execute.ts:323–336` builds the invocation context without `DurableInvocationContext`) | `packages/runtime/src/orchestration-activation.ts:226–242` (`deriveIdempotencyKey`), `runtime.ts:624`, `orchestration-driver.ts:403–412`, `kernel/src/execute.ts:323–336`; `docs/upstream-vict-issues.md` (UV-2) |
| **The kernel blocks replay of unkeyed writes**: a write attempt whose `idempotencyKey` is `null` returns `action: 'block'` — "A write capability without keyed idempotency has an unknown outcome after process loss; it is never replayed" | `packages/runtime/src/runtime.ts:392–400` |
| Permissions are enforced BEFORE the handler: an ungranted permission fails invocation with a structured error; "the handler was not invoked" | `packages/runtime/src/authority.ts:220` |
| `irreversible` is denied by default in normal mode (needs explicit `allowIrreversible`); in `simulate`/`test` modes real read/write/irreversible implementations are unreachable — a registered double is required, otherwise the request fails closed | `packages/runtime/src/effect-policy.ts` |
| `victCompatibility` is checked against the runtime compat version — currently `'0.1.0'` (`VICT_RUNTIME_COMPAT_VERSION`); example packs declare `'^0.1.0'` | `packages/runtime/src/pack-install.ts:38,54`; `pack.ts:424,457` |
| Contracts are executable parse promises: `{ ok: true, value } \| { ok: false, issues[] }`; contract rejection surfaces as `VICT_KERNEL_CONTRACT_REJECTED`; **every executable capability must declare BOTH an input and an output contract** (CONT-001 — `datasetsStatus` therefore carries an explicitly empty input contract) | `packages/contracts/src/define-contract.ts`; `packages/kernel/src/errors.ts`; pack-install validation | 
| **Graph-engine selection (C4 implementation finding):** a graph compiles to `vict.activation@2` (durable orchestration engine) when ANY node declares `retry` or `timeoutMs`, any node has a control `kind` (decision/fork/join/wait), or any edge is a non-success kind (route/branch/timeout/error) — `declaresControlSemantics`, `canonical.ts:185-201`. Clean capability-only graphs compile to `vict.activation@1` (sequential engine) | `packages/kernel/src/canonical.ts:185-201`, `compile.ts:1189`, `runtime.ts:869` |
| **Mode isolation is sequential-engine-only (upstream issue UV-1):** the durable orchestration engine ALWAYS invokes the pinned real binding — in `test`/`simulate` its `useDouble` decision is computed and then deliberately discarded ("Doubles are a Stage 02 sequential-engine facility", `orchestration-driver.ts` ~702). Only the irreversible denial (`decision.allowed`) is enforced there. Durable graphs therefore touch the REAL worker/store in every mode; **pack mitigation:** every real Cognee binding fails closed unless `ctx.mode === 'normal'` (`pack/src/bindings.ts`, verified V9) — durable graphs in `test`/`simulate` produce no worker spawn and no store change | `packages/runtime/src/orchestration-driver.ts`, `effect-policy.ts`; `docs/upstream-vict-issues.md` (UV-1) |
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
- **Fail-closed deadlines (C4 exit; correction pass 2).** The invocation
  context's `deadlineAt` is enforced at the BINDING before any worker
  request: if it is already expired, or leaves insufficient remaining
  time (< 250 ms margin), the invocation fails immediately
  (`COGNEE_DEADLINE_EXCEEDED`) and the operation NEVER starts — so no
  unknown-outcome window is created. A context deadline is NEVER replaced
  with a fresh full timeout.
- **The ABSOLUTE deadline survives the queue and worker startup**
  (correction pass 2): the binding forwards `ctx.deadlineAt` UNCHANGED (an
  absolute epoch-ms timestamp); supervision re-checks it immediately
  before dispatch — after queue wait AND after worker readiness — and an
  expiry there fails with NO effect (nothing is ever sent;
  `COGNEE_DEADLINE_EXCEEDED`). The response timer is anchored to the
  absolute deadline, not re-armed. If the deadline expires AFTER a
  mutation was dispatched, the outcome is reported as UNKNOWN
  (`COGNEE_WRITE_UNKNOWN`) — the write may already have landed — never as
  a clean refusal. Reads report a clean typed failure
  (`CLIENT_DEADLINE`). Verified: V10a–V10c (real-runtime entry refusals),
  V10d (expiry during worker startup, deterministic stub), V10e (expiry
  while queued behind an in-flight op), V10f (post-dispatch mutation →
  unknown; post-dispatch read → typed failure).
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
- **Key-uniqueness assumptions (corrected against VICT source — upstream
  issue UV-2, `docs/upstream-vict-issues.md`).** VICT's
  `deriveIdempotencyKey` ACCEPTS `invocationId` in its signature but the
  hashed payload contains only `{runId, activationVersion, lineage, nodeId,
  schema}` — `invocationId` is silently dropped. Today this is redundancy,
  not collision: `deriveInvocationId` is itself a deterministic function of
  exactly those fields, graphs are compile-time acyclic (cycles rejected,
  `compile.ts:1067–1079`), token lineage is path-derived, and
  `attemptNumber` is per-invocationId — so two distinct logical invocations
  cannot share the full key tuple within a run. The latent hazard: if a
  future VICT changes invocation identity (per-visit counter, epoch,
  re-invocation semantics), keys derived under the current formula would
  reuse a previous logical invocation's key for genuinely new work. The
  pack's fingerprint binding contains this: reuse for DIFFERENT work fails
  closed (`COGNEE_IDEMPOTENCY_MISMATCH`), never silently replays. **Residual
  risk (stated, not hidden):** a future re-invocation with IDENTICAL input
  under a colliding key would replay the recorded outcome instead of
  re-executing — unreachable within the pinned VICT (`^0.1.0`, acyclic
  graphs, deterministic invocation ids) and best fixed upstream by hashing
  `invocationId` (`vict.idempotency-key@2`) or removing it from the
  signature. The pack additionally pins `victCompatibility` so a VICT
  identity-semantics change forces re-validation.
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
- **Crash-window proof (item-level AND graph-level convergence).** A
  PROOF-ONLY harness (`worker/worker_proof.py`, env `C4_PROOF_FAULT`, default
  OFF) forces `os._exit(2)` at the journal commit of the armed operation —
  the worst-case window: the external mutation has landed, the journal says
  only `begun`. (The SHIPPED worker carries no fault injection; the harness
  patches the shipped worker's journal commit in-process.) Verified for both
  writes: the client reports `COGNEE_WRITE_UNKNOWN` (worker exit code 2
  during a pending mutation), the journal shows begun-without-commit, the
  keyed reissue re-executes and **converges** — add: `itemsAfter === 1` with
  **no duplicate item**, then replays; cognify: **full graph equivalence**
  (below), then replays.
- **cognify retry semantics settled by GRAPH equivalence (C4 exit).** The
  question "is a cognify reissued after a post-write/pre-commit crash
  equivalent to an uninterrupted cognify?" is answered at graph-diff
  granularity, not by searchability alone: two ISOLATED fresh stores, same
  content; store A cognifies uninterrupted; store B's cognify is force-crashed
  after the write and before the journal commit, then reissued under the same
  key. Both stores' FULL ladybug graphs (per-dataset `.lbug` files,
  `worker/graph_dump_c4.py`) are dumped and compared: **node identities
  (type, name), edge identities (source, target, relationship), and every
  property are IDENTICAL** (12 nodes / 12 edges both sides, zero missing,
  zero extra, zero property differences after excluding provably per-store
  random fields: node/edge UUID ids, `document_id`, `source_node_id`,
  `raw_data_location` paths, timestamps, pipeline-run provenance — the
  exclusion list is committed in the dump tool). Searchability (`scoped
  search returns hits`) holds as before AND is no longer the only claim.
  **Consequence: `cognify` keeps `ambiguity: 'keyedRetry'`** with the same
  reconciliation semantics as `add`. The equivalence is demonstrated for the
  proof corpus and the pinned cognee 1.6.1/gliner pipeline; it is NOT a
  general theorem — any change of extraction model, pipeline, or cognee
  version re-opens the question (§10 upgrade policy).
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
  attempt). The proof harness (`worker/worker_proof.py`) and the SHIPPED
  worker (`pack/src/worker/cognee_worker.py`) are now SEPARATE: the shipped
  worker is the pack-bundled, fault-free implementation; the journal itself
  lives in the shipped worker (it is worker code, not client code), so the
  proof exercises the same reconciliation implementation the pack would
  distribute. Production readiness still requires the release review below
  (§11 remaining limits).

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

- **Exclusive store ownership (C4 exit; correction pass 2).** Pack-level
  supervision covers one process, but separate pack instances or separate
  PROCESSES could point at the same Cognee root (the ladybug lock only fails
  at op time — after a worker spawn, possibly mid-write). Every pack
  instance therefore claims a store-owner lock
  (`<storeRoot>/cognee-store-owner.lock`, atomic `O_EXCL` create, schema
  `vict.cognee.store-ownership@1`, pid + host + instanceId + heartbeat) at
  construction:
  - a LIVE owner fails the second instance closed (`COGNEE_STORE_OWNED`)
    BEFORE any worker spawn (verified O2);
  - liveness is verified EXACTLY for same-host owners by pid probe; a live
    pid is live even with a stale heartbeat, and a live owner's lock is
    NEVER deleted (verified O2b/O9a — lock bytes unchanged);
  - a verifiably STALE owner (dead pid on this host; foreign host whose
    heartbeat exceeded the stale budget, default 15 min; unreadable lock
    older than the budget) is recovered by an ATOMIC RENAME-BASED CLAIM
    (verified O4);
  - ownership is RELEASED on orderly shutdown and a restarted instance
    acquires cleanly (verified O3b/O3c); the heartbeat is refreshed per
    serialized op AND on an interval while an op is in flight
    (interval = staleMs/3, floored at 1 s — verified O9c).
- **Ownership LOSS fails closed (correction pass 2; verified O2b/O6).**
  Ownership is verified against the lock file at THREE points: before any
  spawn/dispatch (heartbeat refresh), immediately before dispatch (after
  queue wait + worker readiness), and continuously while an op is in
  flight. If the lock is MISSING or no longer carries THIS instance's id —
  removed or replaced externally — the instance sets a permanent lost flag:
  the current request (if not yet dispatched) fails with
  `COGNEE_STORE_OWNED` and NO effect; an ALREADY-DISPATCHED op completes
  (its outcome is real — the request was sent), after which the worker is
  killed and poisoned; EVERY subsequent request of that instance fails
  closed before spawn/dispatch. An active instance whose lock is replaced
  or removed performs NO further operation.
- **Stale recovery is race-safe (correction pass 2).** The old
  read→unlink→create recovery had a TOCTOU window in which two contenders
  could both acquire. Recovery now: (1) read + judge the stale lock from a
  snapshot; (2) ATOMICALLY rename the lock out of the way to a unique
  recovery file — exactly ONE contender can succeed (every other contender's
  rename fails ENOENT and re-evaluates); (3) prove the moved lock is STILL
  the exact bytes that were judged stale; a mismatch means a fresh owner
  replaced it in the window — the contender FAILS CLOSED and RESTORES the
  displaced lock (byte-identical) if the path is free, so the fresh owner
  keeps working; (4) create its own lock via `O_EXCL`. Verified:
  O7 (deterministic two-contender race: EXACTLY ONE acquires, the other is
  refused, winner's lock intact) and O8 (a stale contender whose claim lands
  after a fresh owner acquired NEVER removes the fresh lock — the fresh
  owner's lock bytes are restored unchanged and the fresh owner keeps
  holding). An exiting owner's lock becomes legitimately stale the moment
  its pid dies (same-host exactness) — recovery by another contender is
  then correct and permitted.
- **Foreign-host heartbeat budget (correction pass 2).** Foreign-host
  owners rely on the heartbeat; the heartbeat is refreshed per op and
  DURING long in-flight operations, so the staleness budget (default
  15 min) is NOT eroded by long-running operations: a live, running owner
  is not stealable regardless of op duration; the budget is only the
  maximum time a crashed foreign host's lock lingers (verified O9a fresh
  heartbeat → refused; O9b stale heartbeat → recovered; O9c heartbeat
  advanced during a 3 s op under a 1.5 s budget). If the lock is stolen or
  removed mid-op DESPITE the refreshes, the in-flight op completes and the
  instance then fails closed permanently (above).
- `cognee.systemRoot` MUST be a pack-owned, per-runtime directory **(§3: one
  store per trust domain)**. The worker resolves **all seven destructive roots**
  (system/data/cache/logs/repos + `vector_db_url` + `graph_file_path`) at
  startup and refuses to serve (process exit 2) unless every root is strictly
  inside the runtime's store boundary — the pack-bundled fail-closed guard
  (`pack/src/worker/guard_store_roots.py`) with the runtime store as the
  containment boundary; `--store-root` is REQUIRED (the worker refuses to
  serve without an explicit boundary). Uncertainty is a violation.
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
- **Distributable worker (C4 exit).** The pack resolves its OWN BUNDLED worker
  (`pack/src/worker/cognee_worker.py`, protocol `vict-cognee-worker/5`) by
  default — the store guard ships alongside it, and the shipped worker
  contains NO fault injection (`C4_FAULT` removed; verified by the
  verification suite: the file contains no fault hook and the default
  workerPath resolves inside `pack/src/worker/`). Crash injection exists ONLY
  in the proof harness `worker/worker_proof.py`, which imports the shipped
  worker module and patches its journal commit under the explicit proof env
  `C4_PROOF_FAULT` (default OFF — inert unless set).
- **One op at a time** per worker; ops run in isolated asyncio tasks (C2 ContextVar
  persistence finding). One worker per store per trust domain (§3).
- **Startup:** guard (§8) → ready message with versions (cognee, python) and the
  verified store boundary → ready budget 120–180 s (observed 10–36 s in the C3
  fresh-store runs on the RAM-constrained host).
- **Deadlines:** every op carries an ABSOLUTE deadline (context `deadlineAt`
  preserved through queue + startup, re-checked immediately before dispatch;
  on expiry the client fails the op — `COGNEE_WRITE_UNKNOWN` for mutations
  already dispatched / `CLIENT_DEADLINE` for reads — and applies the §7.2
  poison-and-respawn policy for mutations).
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

## 11. Proof alignment (pack-bundled worker + proof-only crash harness, fresh stores)

`pack/src/worker/cognee_worker.py` (v5, the PACK-BUNDLED, fault-free worker)
+ `worker/worker_proof.py` (PROOF-ONLY crash-injection wrapper) +
`worker/client.mjs` + `worker/proof_c4.mjs` + `worker/graph_equiv_c4.mjs` +
`worker/graph_dump_c4.py` + `proof/c3_seed_foreign.py` implement the
Node-facing rules of this contract. **Every proof run builds a FRESH
disposable store** (`proof/.cognee-c3` / `proof/.cognee-c4` /
`proof/.cognee-equiv-{a,b}` / `proof/.cognee-ownership`, own `.env`, own
journal, guard boundary = that store) — one worker, one store, one trust
domain per run (§3).

C4 correction evidence (`worker/c4-results.json`: **32/32 PASS**, 421 s,
fresh store, re-run after the C4 exit restructuring — bundled worker +
proof-only crash harness; journal `worker/c4-journal.jsonl`):
- retry-key exclusivity: a key in op params is rejected; a mutating op with no
  ctx key is rejected; a cognify without a ctx key is refused before the silent
  no-op path (c2);
- fresh execution → replay (≈10 ms, no re-exec) with item counts (c3);
- journal binding: same key + different content / different dataset /
  different op all rejected `COGNEE_IDEMPOTENCY_MISMATCH` with journal state
  intact (afterwards the original key still replays its original outcome) (c4);
- **forced crash after the add write, before the journal commit**
  (proof harness, `C4_PROOF_FAULT=add.after-write-before-commit`): worker
  exit 2 during the pending mutation → `COGNEE_WRITE_UNKNOWN`; journal shows
  exactly one `begun` without `completed`; keyed reissue re-executes and
  converges — itemsBefore 0 (durable pre-attempt count) → itemsAfter 1,
  **no duplicate**; then replays (c5);
- **forced crash after the cognify write, before the journal commit**
  (`C4_PROOF_FAULT=cognify.after-write-before-commit`): same unknown-outcome
  behavior; keyed reissue re-executes and the **graph is searchable after the
  interruption** (scoped search hits, stable item counts) (c6); the FULL
  graph-equivalence proof is separate (below);
- regressions re-run green in the same battery: scope rails, scoped
  datasetsStatus (seeded pre-existing foreign datasets hidden), bounds,
  both-sides summary isolation, restart persistence, forget receipt (files
  2→0) + typed post-delete failure + no journal record for forget
  (c7–c9); clean shutdown (c10).

**C4 exit verification (this revision — four runs, all fresh stores):**

1. **Real-runtime suite** (`pack/verify/verify.ts` →
   `worker/c4-verify-results.json`, **26/27 PASS** — 27th is the recorded ABI
   OBSERVATION, 67 s): prior V0–V8 all green, plus:
   - V9a–V9d **durable-mode fail-closed guard**: DURABLE graphs (add+cognify
     write graph; durable read graph; forgetDataset graph) in `test` AND
     `simulate` are refused by every real binding — run fails, **zero worker
     spawns, zero store change** (byte-identical store snapshot). V9d is the
     sharpest: `forgetDataset` in test mode would NOT be denied by VICT's
     irreversible gate (that gate is normal-mode-only and `useDouble` is
     discarded on the durable path), so the binding's own mode guard is the
     only protection against a real purge — and it holds;
   - V10a–V10c **fail-closed deadlines** (real runtime): an expired
     `ctx.deadlineAt` and an insufficient one (100 ms remaining) fail with
     `COGNEE_DEADLINE_EXCEEDED` BEFORE the worker request — no spawn, no
     store change, and no fresh timeout substitution; reads enforce the
     same;
   - V10d–V10f **deadline through startup and queueing** (correction pass
     2, deterministic protocol stub worker on an isolated store): an
     absolute deadline expiring DURING worker startup fails BEFORE dispatch
     (nothing sent — stub servedOps proves it); a queued request whose
     deadline expires behind an in-flight op fails BEFORE dispatch (never
     sent); a mutation whose deadline expires AFTER dispatch reports
     UNKNOWN (`COGNEE_WRITE_UNKNOWN`); a read reports a clean typed
     failure (`CLIENT_DEADLINE`);
   - V11 **distributable worker**: the default `workerPath` resolves to
     `pack/src/worker/cognee_worker.py`, the file exists, and it contains NO
     `C4_FAULT` hook.
2. **Ownership suite** (`pack/verify/ownership-verify.ts` →
   `worker/c4-ownership-results.json`, **14/14 PASS**, ~27 s; run twice for
   determinism): O1 first instance claims exclusive ownership; O2 second
   instance fails closed (`COGNEE_STORE_OWNED`, pre-spawn); O3a a real
   worker op runs under held ownership / O3b shutdown releases / O3c restart
   reacquires; O4 dead-pid stale recovery (atomic rename claim);
   **O2b (revised)** a crafted LIVE-owner lock replaces the active
   instance's lock: the contender fails closed and the crafted lock is never
   deleted AND the active instance whose lock was replaced performs NO
   further operation (fail closed, sticky, no spawn, no dispatch);
   **O6** a REMOVED lock fails the active instance closed on its next op
   (sticky);
   **O7** deterministic two-contender race for a stale lock (two concurrent
   processes, both holding): EXACTLY ONE acquires, the other is refused, the
   winner's lock is intact;
   **O8** a stale contender whose delayed claim lands after a fresh owner
   acquired NEVER removes the fresh lock — the fresh owner's lock bytes are
   restored unchanged and the fresh owner keeps holding;
   **O9a/O9b** foreign-host heartbeat liveness (fresh heartbeat → refused;
   stale heartbeat → recovered) and **O9c** the heartbeat is refreshed
   DURING a 3 s op under a 1.5 s budget (the foreign-host budget never
   erodes while a live owner runs) with a second instance refused mid-op;
   O5 resource recording (single spawn; refused ops never dispatch).
3. **Cognify graph-equivalence proof** (`worker/graph_equiv_c4.mjs` →
   `worker/c4-graph-equiv-results.json`, **8/8 PASS**, 221 s, two ISOLATED
   fresh stores; correction pass 2): the crash+reissue graph is EQUIVALENT
   to the uninterrupted graph under the STRENGTHENED comparator — RAW node
   and edge counts asserted equal (12/12 nodes, 12/12 edges both sides),
   per-identity MULTIPLICITIES asserted equal (duplicates can no longer be
   silently overwritten — the dump normalizes each identity to a LIST of
   property variants compared as multisets), zero identity or property-
   variant differences after excluding provably per-store random fields
   (each exclusion individually justified in `worker/graph_dump_c4.py`),
   and NEGATIVE CONTROLS proving the comparator FAILS when an extra
   duplicate node/edge instance (same identity — the exact case the old
   key→props comparison collapsed) or an extra new-identity edge is
   injected (g7). `cognify` therefore KEEPS `ambiguity: 'keyedRetry'`. Full
   dumps committed: `worker/c4-equiv-graph-{a,b}.json`.
4. **Worker-boundary regression** (`worker/proof_c4.mjs` →
   `worker/c4-results.json`, 32/32 PASS, 421 s): re-run end-to-end against
   the BUNDLED worker with crash injection via the separate proof harness
   (`worker/worker_proof.py`, `C4_PROOF_FAULT`) — no behavioral regressions.

Resource limits recorded: real-runtime suite 1 worker spawn, 0 kills,
RSS ~344 MB, wall 67 s; ownership suite 1 spawn, ~27 s (plus ~10 s of
contender child processes); graph-equivalence proof ran two workers
SEQUENTIALLY on two isolated stores, wall 221 s; c4 battery 421 s on a
fresh store. All stores are disposable per-run directories under `proof/`
(gitignored), one worker / one store / one trust domain per run.

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
- **ABI OBSERVATION (updated):** the durable orchestration engine runs the
  pinned REAL binding even in `test`/`simulate` (upstream issue UV-1) —
  sequential-engine doubles and read fail-closed isolation hold only on
  capability-only graphs. **Pack answer (V9):** every real Cognee binding now
  fails closed unless `ctx.mode === 'normal'`, so durable graphs no longer
  touch the worker/store outside normal mode. Other packs' durable graphs
  remain affected upstream.

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
proof drivers and crash harness remain proof code; the SHIPPED worker is
`pack/src/worker/cognee_worker.py` (no fault hooks).

**Remaining limits (plainly):**
- The reconciliation journal lives in the SHIPPED worker (`pack/src/worker/
  cognee_worker.py`) and is exercised by the proofs through that same code;
  it is nonetheless a first release: OS-crash durability beyond `fsync` is
  unverified. Publication and consumer integration remain OUT OF SCOPE
  (§12); a distribution pass must still add build/packaging metadata (below).
- The crash-injection harness (`worker/worker_proof.py`) is PROOF-ONLY and
  separate from the shipped worker; the shipped worker contains no fault
  hook (verified). Keep it that way in future revisions.
- Cognify reissue convergence is proven at graph-diff granularity for the
  proof corpus under the pinned cognee 1.6.1 + gliner pipeline and a single
  dataset. It is not a general theorem: a changed extraction model, pipeline,
  or cognee version re-opens the question (§10 upgrade policy). The graph
  diff itself excludes provably per-store random fields (UUID identities,
  timestamps, run provenance, store-root paths); structural equivalence is
  exact (identities + all remaining properties).
- `add` convergence relies on Cognee's content-hash dedupe; re-issue of
  *changed* content with the same key is a caller error and is rejected by the
  fingerprint binding (§7.3), not silently converged.
- `replayed-known-outcome` replays trust the journal's record; the journal is
  fsynced but OS-crash durability of the underlying filesystem (beyond
  `fsync`) is unverified.
- **Release metadata (remaining, deliberately NOT done here):** the package
  is not published and this was not a packaging pass — `pack/package.json`
  still declares `main: src/index.ts` (TypeScript source, no build artifact,
  no `files` allowlist, no bundled-worker packaging config, `private: true`).
  A distribution pass must add: a build step (tsc/tsup), a `files` allowlist
  including `src/worker/cognee_worker.py` + `src/worker/guard_store_roots.py`,
  resolved peer/engine metadata, and a packaging test that installs the packed
  tarball into a clean consumer. Publication itself remains excluded.
- Store-ownership residual risk (updated by correction pass 2): a foreign-host
  owner is protected by its heartbeat, which is refreshed per op AND during
  in-flight operations, so long ops no longer erode the budget; a crashed
  foreign host frees its lock only after that budget (default 15 min).
  Same-host owners are exact (pid probe). If the lock is stolen or removed
  externally mid-op DESPITE the refreshes, the already-dispatched op
  completes (its outcome is real) and the instance then fails closed
  permanently; the in-flight op itself cannot be un-run. The lock does not
  protect against out-of-band access to the store directory by non-pack
  processes.
- Worker crashes (`0xC0000005`) under low free RAM remain an environment class
  (C1); the C4 batteries recorded no native crashes (free RAM ≥ ~2.5 GB), and
  one Cognee-internal `CognifyFailedError` (ladybug lock contention from a
  concurrently-live second worker — since made impossible by the §7.2
  one-worker rule AND the §8 ownership lock) was reproduced as an agent
  observation and folded into the retry design of the c6 scenario.
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
8. **Upstream VICT fixes (documented, not edit-able here):**
   - UV-1: durable engine should honor `useDouble` or block real non-pure
     bindings in test/simulate (`docs/upstream-vict-issues.md`); the pack
     guards its own boundary meanwhile.
   - UV-2: `deriveIdempotencyKey` should hash `invocationId`
     (`vict.idempotency-key@2`) or drop it from the signature.
9. **Release/packaging metadata** (§11 remaining limits): build artifact,
   `files` allowlist incl. the bundled worker + guard, packaging smoke test.
   Publication itself remains excluded from this task.
10. Read-capability test/simulate doubles, if read isolation via doubles is
    ever wanted on capability-only graphs (currently they fail closed, which
    is safe).