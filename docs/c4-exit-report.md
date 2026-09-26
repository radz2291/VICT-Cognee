# C4 exit report — corrections, evidence, and audit handoff

**Correction pass 2 (this revision, from pushed commit
`ae0e6f6ff96b7815bda760c0902b0edf5c73c9c3`):** four spot-check gaps closed —
(1) ownership LOSS fails closed; (2) stale recovery made race-safe (atomic
rename claim) with deterministic two-contender and stale-contender tests;
(3) absolute deadlines preserved through queue wait and worker startup with
pre-dispatch recheck and unknown-outcome post-dispatch; (4) graph comparison
strengthened to multiplicities + raw counts with negative controls. A
separate independent audit is still required; this pass is the AUTHOR's own
correction work, not an audit.

Repo: radz2291/VICT-Cognee (`main`). Base: C4 commit
`432ac41fd9f0bdfdcd42c1ba8a1a14d172cb8821`, then correction-pass-1 commit
`ae0e6f6ff96b7815bda760c0902b0edf5c73c9c3` (verified: local HEAD ==
`origin/main` == the pushed commit at checkout; remote re-fetched before work
started). VICT ABI reference (READ-ONLY, never modified): radz2291/vict-02,
`5ea0afe257d5e7f67e050fcae169746a25fd3cc4` (verified an ancestor of that
clone's HEAD; clone clean). Quellight, Trading OS, VICT Stage 8: untouched.
**Nothing published, no consumer integrated.**

## 1. What the correction pass 2 changed (four spot-check gaps)

| # | Gap found by spot-check | Correction |
| --- | --- | --- |
| 1 | `refreshOwnershipHeartbeat()` returned silently when the lock was missing or another instance's; `request()` continued and could run an op | Ownership is now verified BEFORE spawn, immediately BEFORE dispatch, and on an interval WHILE an op is in flight; a missing/foreign lock sets a permanent lost flag: the not-yet-dispatched request fails `COGNEE_STORE_OWNED` with no effect; an ALREADY-DISPATCHED op completes (its outcome is real) and the worker is then killed+poisoned; EVERY later request fails closed. Tests: **O2b** (lock replaced by a crafted live-owner lock while the instance is active → active instance performs NO further op, contender never deletes the live lock) and **O6** (lock removed → next op fails, sticky). |
| 2 | `acquireStoreOwnershipContended()` read a stale lock then unlinked without an atomic check — two contenders could both acquire | Recovery now: read+judge from a snapshot → ATOMIC RENAME of the judged-stale lock to a unique recovery file (exactly one contender can succeed; all others get ENOENT and re-evaluate) → prove the moved bytes STILL equal the judged snapshot; a mismatch (a fresh owner replaced it mid-window) fails closed and RESTORES the displaced lock byte-identically; then atomic `O_EXCL` re-create. Tests: **O7** deterministic two-contender race (two concurrent holding processes: EXACTLY ONE acquires, other refused, winner lock intact) and **O8** stale contender (delayed claim, verification-only `ownershipRecoveryDelayMs`) NEVER removes a fresh live lock — fresh lock restored byte-identical, fresh owner keeps holding. Long ops + foreign-host budget: the heartbeat is refreshed per op AND during in-flight ops (**O9c**: advanced during a 3 s op under a 1.5 s budget), so a live running owner is not stealable regardless of op duration; a crashed foreign host's lock lingers at most one budget (O9a/O9b). An exited owner's lock becomes legitimately stale the same moment its pid dies (same-host exactness) — recovery is then correct. |
| 3 | `deadlineFrom()` computed a remaining duration at binding entry while the supervision timer started only after queue wait + worker readiness | The binding now forwards `ctx.deadlineAt` as an ABSOLUTE timestamp, unchanged. Supervision re-checks it before spawn, immediately before dispatch (after queue + startup), and anchors the response timer to it; expiry pre-dispatch fails `COGNEE_DEADLINE_EXCEEDED` with NO effect; expiry AFTER a mutation was dispatched reports UNKNOWN (`COGNEE_WRITE_UNKNOWN`); reads report `CLIENT_DEADLINE`. Tests: **V10d** (expiry during worker startup — stub servedOps proves nothing was sent), **V10e** (queued request expiring behind an in-flight op — never sent), **V10f** (post-dispatch mutation → unknown; post-dispatch read → typed failure); V10a–V10c re-run on the real runtime. |
| 4 | Normalized node/edge maps overwrote duplicate identities; counts not asserted | `graph_dump_c4.py` now normalizes each identity to a LIST of property variants (multiset); the comparator asserts RAW node/edge counts, per-identity multiplicities, and property-variant multisets; **negative controls** (g7) prove the comparator FAILS on an injected extra duplicate node/edge instance (same identity — the exact case the old maps collapsed) and on an extra new-identity edge; every excluded property is individually justified in the dump file. Re-run: **8/8 PASS** (12/12 nodes, 12/12 edges, zero raw-count/multiplicity/variant diffs) → `cognify` KEEPS `ambiguity: 'keyedRetry'`. |

Also fixed en route: a latent dead `ready` getter (`ensureReady` never existed)
was anchored to the real lifecycle; `opsServed` now counts only DISPATCHED ops.

### The six exit corrections (pass 1 baseline; rows marked STRENGTHENED were
tightened by this pass)

| # | Item | Resolution |
| --- | --- | --- |
| 1 | Durable-mode safety gap (VICT durable driver ignores `decision.useDouble`; real bindings ran in test/simulate) | Every real Cognee binding fails closed unless `ctx.mode === 'normal'` (`COGNEE_MODE_REFUSED`) BEFORE any worker request or effect. Durable graphs with reads/add/cognify/forgetDataset verified in `test` AND `simulate`: zero worker spawns, zero store change (V9a–V9d). Sequential-engine doubles preserved unchanged (V2/V2b). Upstream issue **UV-1** documented with source refs (`docs/upstream-vict-issues.md`) — VICT itself NOT edited. |
| 2 | Deadlines | An expired or insufficient `ctx.deadlineAt` fails BEFORE the worker request (`COGNEE_DEADLINE_EXCEEDED`); a context deadline is NEVER replaced with a fresh full timeout. Verified for mutating and read paths (V10a–V10c). STRENGTHENED in correction pass 2 (row above): absolute preservation through queue/startup, pre-dispatch recheck, post-dispatch unknown. |
| 3 | Idempotency-key contract | **Upstream defect UV-2:** VICT's `deriveIdempotencyKey` accepts `invocationId` but never hashes it. Verified no collision path today (invocationId is a deterministic function of the hashed fields; graphs acyclic; attemptNumber per invocationId). Contract §1/§7.3 corrected; pack's fingerprint binding contains the latent path; residual risk (identical-input replay under a future colliding key) stated in §7.3. `keyedRetry` for `add` retained — supported by the crash-window convergence proof (c5: no duplicate, count 1). |
| 4 | Store ownership | Exclusive owner lock (`<storeRoot>/cognee-store-owner.lock`, atomic `O_EXCL` create, pid+host+instanceId+heartbeat) claimed at construction; fails closed on a live owner (`COGNEE_STORE_OWNED`, pre-spawn); recovers verifiably stale owners (dead pid same-host; foreign host past heartbeat budget); releases on orderly shutdown; a live owner's lock is never deleted. Verified: second instance (O2), live-owner lock untouched (O2b), restart (O3b/O3c), stale recovery (O4). STRENGTHENED in correction pass 2 (loss fail-closed + race-safe recovery, rows above). |
| 5 | Distributable worker | `C4_FAULT` REMOVED from the shipped worker — the pack now bundles `pack/src/worker/cognee_worker.py` (protocol `vict-cognee-worker/5`) with its guard asset `pack/src/worker/guard_store_roots.py`; the pack resolves its OWN bundled worker by default (V11: path + file + no fault hook). Crash injection lives ONLY in the proof harness `worker/worker_proof.py` (`C4_PROOF_FAULT`, default OFF), which patches the shipped worker's journal commit in-process. Remaining release-metadata work (build step, `files` allowlist, packaging smoke test) is listed in §11 of the contract and deliberately NOT done — publication is out of scope. |
| 6 | cognify retry semantics | **Settled by GRAPH equivalence:** two isolated fresh stores, same content; A = uninterrupted cognify; B = forced post-write/pre-commit crash + keyed reissue. Full ladybug graphs dumped per dataset and diffed — STRENGTHENED in correction pass 2: RAW counts asserted equal (12/12 nodes, 12/12 edges), per-identity multiplicities asserted equal, property-variant multisets identical (zero differences after excluding provably per-store random fields, each exclusion justified), and negative controls prove the comparator fails on injected duplicates/extra edges. `cognify` KEEPS `ambiguity: 'keyedRetry'`; manifest/binding/doubles/contract aligned; searchability is no longer the only claim. |

## 2. Commands and outcomes (all stores fresh, isolated, disposable)

| Suite | Command | Result | Wall |
| --- | --- | --- | --- |
| Real-runtime suite (V0–V11, incl. V10d–f stub) | `260831-VCT-02/node_modules/.bin/tsx pack/verify/verify.ts` | **26/27 PASS** — the 27th record is the ABI OBSERVATION (`worker/c4-verify-results.json`) | 67 s |
| Ownership suite (incl. O2b/O6/O7/O8/O9; run twice for determinism) | `tsx pack/verify/ownership-verify.ts` | **14/14 PASS** both runs (`worker/c4-ownership-results.json`) | 27 s / 29 s |
| Cognify graph equivalence (multiset + negative controls) | `node worker/graph_equiv_c4.mjs` | **8/8 PASS** (`worker/c4-graph-equiv-results.json`; dumps `worker/c4-equiv-graph-{a,b}.json`) | 221 s |
| Worker-boundary regression (pack TS untouched by this pass; unchanged from pass 1) | `node worker/proof_c4.mjs` | **32/32 PASS** (`worker/c4-results.json`, from pass 1 — the worker protocol and `client.mjs` are unchanged in this pass) | 421 s |

Store isolation and resource limits: every suite builds its own disposable
store under `proof/` (own `.env`, own journal, guard boundary = that store;
gitignored). Real-runtime suite: 1 worker spawn, 0 kills, RSS ~344 MB.
Ownership suite: 1 spawn + contender child processes. Graph-equivalence: two
workers run SEQUENTIALLY on two separate stores. The V10d–f and O9c stub-
worker tests use a deterministic protocol stub (`pack/verify/stub_worker.py`)
on isolated stores — supervision-level timing tests; the real-runtime V10a–c
and V5–V7 cover the pack path end-to-end. No expensive model batteries were
re-run beyond the three focused suites above; no unresolved failure required
them.

## 3. Commit

- Correction pass committed and pushed to `origin/main` (exact SHA reported at
  the end of this pass); working tree clean after push.
- Changed files: `pack/src/{supervision,bindings}.ts` (ownership fail-closed +
  race-safe recovery + absolute deadlines + in-flight heartbeat;
  `supervision.ts` also gains verification-only `ownershipRecoveryDelayMs` and
  `env` options and a fixed `ready` getter), `pack/verify/{verify.ts,
  ownership-verify.ts}` (V10d–f; O2b revised + O6/O7/O8/O9),
  `pack/verify/{stub_worker.py,ownership-contender.ts}` (new, verification
  only), `worker/{graph_dump_c4.py,graph_equiv_c4.mjs}` (multiset + negative
  controls), result files (`worker/c4-verify-results.json`,
  `worker/c4-ownership-results.json`, `worker/c4-graph-equiv-results.json`,
  `worker/c4-equiv-graph-{a,b}.json`), `docs/{c3-pack-contract.md,
c4-exit-report.md}`, `pack/package.json` (verify scripts), `.gitignore`.

## 4. Unresolved risks (stated, not hidden)

1. **UV-1 affects other packs:** the durable engine's `useDouble` discard is
   VICT-wide; only THIS pack's boundary is fail-closed. Other packs' durable
   graphs still run real bindings in test/simulate.
2. **UV-2 residual:** within pinned VICT there is no collision path, but a
   future VICT invocation-identity change would make identical-input
   re-invocations replay stale journal outcomes; the fingerprint binding turns
   changed-input reuse into a loud `COGNEE_IDEMPOTENCY_MISMATCH`. Fix belongs
   upstream (`vict.idempotency-key@2`).
3. **Ownership residuals (updated):** foreign-host owners are heartbeat-
   protected; the heartbeat is refreshed per op and during in-flight ops, so
   the budget is not eroded by long ops — but a lock stolen/removed externally
   MID-op cannot stop the already-dispatched op (it completes; the instance
   then fails closed permanently). The heartbeat-rewrite itself has a
   microsecond verify→rename window (external deletion timed exactly there
   could be overwritten; detection follows at the next verify). Non-pack
   processes touching the store directory out-of-band are not covered.
4. **Graph equivalence scope (updated):** proven with RAW counts, per-identity
   multiplicities, property-variant multisets, and negative controls, for the
   proof corpus under pinned cognee 1.6.1 + gliner pipeline and a single
   dataset (12/12 nodes, 12/12 edges, zero variant diffs). Not a theorem: a
   changed model/pipeline/cognee version re-opens the question.
5. **Journal durability:** fsync-per-record only; OS-crash semantics beyond
   fsync unverified; no compaction/rotation.
6. **Release metadata:** no build artifact/`files` allowlist/packaging test
   yet; `private: true`. Publication remains excluded from this task.
7. Environment class: native cognee crashes under low free RAM (C1
   observations); none occurred in these runs (free RAM ≥ ~2.5 GB); the
   supervision poison+respawn policy contains such deaths as typed
   unknown-outcome errors.
8. The deadline-through-startup/queue tests (V10d–f) and the in-flight
   heartbeat test (O9c) run against a deterministic protocol stub worker on
   isolated stores, not against cognee itself; the real-runtime entry
   refusals (V10a–c) and all store-effect proofs run through the real
   runtime. The stub never ships (verification-only).

## 5. Handoff

**STOP HERE for a SEPARATE INDEPENDENT AUDIT.** This report, the corrected
contract (`docs/c3-pack-contract.md`), the upstream issue documentation
(`docs/upstream-vict-issues.md`), and the three result files above are the
audit surface. Correction pass 2 is the author's own work in response to a
spot-check — it is NOT an audit. An external code and evidence audit must
precede any consumer integration or publication.