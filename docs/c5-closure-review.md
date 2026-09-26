# C5 closure review — independent review of the audit-closure delta

**Reviewer:** independent — this review was performed by an agent with no shared session
state with the C5 closure implementation (and not the author of the closure commit, the
original C5 audit, or C0–C4). This review is NOT the implementation agent.
**Audited delta:** `radz2291/VICT-Cognee` branch `c5/package-readiness`
`03ef7649e380c930ae5bb85a9b38c03e58f60054` → `35095331b23098f3c0287e43235b831cbf1c85e8`
(single closure commit `3509533`, parent = `03ef764`; `origin/c5/package-readiness` ==
`3509533`). Exactly **13 files** changed (373 insertions, 85 deletions):
`.gitignore`, `docs/c3-pack-contract.md`, `docs/c5-evidence/closure-checks.log`,
`docs/c5-evidence/closure-install.log`, `docs/c5-readiness-report.md`, `pack/README.md`,
`pack/package-lock.json` (new), `pack/package.json`, `pack/scripts/build.mjs`,
`pack/src/supervision.ts`, `pack/verify/ownership-verify.ts`,
`worker/c4-ownership-results.json`, `worker/c4-verify-results.json`.
**Original audit read:** `audit/c5-package-readiness` @ `931bd7a` (`docs/c5-package-audit.md`)
before any review step; every closure claim below is checked against that report's findings
M-1, M-2, L-1, L-2, Info-1, Info-2, Info-3.
**Read-only attestation:** the implementation working tree
(`C:/Users/RZ1/Desktop/RZ/260925-VCT-Cognee`, branch `c5/package-readiness` @ `3509533`)
was left untouched — all builds, packs, installs and suites ran in a fresh clone created
for this review (`260925-VCT-Cognee-c5closure-review`, checked out at `3509533`, branch
`audit/c5-closure-review` created only there) plus throwaway `%TEMP%` projects. The venv
used for real-runtime runs is a robocopy of the proof venv into the review clone; the
original was only read. VICT (`260831-VCT-02`), Quellight, Trading OS, Stage 8: untouched.
Nothing published; no consumer integrated; no merge performed. `main` untouched.

---

## Verdict: **C5 closure VERIFIED — all audited findings closed as claimed; one new non-blocking Low finding (V10f test robustness)**

No runtime-safety defect was introduced by the delta. Every claim in the closure pass was
re-executed independently and reproduced (see §6 evidence table). The delta touches only
the ownership **release** path (`pack/src/supervision.ts:398–411`), packaging metadata and
documentation — no dispatch, deadline, or recovery code path changed.

---

## 1. npm peers `^0.3.1` vs manifest ABI `victCompatibility: ^0.1.0` (audit M-1) — **closed**

- `pack/package.json` peers are now `@victframework/sdk`/`@victframework/runtime`
  `^0.3.1` (both `optional`), matching the tested npm packages (`packages/sdk` and
  `packages/runtime` in the VICT clone are both `0.3.1`, which `^0.3.1` admits).
- The shipped manifest is UNCHANGED as an ABI document: `dist/manifest.js:31` carries
  `victCompatibility: '^0.1.0'` (schema `vict.capability-pack@1`), and
  `pack/README.md:19–21` documents the separation: npm peer ranges = tested npm packages;
  `victCompatibility` = capability-pack ABI contract version (manifest schema generation).
  This separation is conceptually sound: the manifest is validated against a pack-schema
  ABI, not against npm semver of the peer packages.
- **Pristine install (reviewer, stock npm):** new `%TEMP%` project, no lockfile, no
  node_modules, `npm install --no-audit --no-fund` with the reviewer's own `npm pack`
  tarball (19 files, peers `^0.3.1`) + VICT `0.3.1` via `file:` + `zod ^3.25.0` —
  **exit 0, "added 4 packages"** with NO `--legacy-peer-deps`, NO overrides.
  Matches the committed `docs/c5-evidence/closure-install.log` ("added 4 packages",
  exit 0, stock npm 10.9.2 / node v22.13.1 — same host versions as this review).
- Smoke through the REAL VICT runtime on the installed package (reviewer rerun of
  `docs/c5-evidence/smoke.mjs`, PY pointed at the review clone's venv copy):
  **S1–S6, 7/7 PASS, exit 0**. Installed-artifact boundary probe (audit branch's
  `installed-probe.mjs`): **P1–P9, 9/9 PASS, exit 0**. Bundled worker + guard resolve
  inside `node_modules/@victframework/cognee/dist/worker/`; no fault hooks
  (`C4_PROOF_FAULT`/`C5_FORCED_FAIL`/`STUB_` absent from all shipped files).

## 2. Fresh-checkout build + pack from declared setup (audit M-2, L-2) — **closed**

Ran in the fresh review clone, only documented commands and declared dependencies:

- `cd pack && npm install --no-audit --no-fund` → **exit 0, "added 3 packages"** —
  `typescript@6.0.3`, `@types/node@22.20.4` (+`undici-types`) resolved from the registry;
  `pack/package-lock.json` (new, lockfileVersion 3) records them as `dev: true` with
  integrity hashes. `pack/package.json` declares `devDependencies` exactly as the audit's
  smallest-correction prescription required.
- `C5_VICT_HOME=Z:/definitely-nonexistent npm run build` → **exit 0** (tsc strict clean;
  17 dist files incl. `worker/cognee_worker.py` + `guard_store_roots.py`) — **no sibling
  VICT clone, no `C5_TSC`, no compiler override**. `build.mjs:34–46` now prefers
  `pack/node_modules/typescript/bin/tsc`; `@types/node` is discovered automatically
  (the old sibling-derived `typeRoots` fallback was removed; `C5_TYPES_ROOTS` remains an
  optional explicit override). Env overrides are documented as optional dev conveniences.
- `npm pack` (dist present) → **19 files**, byte-set identical to
  `docs/c5-evidence/tarball-contents.txt` (prefix `package/` only).
- **dist-absent, scripts enabled:** `mv dist … && npm pack` → `prepack` rebuilds →
  19 files, exit 0. **dist-absent, no toolchain:** with `pack/node_modules` absent the
  prepack build fails → `npm pack` **fails clearly, exit 1** (build error surfaced) —
  it does not ship an incomplete tarball.
- **`npm pack --ignore-scripts` with dist absent:** exit 0 with **2 files only**
  (`README.md`, `package.json`) — reproduced exactly as recorded in
  `docs/c5-evidence/closure-checks.log`. The README (`pack/README.md:80–84`) documents
  this case as **VOID, not covered** ("verify dist/ presence when scripts are disabled").
  This limitation is accurately recorded: it is inherent to npm lifecycle disabling (no
  script of the package can run), and the shipped `files` allowlist cannot compensate.
  Recorded limitation is accurate as documented.

## 3. `releaseStoreOwnership()` precision (audit L-1) + O11 — **closed**

- Source: `pack/src/supervision.ts:398–411`. The guard is now
  `if (!rec || rec.instanceId !== this.instanceId) { …no delete… }` — a missing,
  torn/corrupt (JSON-parse failure in `readOwner()`, :214–233 → `rec: null`), or foreign
  lock is left untouched with a diagnostic naming §8.1; only a READABLE, MATCHING owner
  record is deleted (`unlinkSync` at :408). This is exactly the audit's smallest
  correction; the fail-closed direction is preserved (an unattributable lock becomes
  operator-recovery territory, never auto-deleted).
- **O11 rerun (reviewer):** full ownership suite via tsx → **17/17 PASS, exit 0 (27 s)**;
  O11 PASS with `{corruptLeft: true, foreignLeft: true, ownDeleted: true}` — corrupt and
  foreign lock bytes left byte-identical, own readable record deleted (positive control).
- **Orderly release not broken:** O3b PASS (orderly shutdown releases ownership, lock
  gone), O3c PASS (fresh instance re-acquires), O10 PASS (three-process interleaving
  still closed), O5 PASS. The committed `worker/c4-ownership-results.json` (17 results,
  O11 PASS, 31 s) matches the rerun.
- Heartbeat path untouched: `refreshOwnershipHeartbeat` still verifies-then-renames its
  OWN lock only (supervision.ts:384–390; exactly one `renameSync` at :390 in the file —
  the source assertion in O10 still holds).

## 4. README / contract / shipped scripts vs the installed tarball — **consistent**

- **Consumer scripts:** the installed `package.json` carries only `build`, `prepack`,
  `pack:check` (repo-only verify/proof entries removed — Info-2 closed). Running
  `npm run build` or `npm pack --dry-run` inside `node_modules/@victframework/cognee`
  **fails loudly (exit 1)** — no `scripts/build.mjs` shipped — exactly as
  `pack/README.md:75–79` states ("a tarball consumer runs NOTHING from the package
  scripts… run inside node_modules they fail loudly").
- **Build-from-source section** (`pack/README.md:86–96`) matches observed behavior
  (`npm install && npm run build` from a fresh clone; overrides optional; repo-only
  verify commands explicitly labeled as needing the source tree + VICT clone + venv).
- **Ownership limits section** (`pack/README.md:98–113`) matches code: no auto stale-lock
  recovery; heartbeat is liveness-only; release deletes ONLY a readable matching record
  (= closure L-1); nested-inner refused, outer-over-inner not auto-detected.
- **Contract** (`docs/c3-pack-contract.md:524–537`): the "Release deletion precision"
  bullet matches the implemented guard exactly; the documented heartbeat verify→rename
  residual (µs-scale window, operator-compliance precondition, supervision.ts:385–390)
  matches Info-1 of the original audit — documentation only, no code change required,
  none made.
- **Requirements** match the tested platform (Node v22.13.1, Python 3.12.10 venv with
  cognee 1.6.1 — confirmed in the review venv copy — fastembed/gliner keyless).

## 5. V10f timing-sensitive result — **flaky verification assertion, NOT a runtime behavior problem**

**Claimed result:** `docs/c5-evidence/closure-checks.log` — verify.ts run 1: V10f(read)
FAIL with `COGNEE_DEADLINE_EXCEEDED` instead of `CLIENT_DEADLINE` ("slow_read respawn
consumed >550ms of the 800ms budget; remaining < 250ms margin → pre-dispatch refusal");
run 2 clean (`remainingMs=368`). The committed `worker/c4-verify-results.json` @
`3509533` is the clean run (both V10f legs PASS, started 07:55:39Z, 119 s).

**Mechanism (code-verified, deterministic in structure):** the V10f mutation leg
(`slow_mutation`, `deadlineAt = now+800`, stub replies after 3 s) times out and —
because it is `mutating: true` — sets `poisoned = true` (supervision.ts:640). The
subsequent read leg (`slow_read`, `deadlineAt = now+800`, verify.ts:773–780) therefore
ALWAYS takes the respawn path in `_lifecycle` (supervision.ts:559–571: SIGKILL + a fixed
300 ms delay + fresh spawn + ready handshake) BEFORE dispatch, because the absolute
deadline is computed *before* `_lifecycle` runs (supervision.ts:595→602). The respawn
cost comes out of the 800 ms budget, and the pre-dispatch margin check requires
remaining > `MIN_DISPATCH_REMAINING_MS` = 250 ms (supervision.ts:59, 607–613) — i.e. the
assertion only holds when the kill+respawn+handshake completes within ~550 ms.

**Why it is a test problem, not a runtime problem:**

1. Both observed outcomes are correct, typed, and fail-safe. Pre-dispatch refusal
   (`COGNEE_DEADLINE_EXCEEDED`) guarantees "NO effect, nothing was sent"
   (supervision.ts:608–612); post-dispatch expiry on a READ yields a clean typed
   `CLIENT_DEADLINE` anchored to the absolute deadline (supervision.ts:647–653). Neither
   can have any store effect (non-mutating), and the mutating leg's UNKNOWN outcome is
   correctly conservative. No data-integrity or safety divergence exists between the two
   outcomes.
2. The assertion (`verify.ts:772–781`) claims "deadline expiring AFTER a READ was
   dispatched" but does not control or verify its dispatch precondition — the dispatch
   itself is contingent on respawn speed on the host. It is a timing-sensitive assertion
   with an uncontrolled precondition.
3. The delta did not touch dispatch/deadline code (`git diff 03ef764..3509533` —
   supervision.ts changes are confined to the release path; verify.ts unchanged), so it
   cannot be a delta regression.
4. Reproduction evidence: the implementer's run 1 (fail: respawn > 550 ms), run 2 (clean,
   `remainingMs=368`), and this review's fresh run — **27 PASS + 1 EXPECTED-OBSERVATION,
   exit 0 (97 s)**, with the read leg dispatched at `remainingMs=416` → `CLIENT_DEADLINE`
   PASS. Three runs on one host straddle the margin exactly as the mechanism predicts.

**Classification: Low, verification-only.** The implementer's classification
("environmental variance around the 250 ms margin, not a delta regression") is accurate.
Recommended (non-blocking, for a future pass — NOT part of this review's implementation):
make V10f(read) deterministic by dispatching on a known-ready worker (separate instance
from the mutation leg) or by accepting both typed outcomes with the dispatch precondition
explicitly recorded in the assertion detail. No runtime change is warranted — the
pre-dispatch margin is the documented fail-safe behavior (§7.2).

## 6. Reviewer evidence (all rerun independently on the corrected tree)

| Check | Reviewer result | Matches committed evidence |
| --- | --- | --- |
| Lineage: `3509533` == origin tip, parent `03ef764`, 13 files | verified | ✓ |
| Stock `npm install` (pristine, tarball + VICT 0.3.1) | **exit 0, "added 4 packages"** | `closure-install.log` ✓ |
| `npm install` in `pack/` (declared devDeps only) | exit 0, added 3 (ts 6.0.3, @types/node 22.20.4) | `closure-checks.log` ✓ |
| Build, `C5_VICT_HOME` nonexistent, no `C5_TSC` | **exit 0**, 17 dist files | ✓ (M-2) |
| `npm pack` (dist present) | **19 files**, == committed tarball-contents.txt | ✓ |
| `npm pack` dist-absent, scripts enabled | prepack rebuilds → 19 files, exit 0 | ✓ |
| `npm pack` dist-absent, no toolchain | **fails clearly, exit 1** | ✓ (README claim) |
| `npm pack --ignore-scripts` dist-absent | exit 0, **2 files** (VOID, documented) | ✓ (L-2 recorded) |
| ownership-verify.ts (incl. O11) | **17/17 PASS, exit 0 (27 s)**; O3b/O3c orderly release intact | ✓ |
| verify.ts (real runtime) | **27 PASS + 1 EXPECTED-OBSERVATION, exit 0 (97 s)**; V10f read dispatched at remainingMs=416 | ✓ |
| Clean-install smoke (real VICT runtime) | **7/7 PASS, exit 0** | ✓ |
| Installed-artifact probe | **9/9 PASS, exit 0** | ✓ |
| Hook grep over shipped files | 0 hits (`C4_PROOF_FAULT`/`C5_FORCED_FAIL`/`STUB_`) | ✓ |
| Installed-copy `npm run build` / `npm pack --dry-run` | fail loudly (exit 1) | README claim ✓ |

**Not re-run by this review** (consistent with the closure's own justification): the
`proof_c4.mjs` (32/32) and `graph_equiv_c4.mjs` (8/8) batteries — the delta touches only
the release path, not the dispatch paths those batteries exercise; the real-worker
write/search paths are re-proven by smoke S3/S4 and probe P6/P7 on the corrected
artifact. Cross-platform behavior remains untested and unclaimed (as before).

## 7. Findings by severity (of this delta)

- **Low (verification-only) — V10f(read) timing-sensitive assertion** (§5 above):
  `pack/verify/verify.ts:772–780` + `pack/src/supervision.ts:59, 559–571, 595–613, 640`.
  Flaky assertion with an uncontrolled dispatch precondition; both runtime outcomes are
  fail-safe and typed. Not a C5 closure defect; harden in a future verification pass.
- **No Medium or High findings.** No new runtime-safety issues introduced by the delta.

## 8. C5 closure verdict

**Verified.** The closure commit `3509533` closes all findings it claims:
M-1 (peers `^0.3.1`, stock-install proof committed and reproduced), M-2 (declared
TypeScript toolchain; fresh-clone build proven; env overrides demoted to optional), L-1
(release deletes only a readable matching owner record; O11 added and passing; orderly
release intact), L-2 (`prepack` completeness gate; both failure/success branches
confirmed; `--ignore-scripts` VOID case recorded accurately), Info-2/Info-3 (shipped
scripts aligned; install output committed as evidence). The ABI `victCompatibility:
^0.1.0` is correctly preserved and documented as conceptually separate from npm peer
ranges. The package remains `private: true`, unpublished, hook-free, and complete in the
tarball. The single new Low finding does not affect the closure verdict. Preconditions
carried over from the original audit remain: block on M-1-class metadata only if any
publication is attempted (not in scope here).

## Stop

Per the review mandate this review stops here: report committed and pushed on
`audit/c5-closure-review` only. No implementation changes, no merge to `main`, no
publication, no consumer integration; VICT, Quellight, Trading OS, Stage 8, and the
implementation branch untouched.