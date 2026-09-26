# C4 exit report — corrections, evidence, and audit handoff

Repo: radz2291/VICT-Cognee (`main`). Base: C4 commit
`432ac41fd9f0bdfdcd42c1ba8a1a14d172cb8821` (verified: local HEAD == `origin/main`
== the C4 commit at checkout; remote re-fetched before work started).
VICT ABI reference (READ-ONLY, never modified): radz2291/vict-02 @
`5ea0afe257d5e7f67e050fcae169746a25fd3cc4`. Quellight, Trading OS, VICT Stage 8:
untouched. **Nothing published, no consumer integrated.**

## 1. What was corrected (six exit items)

| # | Item | Resolution |
| --- | --- | --- |
| 1 | Durable-mode safety gap (VICT durable driver ignores `decision.useDouble`; real bindings ran in test/simulate) | Every real Cognee binding fails closed unless `ctx.mode === 'normal'` (`COGNEE_MODE_REFUSED`) BEFORE any worker request or effect. Durable graphs with reads/add/cognify/forgetDataset verified in `test` AND `simulate`: zero worker spawns, zero store change (V9a–V9d). Sequential-engine doubles preserved unchanged (V2/V2b). Upstream issue **UV-1** documented with source refs (`docs/upstream-vict-issues.md`) — VICT itself NOT edited. |
| 2 | Deadlines | An expired or insufficient `ctx.deadlineAt` fails BEFORE the worker request (`COGNEE_DEADLINE_EXCEEDED`); a context deadline is NEVER replaced with a fresh full timeout. Verified for mutating and read paths (V10a–V10c). |
| 3 | Idempotency-key contract | **Upstream defect UV-2:** VICT's `deriveIdempotencyKey` accepts `invocationId` but never hashes it. Verified no collision path today (invocationId is a deterministic function of the hashed fields; graphs acyclic; attemptNumber per invocationId). Contract §1/§7.3 corrected; pack's fingerprint binding contains the latent path; residual risk (identical-input replay under a future colliding key) stated in §7.3. `keyedRetry` for `add` retained — supported by the crash-window convergence proof (c5: no duplicate, count 1). |
| 4 | Store ownership | Exclusive owner lock (`<storeRoot>/cognee-store-owner.lock`, atomic `O_EXCL` create, pid+host+instanceId+heartbeat) claimed at construction; fails closed on a live owner (`COGNEE_STORE_OWNED`, pre-spawn); recovers verifiably stale owners (dead pid same-host; foreign host past heartbeat budget); releases on orderly shutdown; a live owner's lock is never deleted. Verified: second instance (O2), live-owner lock untouched (O2b), restart (O3b/O3c), stale recovery (O4). |
| 5 | Distributable worker | `C4_FAULT` REMOVED from the shipped worker — the pack now bundles `pack/src/worker/cognee_worker.py` (protocol `vict-cognee-worker/5`) with its guard asset `pack/src/worker/guard_store_roots.py`; the pack resolves its OWN bundled worker by default (V11: path + file + no fault hook). Crash injection lives ONLY in the proof harness `worker/worker_proof.py` (`C4_PROOF_FAULT`, default OFF), which patches the shipped worker's journal commit in-process. Remaining release-metadata work (build step, `files` allowlist, packaging smoke test) is listed in §11 of the contract and deliberately NOT done — publication is out of scope. |
| 6 | cognify retry semantics | **Settled by GRAPH equivalence:** two isolated fresh stores, same content; A = uninterrupted cognify; B = forced post-write/pre-commit crash + keyed reissue. Full ladybug graphs dumped per dataset (`worker/graph_dump_c4.py`, per-dataset `.lbug` files — fail-closed on an empty dump) and diffed: **12/12 nodes, 12/12 edges, identical identities and properties** on both sides (zero differences after excluding provably per-store random fields: UUID identities, timestamps, run provenance, store-root paths — exclusion list committed). `cognify` KEEPS `ambiguity: 'keyedRetry'`; manifest/binding/doubles/contract aligned; searchability is no longer the only claim. |

## 2. Commands and outcomes (all stores fresh, isolated, disposable)

| Suite | Command | Result | Wall |
| --- | --- | --- | --- |
| Real-runtime suite (V0–V11) | `260831-VCT-02/node_modules/.bin/tsx pack/verify/verify.ts` | **22/22 checks PASS** + 1 recorded ABI OBSERVATION (`worker/c4-verify-results.json`) | 60 s |
| Ownership suite | `tsx pack/verify/ownership-verify.ts` | **8/8 PASS** (`worker/c4-ownership-results.json`) | 14 s |
| Cognify graph equivalence | `node worker/graph_equiv_c4.mjs` | **7/7 PASS** (`worker/c4-graph-equiv-results.json`; dumps `worker/c4-equiv-graph-{a,b}.json`) | 588 s |
| Worker-boundary regression | `node worker/proof_c4.mjs` | **32/32 PASS** (`worker/c4-results.json`, 421 s) | 421 s |

Store isolation and resource limits: every suite builds its own disposable
store under `proof/` (own `.env`, own journal, guard boundary = that store;
gitignored). Real-runtime suite: 1 worker spawn, 0 kills, RSS ~344 MB, 9 ops.
Ownership suite: 1 spawn. Graph-equivalence: two workers run SEQUENTIALLY on
two separate stores. No expensive model batteries were re-run beyond the four
focused suites above; no unresolved failure required them.

## 3. Commit

- Corrections committed and pushed to `origin/main` (SHA recorded in the commit
  message header and below); working tree clean after push.
- Changed files: `pack/src/{bindings,supervision,index,manifest}.ts`,
  `pack/src/worker/{cognee_worker.py,guard_store_roots.py}` (new, bundled),
  `pack/verify/{verify.ts,ownership-verify.ts}`, `worker/{worker_proof.py,
  graph_dump_c4.py,graph_equiv_c4.mjs}` (new), `worker/worker.py` (removed),
  `worker/{proof_c3,proof_c4,client}.mjs`, results/logs
  (`worker/c4-verify-results.json`, `worker/c4-ownership-results.json`,
  `worker/c4-graph-equiv-results.json`, `worker/c4-equiv-graph-{a,b}.json`,
  `worker/c4-results.json`, `worker/c4-journal.jsonl`),
  `docs/{upstream-vict-issues.md,c3-pack-contract.md,c4-exit-report.md}`,
  `.gitignore`.

## 4. Unresolved risks (stated, not hidden)

1. **UV-1 affects other packs:** the durable engine's `useDouble` discard is
   VICT-wide; only THIS pack's boundary is fail-closed. Other packs' durable
   graphs still run real bindings in test/simulate.
2. **UV-2 residual:** within pinned VICT there is no collision path, but a
   future VICT invocation-identity change would make identical-input
   re-invocations replay stale journal outcomes; the fingerprint binding turns
   changed-input reuse into a loud `COGNEE_IDEMPOTENCY_MISMATCH`. Fix belongs
   upstream (`vict.idempotency-key@2`).
3. **Ownership heartbeat:** foreign-host owners are heartbeat-protected only
   (15 min default budget); same-host owners are exact (pid probe). Non-pack
   processes touching the store directory out-of-band are not covered.
4. **Graph equivalence scope:** proven for the proof corpus under pinned
   cognee 1.6.1 + gliner pipeline, single dataset. A changed model/pipeline/
   cognee version re-opens the question.
5. **Journal durability:** fsync-per-record only; OS-crash semantics beyond
   fsync unverified; no compaction/rotation.
6. **Release metadata:** no build artifact/`files` allowlist/packaging test
   yet; `private: true`. Publication remains excluded from this task.
7. Environment class: native cognee crashes under low free RAM (C1
   observations); none occurred in these runs (free RAM ≥ ~2.5 GB); the
   supervision poison+respawn policy contains such deaths as typed
   unknown-outcome errors.

## 5. Handoff

**STOP HERE for independent audit.** This report, the corrected contract
(`docs/c3-pack-contract.md`), the upstream issue documentation
(`docs/upstream-vict-issues.md`), and the four result files above are the audit
surface. The author's own review is NOT independent — an external code and
evidence audit must precede any consumer integration or publication.