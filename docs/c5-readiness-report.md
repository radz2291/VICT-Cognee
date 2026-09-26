# C5 — package readiness report

**Base:** `radz2291/VICT-Cognee` @ `4860bbd9ce3c815f51a21756eb95cef04106b27f` (`main` ==
`origin/main`, verified before editing; working tree clean).
**Input:** the independent C4-exit audit at branch `audit/c4-exit-independent-audit`
@ `9648c70e344ca694a5074c3e002d84b7e1d959e9` (findings M1, M2, L1→Medium, L2, L3, L4 + Info).
**Read-only, untouched:** VICT (`260831-VCT-02` clone + ABI ref `5ea0afe2`), Quellight,
Trading OS, Stage 8. **Nothing published; no consumer integrated** (the smoke project is a
throwaway under the host temp dir; the package is `private: true` so `npm publish` refuses).
**Two commits:** Stage A (audit findings + ownership release gate) and Stage B (installable,
unpublished package candidate). Branch: `c5/package-readiness`.

---

## Stage A — close the audit findings

### A1. Ownership protocol: fail-closed, no automatic stale recovery (audit L1/Medium)

The audit's deterministic three-process interleaving showed that ANY recovery that moves a lock
out of its path opens a window in which the store has no lock while the previous owner may still
be operating — a fresh instance can acquire AND dispatch, and the two run concurrent operations
until the displaced side's next in-flight heartbeat/settlement. An `openSync('wx')` restore
cannot close a window that opened at move time, and rename-REPLACE schemes cannot be proven
atomic on the supported Windows host (AV/filter drivers) while still being able to displace a
fresh owner whose op is in flight. **Decision: prefer the simple fail-closed design** (as the
task brief allows).

New protocol (all in `pack/src/supervision.ts`):
- the lock is created ONLY via the atomic `O_EXCL` (`'wx'`) create;
- it is replaced ONLY by its owner's heartbeat (atomic tmp→`renameSync` of its OWN lock);
- it is deleted ONLY by its owner's orderly release, or by an explicit OPERATOR action;
- a contender REFUSES on ANY existing lock — live or stale — with `COGNEE_STORE_OWNED`, the
  owner record (instance/pid/host/user/startedAt), a liveness assessment ("IS STILL RUNNING" /
  "NOT running" / foreign-host), and the §8.1 operator recovery steps in the message;
- NO `ownershipRecoveryDelayMs` hook, no rename-aside, no restore (source assertion O10: the
  supervision contains exactly ONE `renameSync` — the heartbeat replace — and no `.recovering-`
  markers);
- ownership loss with NO op in flight now kills the idle worker immediately (audit L1 secondary
  orphan facet); an in-flight op still completes (outcome real) and kills+poisons at settlement.

**Operator recovery of a stale lock** is documented in `docs/c3-pack-contract.md` **§8.1**:
(1) stop the owning process (and every process that could own the store);
(2) verify the owner pid is stopped (`Get-Process -Id <pid>` fails / foreign host: coordinate —
a stale heartbeat is an indication, never a proof);
(3) verify no worker still serves the store
(`Get-CimInstance Win32_Process | Where-Object CommandLine -match 'cognee_worker.py'` — the
worker command line carries `--store-root <storeRoot>`);
(4) delete `cognee-store-owner.lock` (+ stale `.tmp-*` heartbeat leftovers);
(5) re-create the pack instance (acquires cleanly via `O_EXCL`).

**Tests** (`pack/verify/ownership-verify.ts`, rewritten; fresh disposable stores):
- **O10** replays the auditor's exact interleaving against the new protocol: A operates with a
  4 s op in flight; contender roles B and C both refuse pre-spawn (nothing dispatched, lock
  bytes intact); plus the source assertion above. **The acceptance condition — no concurrent
  operations on one physical store, including during recovery — holds for every code path.**
- **O4** ordinary crash/restart: a crafted dead-pid lock is REFUSED (never auto-recovered; bytes
  untouched; owner record + "NOT running" + §8.1 steps in the message); after the operator step
  (harness verified the pid is dead, then deletes the lock) a new instance acquires cleanly.
- O7a/O7b: two contenders vs a stale lock BOTH refuse (lock untouched); after operator recovery
  two fresh contenders race for the FREE store — exactly one wins `O_EXCL`.
- O8: contender vs a fresh LIVE lock refuses; bytes unchanged; owner keeps holding.
- O9a/O9b: foreign-host fresh AND stale heartbeats are refused (no auto-recovery; foreign host
  named; procedure in message). O9c: the heartbeat is still refreshed DURING long ops
  (deterministic poll-based probe). O1/O2/O2b/O3/O5/O6 unchanged semantics.

### A2. Proof drivers exit non-zero on failure (audit M1)

- `worker/proof_c4.mjs`, `worker/graph_equiv_c4.mjs`, `pack/verify/verify.ts`,
  `pack/verify/ownership-verify.ts` now end with
  `process.exit(results.some(r => !/^(PASS|EXPECTED-OBSERVATION)$/.test(r.outcome)) ? 1 : 0)`.
- **Controlled failing assertion per driver:** `C5_FORCED_FAIL=1` makes each driver record one
  deliberately failing assertion and exit 1 without running the suite. Verified:
  `worker/proof_c4.mjs` → exit 1; `worker/graph_equiv_c4.mjs` → exit 1;
  `pack/verify/verify.ts` → exit 1; `pack/verify/ownership-verify.ts` → exit 1.
- **Unexpected worker errors are never green:** `proof_c4.mjs`'s `scenario()` records
  unexpected worker failures as `AGENT-OBSERVATION` — which is NOT PASS and therefore exits 1.
  The single documented upstream fact in `verify.ts` (durable engine runs real bindings in
  test/simulate; UV-1) is marked `EXPECTED-OBSERVATION` and is the ONLY non-PASS outcome that
  keeps the gate green.

### A3. Contract §9 aligned with reality (audit M2)

`docs/c3-pack-contract.md` §9 now states: ready message = protocol `vict-cognee-worker/5`,
pid, RSS, import_ms, allowed namespaces, verified store boundary — **no component version
fields**; **RSS is reported on ready/status only** — no per-op RSS report, no RSS budget, no
automatic post-op restart (restart triggers: worker death, mutating-op timeout). Per-op RSS
budget + post-op graceful restart moved to §12 as deferred (not needed by the first release).

### A4. Ready-timeout stranded worker (audit L2)

On ready-budget expiry the supervision now SIGKILLs the child and clears it, so the next
request respawns fresh (nothing was dispatched → no unknown-outcome window). While fixing this,
the V10g test exposed a latent race: the killed child's late `exit` event unconditionally
nulled the NEW child reference and rejected the NEW ready promise. All lifecycle handlers are
now scoped to their spawned process (`proc`); stale exits are ignored. **V10g** proves: request
fails `COGNEE_WORKER_UNAVAILABLE`, kills ≥ 1, and the next request recovers via a fresh spawn
(`spawns === 2`, fresh stub `servedOps === 1`). (The verification-only stub worker gained
`STUB_READY_ONCE_MARKER` — first spawn pays the ready delay, later spawns start fast.)

### A5. Remaining Lows

- **L3 (physical store identity):** the store root is `realpathSync`-resolved at construction
  (symlinks/subst/case → one physical lock file); a store root nested INSIDE another pack-owned
  root that holds a lock is refused at construction (ancestor lock check); the worker's ready
  `store_root` is cross-checked against the configured boundary and a mismatching worker is
  killed before resolving anything. Deliberately unsupported direct use, documented in §8:
  provisioning an OUTER store root over an active INNER root is not auto-detected and surfaces
  as typed ladybug/sqlite contention at op time.
- **L4 (boundary output validation):** every binding (real handlers AND test doubles) now runs
  its receipt through the capability's OUTPUT contract at the binding boundary; violations
  throw typed `COGNEE_OUTPUT_CONTRACT` — nothing malformed crosses into VICT even when a
  consumer graph omits the node `output` declaration.
- Info finding (`StatusInputContract` laxity) left as documented (harmless, CONT-001).

### Stage A regression runs (exact commands, from repo root)

| Command | Result | Wall |
| --- | --- | --- |
| `node ../260831-VCT-02/node_modules/tsx/dist/cli.mjs pack/verify/ownership-verify.ts` | **16/16 PASS**, exit 0 | 31 s |
| `node ../260831-VCT-02/node_modules/tsx/dist/cli.mjs pack/verify/verify.ts` | **27 PASS + 1 EXPECTED-OBSERVATION**, exit 0 | 99 s |
| `node worker/proof_c4.mjs` | **32/32 PASS**, exit 0 | 353 s |
| `node worker/graph_equiv_c4.mjs` | **8/8 PASS**, exit 0 | 245 s |
| `C5_FORCED_FAIL=1 …` × the four drivers above | exit **1** each | < 5 s each |

`tsc -p pack/tsconfig.json --noEmit` (strict) is clean. Fresh evidence JSONs
(`worker/c4-ownership-results.json`, `worker/c4-verify-results.json`, `worker/c4-results.json`,
`worker/c4-graph-equiv-results.json`, graphs) are committed with Stage A.

---

## Stage B — installable, unpublished package candidate

### What was built

- **`pack/package.json`** (new): `@victframework/cognee@0.1.0`, **`private: true`** (npm
  refuses to publish), `type: module`, `main`/`exports` → `./dist/index.js`, `types` →
  `./dist/index.d.ts`, `engines: node >=22`, `files: ["dist", "README.md"]`, `license:
  UNLICENSED`.
- **`pack/tsconfig.json`** (new): NodeNext ESM, strict, declarations + maps, `rootDir: src`.
- **`pack/scripts/build.mjs`** (new): runs tsc (compiler located from the local VICT reference
  clone or `$C5_TSC` — build-time only), then ships `src/worker/cognee_worker.py` +
  `src/worker/guard_store_roots.py` into `dist/worker/`, then asserts
  `dist/supervision.js` still resolves `worker/` relative to itself and contains no
  repo-relative path in code. Run: `node pack/scripts/build.mjs` → 17 files, 153 842 bytes.
- The supervision default `workerPath` resolves against the compiled module
  (`import.meta.url` + `worker/cognee_worker.py`), so the SAME code resolves `pack/src/worker/`
  in the repo and `dist/worker/` in the installed package.
- `.gitignore`: `pack/dist/`, `pack/*.tgz` (build artifacts never committed).

### Tarball (exact contents — `npm pack`, 19 files)

`package/package.json`, `package/README.md`,
`package/dist/{index,bindings,contracts,manifest,supervision}.{js,d.ts,js.map}`,
`package/dist/worker/cognee_worker.py`, `package/dist/worker/guard_store_roots.py`.
Verified ABSENT: `pack/verify/` (stub worker, suites), `worker/` proof drivers, proof crash
harness, tsconfig, and every test fault hook (`C4_PROOF_FAULT`, `C5_FORCED_FAIL`, `STUB_*` —
grep over shipped `.js`/`.py`/`.json`: zero hits; the README's explanatory sentence is the only
mention). No `tsx` requirement: the shipped code is plain Node ESM JavaScript.

### Clean-install smoke (exact commands)

```
S=%TEMP%/c5-smoke  (throwaway; deleted after the review if desired)
npm install   # dependencies:
#   "@victframework/cognee":  "file:<repo>/pack/victframework-cognee-0.1.0.tgz"
#   "@victframework/sdk":     "file:<vict>/packages/sdk"      (0.3.1)
#   "@victframework/runtime": "file:<vict>/packages/runtime"  (0.3.1)
#   "@victframework/contracts" + "@victframework/kernel": file: (local deps of sdk/runtime)
#   "zod": "^3.25.0"
# → added 6 packages in 3s, NO registry access
node smoke.mjs    # plain node — no tsx, no repo-relative proof path, no fault hooks
```

`docs/c5-evidence/smoke.mjs` is the exact script; `docs/c5-evidence/smoke-run.log` the exact
output. Results: **7/7 PASS, exit 0** —
- S1 installed manifest validates via `@victframework/sdk` `validateCapabilityPack`;
- S2 bundled worker + guard resolve inside
  `node_modules/@victframework/cognee/dist/worker/` (no repo-relative path);
- S3 durable keyed write graph (add + cognify, node retry policies → runtime-derived keys)
  completes through the REAL worker on a disposable store; contract-conform receipts;
- S4 scoped search through the runtime returns the marker (in-scope);
- S5 ownership: second instance refuses `COGNEE_STORE_OWNED` pre-spawn; orderly shutdown
  releases the lock;
- S6 shipped worker + guard contain no fault-injection hook.

The smoke needed the absolute path of the tested Python venv (`proof/.venv` on this host) as
`pythonPath` — provisioning, not a code dependency (see below).

### Documented provisioning / platform (pack/README.md + contract §10/§11)

- Node ≥ 22 (tested v22.13.1, Windows 11 x64); Python 3.12.x venv with `cognee==1.6.1`
  (passed as `pythonPath`); keyless models (fastembed `BAAI/bge-small-en-v1.5` 384d local,
  `gliner_demo` extraction) — a fresh host downloads the models on first worker start unless
  caches are pre-provisioned; RAM peak ~2.0 GB during cognify (crash risk observed near
  1.9 GB free on this host class); one absolute pack-owned store dir per runtime/trust domain
  with its own `.env`.

---

## Remaining limitations (honest)

1. **No automatic stale recovery** is a design decision, not an oversight: recovery is the
   documented §8.1 operator procedure; its safety depends on the operator actually verifying
   the old process + worker are stopped (steps 2–3).
2. Stale-LOCK contention on restart = availability pause until operator recovery (typed
   refusal with guidance; no data risk).
3. The nested-OUTER-root provisioning error (outer store created over an active inner store)
   is documented as unsupported; it is not auto-detected (typed ladybug/sqlite contention at
   op time).
4. §12 deferred items unchanged (per-op RSS budget, read doubles, per-actor users, journal
   OS-crash durability beyond fsync, upstream UV-1/UV-2).
5. The packaged candidate is UNPUBLISHED by construction (`private: true`); consumer adoption
   and `npm publish` remain out of scope.
6. Smoke/suites were run on the tested Windows host only; cross-platform behavior (macOS/Linux)
   is untested and unclaimed.

## Verification summary

| Gate | Result |
| --- | --- |
| ownership-verify.ts (new protocol + O10 interleaving regression) | 16/16 PASS, exit 0 |
| verify.ts (real runtime; V10g recovery; exit gate) | 27 PASS + 1 expected obs, exit 0 |
| proof_c4.mjs (worker boundary; exit gate) | 32/32 PASS, exit 0 |
| graph_equiv_c4.mjs (graph equivalence; exit gate) | 8/8 PASS, exit 0 |
| Forced-fail exit coupling (4 drivers) | exit 1 each |
| tsc strict typecheck (pack src) | clean |
| Tarball contents + fault-hook grep | exact allowlist; zero hooks in code |
| Clean-install smoke through real VICT runtime | 7/7 PASS, exit 0 |

**Stop:** per the C5 mandate — stop here for a focused independent review before any consumer
adoption or publication.
