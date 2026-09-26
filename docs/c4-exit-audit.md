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

## Verdict: **C4 exit verified with non-blocking issues**

No blocking defect was found in the pack code, worker, guard, contracts, manifest, or the crash
convergence claims. All four focused suites were **rerun end-to-end by the auditor on this audit
day** and reproduce the committed evidence. The non-blocking issues below are evidence-tooling
gates, doc/code alignment, and narrow fail-closed availability edges — none breaks the
one-owner/no-effect-safety invariants the exit claims rest on.

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

### L1 (Low) — Stale-recovery restore path can overwrite a fresh live lock created in its gap
`pack/src/supervision.ts:325–326`: in the mismatch branch, `existsSync(lockPath)` is checked and
then `renameSync(trash, lockPath)` is executed — two non-atomic steps. Node's `renameSync`
**overwrites an existing destination** (demonstrated on this platform during the audit). A third
fresh instance acquiring during the gap (`acquireStoreOwnership`, supervision.ts:261 — the direct
`O_EXCL` path succeeds whenever the path is momentarily absent) can have its brand-new live lock
silently replaced by the restore rename. Consequence: the displaced freshest instance fail-closes
at its next `verifyOwnershipIntact` (supervision.ts:349–357, instanceId mismatch) **before any
spawn/dispatch** — the audited invariant "at most one live worker per store" is preserved; the
effect is a false eviction (availability), consistent with the residual already stated in the
exit report §4 risk 3. Verified by source + platform rename-overwrite demo; the end-to-end
interleaving was not empirically reproduced (window is microscopic and the verification-only delay
hook widens judgment→claim, not the restore gap). **Smallest correction:** restore via exclusive
create (`openSync(lockPath, 'wx')` writing the displaced bytes; on `EEXIST` skip the restore and
fail closed) so a fresh contender's lock can never be overwritten.

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
- The restore-race and mid-op displacement residuals are honestly documented (c4-exit-report §4.3).

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
   O7, stale-contender O8, foreign-host budget O9a–c). The pointed restore-gap question: a fresh
   live lock **can** be displaced in the `existsSync`→`renameSync` gap (L1), but no double-owner
   path exists because every owner re-verifies before spawn/dispatch and fails closed on loss.
   PID reuse resolves fail-closed (contender refuses; no unsafe steal).
5. **Journal binding / crash-window convergence** — verified by rerun (c4 mismatches on all three
   axes with journal state intact; c5/c6 forced crashes → begun-without-commit → convergent
   reissue; g2–g7 multiset graph equivalence 12/12 nodes + 12/12 edges, zero variant diffs, with
   negative controls). Proof exit-status gap = M1.
6. **Dataset deletion & distributability** — verified by rerun (c9: file-level purge receipt,
   typed post-delete failure, no journal record; limits as stated in §7.5). Bundled worker + guard
   are fault-free and self-resolving (V11); remaining packaging work (build step, `files`
   allowlist, packaging smoke test, `main: src/index.ts`) is correctly declared as **not done** in
   contract §11/§12 — packaging, not a runtime defect.