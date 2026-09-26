# C5 package readiness — independent audit report

**Auditor:** independent — this audit was performed by an agent with no shared session state
with the C5 implementation pass (and not the author of C0–C4).
**Audited commit:** `radz2291/VICT-Cognee` branch `c5/package-readiness` @
`03ef7649e380c930ae5bb85a9b38c03e58f60054`.
**Lineage verified:** `git merge-base HEAD 4860bbd9` = `4860bbd9ce3c815f51a21756eb95cef04106b27f`;
exactly two commits on top (`39d552e` Stage A — audit-finding closure + ownership release gate;
`03ef764` Stage B — installable unpublished package candidate); `origin/c5/package-readiness`
== local HEAD.
**C4 exit audit verified:** `9648c70e344ca694a5074c3e002d84b7e1d959e9` on
`audit/c4-exit-independent-audit` (M1, M2, L1→Medium, L2, L3, L4 + Info), an ancestor-built
branch off `4860bbd9`. All C5 Stage-A claims were cross-checked against that report's
findings and smallest-correction prescriptions.
**Read-only attestation:** the implementation branch working tree was left byte-identical
(`git status` clean before/after; verified `03ef764` unchanged). All builds, packs, installs,
suites and probes ran in a separate clone
(`Desktop/RZ/260925-VCT-Cognee-c5audit`, created for this audit) plus throwaway temp projects.
VICT (`260831-VCT-02`), Quellight, Trading OS, Stage 8: untouched. Nothing published; no
consumer integrated; no merge performed.

## Verdict: **C5 verified with non-blocking issues**

No runtime-safety defect was found. The C4-exit L1/Medium ownership overlap is closed by
design and by test; the C4-exit M1 proof-exit gap is closed and was re-proven by forced-fail
reruns on all four drivers; M2 (§9 doc alignment), L2 (ready-timeout strand), L3 (physical
store identity) and L4 (output contracts at the binding boundary) are closed as claimed; the
tarball is minimal, hook-free, repo-path-free, and its clean-install smoke through the real
VICT runtime reproduces (7/7, exit 0, from this audit's own `npm pack`). Two **Medium**
issues are packaging/release-hygiene, not safety: the declared peer range contradicts the
documented supported VICT version (stock `npm install` of the documented set fails with
ERESOLVE), and a source build is not reproducible from declared setup instructions alone
(undeclared TypeScript compiler). Both must be corrected before any publication, but the
candidate is `private: true` and unpublished, so neither blocks the C5 gate.

---

## 1. Ownership gate (mandate item 1)

**Confirmed: no automatic stale-lock removal remains.** Source assertion (independently
re-run, not trusted from O10): `pack/src/supervision.ts` contains exactly ONE `renameSync`
(line 390 — the owner's own heartbeat tmp→rename) and ONE `unlinkSync` (line 404 — owner's
orderly release); no `.recovering-` markers, no rename-aside, no `ownershipRecoveryDelayMs`.

Challenged point by point:

- **Creation** — only via `openSync(path, 'wx')` (`createLockAtomically`,
  supervision.ts:267–278); `acquireStoreOwnership` (supervision.ts:285–303) refuses whenever
  the path exists at all (even unreadable) with `COGNEE_STORE_OWNED`.
- **Heartbeat replacement** — `refreshOwnershipHeartbeat` (supervision.ts:381–391) verifies
  the lock still carries THIS instance's id, then atomically replaces its OWN lock
  (tmp→`renameSync`). Per-op + interval (`staleMs/3`, floor 1 s) during in-flight ops
  (O9c rerun PASS: heartbeat advanced during a 4 s op; mid-op contender refused).
- **Loss detection** — `verifyOwnershipIntact` (supervision.ts:347–371) before spawn AND
  immediately before dispatch; in-flight loss completes the real op, then kills + poisons at
  settlement; loss with NO op in flight kills the idle worker immediately (no orphan).
  O2b/O6 rerun PASS (replaced/removed lock ⇒ sticky fail-closed, zero spawns/dispatches).
- **Shutdown** — `releaseStoreOwnership` (supervision.ts:396–407) never deletes a foreign
  owner's lock (rec mismatch ⇒ no-op). See finding L-1 for the unreadable-lock edge.
- **Operator recovery** — §8.1 in `docs/c3-pack-contract.md` is complete (stop → verify pid
  dead → verify no `cognee_worker.py --store-root <root>` process → delete lock → re-create)
  and the refusal error embeds the owner record + liveness assessment + the §8.1 pointer.
  O4 rerun PASS: dead-pid lock refused, bytes untouched, no auto-recovery; after the operator
  step a new instance acquires cleanly.
- **Canonical roots** — `realpathSync` at construction (supervision.ts:178–183) so every
  spelling of one store maps to ONE lock (L3 closed); a store root nested INSIDE a locked
  store root is refused at construction (ancestor scan, supervision.ts:308–333); the
  OUTER-root-over-active-INNER case is deliberately not auto-detected and is documented as
  unsupported (contract §8 — surfaced as typed ladybug/sqlite contention at op time). Docs
  match code.
- **The auditor's three-process overlap revisited against C5:** the interleaving cannot be
  driven by pack code anymore — the recovery thread (B) no longer exists. O10 rerun PASS in
  this audit's clone: while A runs a 4 s op, contender roles B and C BOTH refuse pre-spawn
  (nothing dispatched, lock bytes intact, A's `opsServed === 1`, `spawns === 1`). The
  residual exposure is reduced to a µs-scale TOCTOU inside `refreshOwnershipHeartbeat`
  (verify-read at :383 then unconditional rename at :390): a fresh acquire could only
  interleave there if an actor removed the owner's lock in that window — i.e. an §8.1
  procedure violation, not any pack code path (recorded as Info-1, not a defect in the
  shipped logic; worth one residual sentence in the contract).

## 2. Proof gates (mandate item 2)

- **Exit coupling, rerun by this audit** (`C5_FORCED_FAIL=1`, fresh clone):
  `worker/proof_c4.mjs` → exit **1**; `worker/graph_equiv_c4.mjs` → exit **1**;
  `pack/verify/verify.ts` → exit **1**; `pack/verify/ownership-verify.ts` → exit **1**;
  each JSON records `forcedFail: true`. Gate sites: proof_c4.mjs:437, graph_equiv_c4.mjs:327,
  verify.ts:823, ownership-verify.ts:556.
- **Unexpected worker errors cannot count as the allowed observation:** `proof_c4.mjs`
  downgrades out-of-`expectError` worker failures to `AGENT-OBSERVATION`
  (proof_c4.mjs:150–153), and its gate is `outcome !== 'PASS' ⇒ exit 1` — an
  AGENT-OBSERVATION fails the run. The ONLY non-PASS outcome that stays green anywhere is
  `EXPECTED-OBSERVATION` in `verify.ts` (single emitter, verify.ts:372–376 — the documented
  UV-1 durable-engine fact), and verify.ts's gate regex `/^(PASS|EXPECTED-OBSERVATION)$/`
  admits nothing else. Confirmed by source reading of both emitters and gates.
- **Ready-timeout recovery without an orphan:** V10g rerun PASS (verify.ts:716) — ready-budget
  expiry fails `COGNEE_WORKER_UNAVAILABLE`, kills ≥ 1, and the next request recovers via a
  FRESH spawn (`spawns === 2`, fresh stub `servedOps === 1`). The lifecycle handlers are
  scoped to their spawned `proc` (supervision.ts:425–427, 476–480), closing the late-exit
  race V10g exposed.
- Green reruns in this audit: ownership-verify.ts **16/16 PASS exit 0** (28 s);
  verify.ts **27 PASS + 1 EXPECTED-OBSERVATION, exit 0** (120 s). The full
  proof_c4.mjs / graph_equiv_c4.mjs batteries were NOT re-run end-to-end by this audit
  (focused-review scope); their committed Stage-A JSONs are fresh (same day, 32/32 and 8/8,
  no non-PASS outcomes) and their exit gates were proven by the forced-fail reruns above —
  classified as rerun-evidence-not-repeated, not as verified-by-this-audit.

## 3. Build reproducibility (mandate item 3) — classified separately from tarball install

**A source build is NOT reproducible from a fresh checkout using declared setup instructions
alone.**

Demonstrated in this audit's fresh clone @ `03ef764`:

1. `node pack/scripts/build.mjs` with the sibling VICT clone present → **exit 0** (17 files).
2. `C5_VICT_HOME=<nonexistent>` (no sibling, no `C5_TSC`) → **exit 1**
   ("TypeScript compiler not found", pack/scripts/build.mjs:34–43).
3. `cd pack && npm install` → installs **0 packages**: `pack/package.json` declares no
   `dependencies`, no `devDependencies`, no `typescript` anywhere; there is no root
   package.json.
4. `pack/README.md` (the artifact's own setup doc) contains **no build-from-source section
   at all** — the only mention of the compiler reliance is prose in
   `docs/c5-readiness-report.md:140–141`, which is a report, not setup instructions.

Root cause: the build's compiler discovery depends on an undeclared sibling checkout
(`../260831-VCT-02`) or an environment variable (`C5_TSC`) that no setup document specifies,
instead of a devDependency.

**Classification (per mandate):** this is distinct from tarball installability — the shipped
dist is complete and the tarball installs (see §4). It blocks *source-build reproducibility*
only. Smallest correction: add `"devDependencies": { "typescript": "^5.6.0" }` to
`pack/package.json` (build.mjs first tries `pack/node_modules/typescript/bin/tsc`), plus a
short "Build from source" section in `pack/README.md`. Non-blocking while the package is a
private proof artifact; blocking before publication.

## 4. Tarball and clean install (mandate item 4)

- **Fresh `npm pack`** from this audit's own build: **19 files**, exactly matching
  `docs/c5-evidence/tarball-contents.txt`; extracted content is byte-identical (modulo
  CRLF/LF checkout churn) to the implementer's working-tree tarball.
- **Exports/declarations:** `main`/`exports` → `./dist/index.js`, `types` →
  `./dist/index.d.ts`; 5 `.d.ts` + 5 `.js.map` shipped; the smoke imported
  `createCogneePack`/`WorkerError` from the installed package successfully.
- **Bundled worker + guard:** `dist/worker/cognee_worker.py` +
  `dist/worker/guard_store_roots.py` present; worker default path resolves against the
  compiled module (`import.meta.url`, shipped supervision.js:68) — no repo-relative runtime
  path. The two repo-string hits in shipped files are comments only (supervision.js:66,
  guard_store_roots.py:4); build.mjs's own assertion correctly strips comments before
  checking.
- **Proof hooks absent:** grep over all shipped `.js`/`.py`/`.json`: zero hits for
  `C4_PROOF_FAULT` / `C5_FORCED_FAIL` / `STUB_` (the README sentence is the only mention).
- **Dependency metadata:** no runtime dependencies; `engines.node >=22`; `private: true`
  (npm refuses publish); peer range issue → finding **M-1** below.
- **Clean install (this audit, throwaway temp project):** installing the documented set
  (cognee tarball + `@victframework/sdk@0.3.1` + `@victframework/runtime@0.3.1` via `file:`)
  FAILS on stock npm with **ERESOLVE** (see M-1). With `--legacy-peer-deps` the install
  succeeds with no registry access, and the committed smoke script runs **7/7 PASS, exit 0**
  through the REAL worker on a disposable store (manifest validation, bundled-worker
  resolution inside `node_modules`, durable keyed add+cognify, scoped search, ownership
  refusal + release, hook absence). Note: the implementer's `docs/c5-evidence/smoke-run.log`
  contains **no install output** — the smooth `npm install` quoted in the readiness report
  is an unevidenced claim on this host (it did not reproduce with default flags).

### M-1 (Medium — packaging metadata) — peer range contradicts the documented supported VICT version
`pack/package.json:22–25` declares `"peerDependencies": { "@victframework/sdk": "^0.1.0",
"@victframework/runtime": "^0.1.0" }`, but `pack/README.md` names `sdk@0.3.1` /
`runtime@0.3.1` as the supported (and smoke-tested) versions. `^0.1.0` does not match 0.3.1
(caret on 0.x pins <0.2.0), and npm ≥ 7 enforces optional peers that are present:
`npm install` of the documented dependency set exits 2 with ERESOLVE ("peerOptional
@victframework/runtime@"^0.1.0" from @victframework/cognee … Found
@victframework/runtime@0.3.1"). **Smallest correction:** widen the ranges to cover the
supported line (e.g. `">=0.1.0 <1"` or `"^0.1.0 || ^0.3.x"`), re-run the smoke with default
flags, and commit the install output into `docs/c5-evidence/`. Non-blocking while
unpublished; must be fixed before any consumer install path is documented as supported.

## 5. Runtime boundary (mandate item 5) — probed against the INSTALLED artifact

A 9-assertion probe (`docs/audit-evidence-c5/installed-probe.mjs`) ran against
`node_modules/@victframework/cognee` in the throwaway project (real worker, disposable
store): **9/9 PASS, exit 0**.

- P1 manifest validates via the installed SDK; six capabilities; forgetDataset declares
  irreversible. P2 mode='test' → `COGNEE_MODE_REFUSED` pre-spawn. P3 unkeyed mutating add →
  refused pre-spawn (no unkeyed writes). P4 expired `ctx.deadlineAt` →
  `COGNEE_DEADLINE_EXCEEDED` before dispatch (nothing sent; no fresh-timeout re-arm).
- P5 `outside.vault` (ungranted namespace) → `COGNEE_SCOPE_REJECTED` from the real worker.
  P6 keyed add → contract-conform receipt (datasetName/idempotencyKey/reconciled/itemsAfter/
  deduplicated). P7 cognify → scoped search returns only `qa.*` datasets. (An uncognified
  dataset search correctly fails typed `COGNEE_DATASET_UNKNOWN` — observed and accepted as
  correct behavior.) P8 forgetDataset in mode='simulate' → `COGNEE_MODE_REFUSED` (deletion
  gated; the runtime-side irreversible deny is additionally exercised by verify.ts V9d).
  P9 second instance refuses `COGNEE_STORE_OWNED` pre-spawn; shutdown releases the lock.
- Worker lifecycle beyond the probe: V10g (ready-timeout kill + fresh respawn) rerun PASS;
  ownership suite O1–O10 rerun PASS.
- Output contracts at the boundary (L4): `COGNEE_OUTPUT_CONTRACT` /
  `parseOutput` present in shipped `dist/bindings.js` and applied to real handlers AND
  doubles (source-verified; a live malformed-receipt injection is not possible from the
  shipped, hook-free worker — correctly so).
- **Docs vs tested platform:** `pack/README.md` requirements match the audited host
  (Node v22.13.1 Windows 11 x64; Python 3.12.10 venv with cognee 1.6.1 passed as
  `pythonPath`; keyless fastembed/gliner models; ~2.0 GB cognify peak; §8.1 procedure in the
  contract). README's "resolves its OWN bundled worker … no repository paths, no
  TypeScript/tsx runtime, no test fault hooks" is accurate for the shipped artifact.

## Additional findings (severity order)

### L-1 (Low) — `releaseStoreOwnership` deletes a lock it could not attribute
`pack/src/supervision.ts:396–407`: after the foreign-owner guard, `rec === null` (torn,
empty, or unreadable lock — e.g. a crash between a contender's `openSync('wx')` and its
first write, or a read racing a fresh create) falls through to `unlinkSync` at :404. In a
sub-millisecond interleaving (contender creates the lock exactly between `readOwner()` and
`unlinkSync` during this instance's shutdown), the fresh owner's lock is deleted and its
subsequent write lands on an unlinked fd — the store then appears free while the contender
believes it owns it. The doc comment ("Deletes the lock ONLY if it still carries THIS
instance's id") overstates the guard. **Smallest correction:** change the guard to
`if (!rec || rec.instanceId !== this.instanceId) { …no delete… }` — an unattributable lock
is operator-recovery territory (§8.1), which is the fail-closed direction this release
chose. No unsafe steady-state behavior; extremely narrow window; non-blocking.

### L-2 (Low — packaging hygiene) — `npm pack` without a prior build silently ships a 2-file tarball
Observed during this audit: with `pack/dist/` absent (e.g. after a clean clone),
`npm pack` produces a tarball containing only `README.md` + `package.json` — no error, no
warning (there is no `prepack` script and no files-existence assertion). **Smallest
correction:** add `"prepack": "node -e \"if(!require('fs').existsSync('dist/index.js'))
{console.error('run npm run build first');process.exit(1)}\""` (or fold the check into
`pack:check`). Non-blocking (the committed evidence tarball is complete).

### Info-1 — heartbeat verify→rename TOCTOU residual
`refreshOwnershipHeartbeat` (supervision.ts:381–391) reads+validates the lock and then
renames unconditionally; a fresh acquire can only interleave if an actor removed the
owner's lock inside the µs-scale gap — i.e. an §8.1 procedure violation, never a pack code
path. Suggest one residual sentence in contract §8.1/§4 so the exclusivity claim is stated
with its operator-compliance precondition. No code change required.

### Info-2 — shipped `package.json` `scripts` reference paths that are not shipped
(`scripts/build.mjs`, `verify/*.ts`, `../../worker/*.mjs`). Harmless (npm ignores them;
running them from an installed copy fails loudly), but `npm pkg` consumers may trip.
Cosmetic.

### Info-3 — the readiness report's smoke install output is not in the committed evidence
`docs/c5-evidence/smoke-run.log` starts at S1; the `npm install` invocation and its output
("added 6 packages…") quoted in `docs/c5-readiness-report.md` are not in the log, and the
default-flag install does not reproduce (see M-1). Fold the install into the committed log
when M-1 is corrected.

## Verification summary (what this audit itself ran)

| Check | Result |
| --- | --- |
| Lineage: HEAD == origin @ `03ef764`; merge-base == `4860bbd9`; C4 audit @ `9648c70` on its own branch | verified |
| ownership-verify.ts (fresh clone; incl. O10 three-process regression, O4 no-auto-recovery) | **16/16 PASS, exit 0** (28 s) |
| verify.ts (real runtime; V10g ready-timeout kill+respawn; single EXPECTED-OBSERVATION) | **27 PASS + 1 EXPECTED-OBSERVATION, exit 0** (120 s) |
| Forced-fail exit coupling ×4 drivers (`C5_FORCED_FAIL=1`) | **exit 1 each**, `forcedFail` recorded |
| Build with sibling VICT / with neither sibling nor `C5_TSC` | exit 0 / **exit 1** (M-2 evidence) |
| `npm install` inside `pack/` | 0 packages (no compiler declared) |
| Fresh `npm pack` vs committed evidence list / implementer tarball | 19 files exact; content-identical modulo line endings |
| Hook grep + repo-path grep over shipped files | 0 hooks; comment-only path mentions |
| Documented clean install, stock npm | **ERESOLVE exit 2** (M-1 evidence) |
| Clean install with `--legacy-peer-deps` + smoke through real VICT runtime | **7/7 PASS, exit 0** |
| Installed-artifact boundary probe (mode/key/deadline/scope/receipt/search/forget/ownership) | **9/9 PASS, exit 0** |
| Implementation branch untouched | `git status` clean; HEAD `03ef764` before/after |

**Not re-run by this audit** (classified, per focused-review scope): the full
`proof_c4.mjs` (32/32) and `graph_equiv_c4.mjs` (8/8) batteries — committed Stage-A JSONs
are same-day and their exit gates were proven by forced-fail; cross-platform (macOS/Linux)
behavior — untested and unclaimed by the implementation, correctly; fresh-host model
downloads — documented, not exercised.

## Stop

Per the C5 mandate this audit stops at the verdict. No implementation changes were made; no
merge, publish, or Quellight/Trading-OS integration was performed. The audit branch
`audit/c5-package-readiness` carries only this report and this audit's evidence files.
