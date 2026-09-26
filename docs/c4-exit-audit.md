# C4 exit — independent read-only audit report

**Auditor:** independent (not the author of the C4 corrections; no shared session state with the
correction passes).
**Audited commit:** `radz2291/VICT-Cognee` @ `4e79f6f9499c7f18df560680c782ce96296c9cff` (correction pass 2).
Local checkout HEAD: `4860bbd9ce3c815f51a21756eb95cef04106b27f` — an evidence-only child of the
audit target (`docs/c4-exit-report.md` + `worker/c4-results.json` only; **`git diff 4e79f6f..HEAD`
touches no pack/worker code** — verified). Working tree clean; `main` == `origin/main`.
**ABI reference (read-only):** `radz2291/vict-02` @ `5ea0afe257d5e7f67e050fcae169746a25fd3cc4`.
- Verified `5ea0afe` is an ancestor of the local clone's HEAD (`15e3bed`) and exists on a fresh
  blob-less clone fetched for this audit (at `AppData/Local/Temp/vict-02-audit-ro`, read-only).
- `git diff 5ea0afe..15e3bed -- packages/sdk packages/runtime` is **empty** (only governance docs
  changed after `5ea0afe`), so the locally built `packages/*/dist` consumed by the verification
  suites corresponds to the reference ABI.
**Untouched:** VICT, Quellight, Trading OS, Stage 8 (no writes; VICT clone clean before and after).
Nothing published; no consumer integrated. **Implementation unchanged by this audit** (audited
evidence files in the working tree were overwritten by the reruns and then restored to HEAD bytes;
`git status` clean).

## Verdict: **C4 exit verified with non-blocking issues** — AMENDED after the L1 revisit

No blocking defect was found in the pack code, worker, guard, contracts, manifest, or the crash
convergence claims. All four focused suites were **rerun end-to-end by the auditor on this audit
day** and reproduce the committed evidence. **Amendment (see finding L1, revised to Medium):** the
store-ownership invariant "at most one live worker per store at all times" (contract §7.2/§3,
supervision comment supervision.ts:322 "Either way NO second owner can exist") is **NOT
unconditionally established**: a deterministic interleaving test against the unmodified code
demonstrates two instances operating concurrently (both with in-flight ops) on one physical store
through the stale-recovery restore path. The window is bounded (until the displaced instance's
in-flight heartbeat tick or operation settlement), its fallout is typed cognee-level contention
failures plus automatic fail-closed convergence (no silent corruption demonstrated), and reaching
it in production requires the recovering thread to be preempted for at least the new instance's
spawn-to-dispatch duration inside a microsecond-scale synchronous syscall window — pathological
but not impossible on the documented RAM-constrained host. All other exit claims stand; the
exclusive-restore correction (L1) is required before publication or any multi-process deployment.
(An unconditional "verified" or a "not verified" verdict were both rejected deliberately: no
corruption was demonstrated and every other claim reran green, but the previous report's assurance
that the restore path cannot create an operating second owner was wrong and is withdrawn.)

## Reruns executed by this audit (fresh disposable stores, sequential)

| Suite | Result (this audit) | Wall |
| --- | --- | --- |
| `tsx pack/verify/ownership-verify.ts` | **14/14 PASS** | 26 s |
| `tsx pack/verify/verify.ts` | **26/27** (27th = ABI OBSERVATION record) | 99 s |
| `node worker/graph_equiv_c4.mjs` | **8/8 PASS** (fresh isolated stores) | 210 s |
| `node worker/proof_c4.mjs` | **32/32 PASS** (fresh store) | 240 s |

The reruns overwrote the tracked `worker/*.json` evidence files in the working tree; they were
restored byte-identically afterwards (auditor's rerun JSONs/logs retained at
`AppData/Local/Temp/c4-audit-rerun-evidence/`, not committed).

## Findings (severity order)

### M1 (Medium) — Proof drivers never return a failing exit status when assertions fail
`worker/proof_c4.mjs:416`, `worker/graph_equiv_c4.mjs:311`, `pack/verify/verify.ts:762`,
`pack/verify/ownership-verify.ts:453` all end with unconditional `process.exit(0)`. A `FAIL`
record changes only the printed `N/M PASS` count, never the exit code; `scenario()` in
`proof_c4.mjs` additionally downgrades `COGNEE_WRITE_UNKNOWN`/`CLIENT_DEADLINE`/
`COGNEE_WORKER_UNAVAILABLE` raised outside `expectError` to `AGENT-OBSERVATION`. Any automation
(CI, consumer preflight) keyed on exit status would see green through real regressions.
Verified by source (all four exit sites unconditional; no FAIL→exit coupling exists).
**Smallest correction:** after writing the results JSON, `process.exit(results.some(r =>
!/^(PASS|OBSERVATION)$/.test(r.outcome)) ? 1 : 0)` in each driver.

### M2 (Medium) — Contract §9 promises two supervision behaviors the code does not implement
`docs/c3-pack-contract.md:537` ("ready message with versions (cognee, python)") — the ready
message (`pack/src/worker/cognee_worker.py`, `_emit({... "protocol": "vict-cognee-worker/5" ...})`)
carries pid/RSS/import_ms/protocol/namespaces/store_root but **no version fields**.
`docs/c3-pack-contract.md:545–546` ("worker reports RSS per op"; "Exceeding the budget ⇒ graceful
restart after the op") — the worker reports RSS only on `ready`/`status`; op responses carry no
RSS, and `pack/src/supervision.ts` records `stats.lastRssBytes` solely from the ready line
(supervision.ts:442) with **no RSS budget or post-op restart anywhere** (`grep` over pack/src and
worker/client.mjs: no RSS-based respawn). Fail-safe paths (poison/respawn on worker death, the
journal) are unaffected, so this is a doc/code mismatch, not a safety gap. **Smallest
correction:** implement per-op RSS reporting + post-op budget respawn, or reword §9 to describe
what is implemented (RSS on ready/status; restart on death/timeout only).

### L1 (Medium — REVISED after deterministic interleaving test; was Low) — Stale-recovery restore path can displace a fresh live lock AND admits a two-worker concurrent-operation window
`pack/src/supervision.ts:325–326`: in the mismatch branch, `existsSync(lockPath)` is checked and
then `renameSync(trash, lockPath)` is executed — two non-atomic steps. Node's `renameSync`
**overwrites an existing destination** (demonstrated on this platform during the audit). A third
fresh instance acquiring during the gap (`acquireStoreOwnership`, supervision.ts:261 — the direct
`O_EXCL` path succeeds whenever the path is momentarily absent) has its brand-new live lock
silently replaced by the restore rename.

**Revisit (this amendment): can A and C operate on the same physical store concurrently?**
**YES — demonstrated deterministically.** Full sequence against the unmodified code
(audit-only driver, `docs/audit-evidence/l1-interleave.mts` on this branch; raw log
`docs/audit-evidence/l1-interleave.log`):
1. Recoverer B reads a lock (simulated externally with B's exact recovery sequence).
2. Instance A acquires and dispatches a 5 s operation (A's lock is live; A's op in flight).
3. B moves A's live lock (`renameSync(lock → trash)`); the path is now absent; B pauses
   (the "descheduled recoverer" hypothesis).
4. Instance C acquires the now-free path via the constructor's direct `O_EXCL` path and dispatches
   a 4 s operation — **both of C's pre-dispatch verifications (refresh + pre-dispatch,
   supervision.ts:541/554) pass**, because the path still carries C's own lock.
5. B restores A's lock, overwriting C's live lock.

Results (7/7, unmodified pack code):
- C acquires over the displaced gap (constructor `O_EXCL`, supervision.ts:261) — PASS;
- C **dispatches** its op before the restore (`opsServed: 1`; both verifies passed) — PASS;
- the restore overwrites C's lock with A's bytes — PASS;
- **A's worker and C's worker were simultaneously alive with in-flight ops** — PASS;
- **both operations completed** (their outcomes were real) — PASS;
- C fail-closes sticky (`COGNEE_STORE_OWNED`) and its worker is killed at settlement — PASS;
- A was unaware throughout (lock restored byte-identical, ownership still held) — PASS.

**Why neither heartbeat detection nor the pre-dispatch checks prevent the overlap.** C's loss is
detected only by its in-flight heartbeat interval, `max(1_000, staleMs/3)` (supervision.ts:575;
default 15 min ⇒ 5-minute tick), and is acted on only **at settlement** (supervision.ts:577–584:
`lostMidOp` → poison + kill). So the overlap window runs from C's **dispatch** until C's operation
settles — bounded by the operation's absolute deadline (up to ~4 min for mutations at the default
budgets), not by immediate detection. A never detects anything (restored bytes are identical).
Both instances' operations execute concurrently during that interval; with the real cognee worker
the failure surface is the C2-observed contention class (ladybug `Could not set lock on file`,
sqlite/lance write contention) — **typed failures and caller-side reconciliation, not silent
corruption** — but "exclusive operation during the interval" is not established. Secondary facet:
an operation that settles within one heartbeat interval leaves C's worker alive-orphaned
(`verifyOwnershipIntact` never kills the child; the next request throws before `_lifecycle`).

**Production reachability (honest bounds).** Without preemption, the recoverer's
rename→read→compare→existsSync→rename span is one synchronous turn (microseconds): C can acquire
in it (ordinary microsecond-scale cross-process interleaving) but cannot dispatch (spawn latency
≫ the gap), so C is refused at its next verify and no overlap occurs. Overlap requires the
recoverer's thread preempted for at least C's acquire→spawn→ready→dispatch duration (≥100 ms with
a fast stub; 10–36 s with the real cognee worker) inside that microsecond window — a rare but
nonzero scheduling event under the machine-wide stalls this repo's own environment records
(RAM-constrained host, swap thrash class). It additionally requires a pre-existing stale lock and
three racing instances. Trigger probability is very low; consequence is bounded, typed, and
converging — hence **Medium, not High**; the previous Low rating is withdrawn because the interval
is a real exclusivity violation, not a harmless false eviction.

**Smallest correction (unchanged in shape, now load-bearing):** make the restore exclusive —
`openSync(lockPath, 'wx')` writing the displaced bytes; on `EEXIST` skip the restore and fail
closed — so a fresh contender's lock can never be overwritten; optionally also kill the child in
`verifyOwnershipIntact`'s failure path (orphan facet). The exit report's residual §4.3 must be
extended to state the bounded overlap window until this correction lands.

### L2 (Low) — Ready-budget expiry strands the instance while the worker stays alive
`pack/src/supervision.ts:497–505`: when the ready timer fires, `readyResolve/readyReject` are
nulled and the promise rejects — but the child is neither killed nor poisoned. If the worker later
becomes ready, the `ready` line is recorded (`readyInfo`) but never resolves anything; the live
child keeps `poisoned === false`, so every subsequent `request()` awaits the same rejected promise
and fails `COGNEE_WORKER_UNAVAILABLE` until the worker happens to exit or `shutdown()` runs.
Fail-closed (availability only). **Smallest correction:** on ready-budget expiry, kill the child
and clear `this.child` so the next request respawns.

### L3 (Low) — Ownership lock covers the spelled storeRoot, not the physical store identity across nested boundaries
The lock lives inside the store root, so all spellings/aliases of the **same** storeRoot map to the
same physical lock file (verified reasoning). But two pack instances configured with **nested**
storeRoots (e.g. `C:\store` and `C:\store\system`) whose `.env` files both aim cognee's system root
at one directory pass both guards (each root set is inside its own boundary) and hold two
different lock files → two live workers on one physical store; the failure surfaces as ladybug
lock contention at op time (typed failure — the pre-C4 behavior). Requires deliberate host
misconfiguration; the one-store-per-trust-domain rule (§3) forbids it. **Smallest correction
(optional):** verify the worker's ready `store_root` against the configured storeRoot, and/or move
the lock inside the resolved system root once known.

### L4 (Low) — Output contracts are not parsed at the binding boundary
`pack/src/bindings.ts` returns `sup.request(...)` results directly without running the declared
output contract's parse. Enforcement today relies on the VICT durable driver's node
output-contract check (`orchestration-driver.ts:894+`, only when the node declares `output`) or
the sequential engine; direct binding invocation (as in V6) is unvalidated. A malformed worker
receipt could cross the boundary untyped if a consumer graph omits `output`. **Smallest
correction:** run the receipt through the corresponding output contract inside each binding before
returning.

### Info (non-findings verified during the audit)
- **ABI provenance:** UV-1 confirmed at source — `orchestration-driver.ts:702–707` computes
  `decision.useDouble` and discards it in a comment ("doubles are a Stage 02 sequential-engine
  facility"); UV-2 confirmed — `deriveIdempotencyKey` (`orchestration-activation.ts:226–243`)
  hashes `{activationVersion, lineage, nodeId, runId, schema}` and silently drops `invocationId`,
  while `deriveInvocationId` is deterministic over the same fields (no collision path today).
  The sequential engine honors doubles/mode eligibility (`runtime.ts:1336–1400`).
- `StatusInputContract` (contracts.ts:211) accepts any object payload, slightly laxer than the
  "explicitly empty" wording (CONT-001); harmless.
- The restore-race and mid-op displacement residuals are documented (c4-exit-report §4.3), but the
  revisit above shows §4.3's assurance understates the interval: the restore path admits a bounded
  two-worker overlap window (L1, now Medium) that the residual text does not describe.

## Audit coverage per the six mandated areas

1. **Manifest/contracts/permissions/effects/isolation/irreversible gating** — verified by rerun
   (V0–V4, V9a–V9d incl. the sharp V9d: durable forgetDataset in test mode is stopped only by the
   binding's mode guard and it holds) + ABI source checks above.
2. **Dataset scope / trust domain / guarded roots / worker protocol / supervision** — verified by
   rerun (c1, c7, c8: cross-namespace rejections, `hiddenDatasets` hiding pre-existing
   `legacy_unscoped`/`outside.vault`, topK/line caps, summary isolation both sides) and by source
   (guard fail-closed; `--store-root` required; stdout NDJSON discipline).
3. **Absolute deadlines** — verified by rerun (V10a–c entry refusals; V10d expiry during startup
   with stub `servedOps` proving nothing was sent; V10e queued expiry never sent; V10f
   post-dispatch mutation → `COGNEE_WRITE_UNKNOWN`, read → `CLIENT_DEADLINE`). Pre-dispatch
   refusal vs unknown-after-dispatch is correctly distinguished.
4. **Exclusive store ownership** — verified by rerun (O1–O9, incl. deterministic two-contender race
   O7, stale-contender O8, foreign-host budget O9a–c). Double-ACQUISITION is impossible (verified);
   however the L1 revisit demonstrates a bounded CONCURRENT-OPERATION window through the restore
   path (see L1, revised to Medium) — the "at most one live worker at all times" claim carries
   this demonstrated caveat. PID reuse resolves fail-closed (contender refuses; no unsafe steal).
5. **Journal binding / crash-window convergence** — verified by rerun (c4 mismatches on all three
   axes with journal state intact; c5/c6 forced crashes → begun-without-commit → convergent
   reissue; g2–g7 multiset graph equivalence 12/12 nodes + 12/12 edges, zero variant diffs, with
   negative controls). Proof exit-status gap = M1.
6. **Dataset deletion & distributability** — verified by rerun (c9: file-level purge receipt,
   typed post-delete failure, no journal record; limits as stated in §7.5). Bundled worker + guard
   are fault-free and self-resolving (V11); remaining packaging work (build step, `files`
   allowlist, packaging smoke test, `main: src/index.ts`) is correctly declared as **not done** in
   contract §11/§12 — packaging, not a runtime defect.