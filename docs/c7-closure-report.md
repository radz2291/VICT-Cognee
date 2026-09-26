# C7 closure report — private readiness closeout

Date: 2026-09-26. Closer: independent agent (fresh clone, clean consumer workspace).
Repository: `radz2291/VICT-Cognee`.

## Refs verified

- `origin/main` == `4461635642e389c4c80e5d06eb0a5fd3094f42f1`
  (`docs(c7): consolidate private candidate and portable pilot handoff`) — matches the
  mandated starting point. Its parent is the C6 pilot
  `e50684007d6624c3a8731ea9f0b80b776d19d5c6`, whose diff (`3509533..e506840`, 17 files,
  +1269) contains only the pilot example, capture evidence, and documentation — **no
  `pack/src` change, no capability or worker behavior change** (re-verified by diff).
- The main delta `e506840..4461635` (8 files) is documentation consolidation, package
  description metadata, the C7 deployment notes, and the pilot portability change
  (`setup.mjs`/`server.mjs` now REQUIRE explicit `PILOT_VICT_ROOT`,
  `PILOT_COGNEE_TGZ`, `PILOT_PYTHON` — all machine-specific defaults removed, exit 2
  with guidance when absent). No behavior change in the pack.
- Historical evidence preserved: `proof/`, `worker/`, `ts-sdk/`, `docs/` reports, and
  the audit branch `audit/c5-closure-review` @ `7efedde` are untouched by the delta.

## 1. Pack build and tarball (commands + results)

Host: Windows 11, node v22.13.1, npm 10.9.2. Fresh clone `260926-VCT-Cognee-c7`.

```
cd pack
rm -rf node_modules dist
npm install --no-audit --no-fund     # added 3 packages in 13s (typescript 6.0.3, @types/node 22.20.4, dev-only)
node scripts/build.mjs               # [build] DONE — tsc strict clean, 17 dist files incl. worker/cognee_worker.py + guard_store_roots.py
npm pack                             # total files: 19 — victframework-cognee-0.1.0.tgz
```

Tarball inspected: `dist/index.js` + `bindings/contracts/manifest/supervision` (.js,
.d.ts, .map), `dist/worker/cognee_worker.py`, `dist/worker/guard_store_roots.py`,
`README.md`, `package.json`. `private: true` retained; version 0.1.0; peers
`@victframework/sdk|runtime ^0.3.1`. **Nothing published** (local pack only).

## 2. Portable pilot setup (separate clean consumer directory)

Fresh dir `C:\Users\RZ1\Desktop\RZ\260926-c7-consumer` (never inside the pack
checkout), example copied from the fresh clone:

- `node setup.mjs` with NO env → **exit 2**, "Set PILOT_VICT_ROOT and
  PILOT_COGNEE_TGZ" ✓ (no machine-specific defaults remain in any script — grep clean).
- With explicit env (`PILOT_VICT_ROOT=C:\...\260831-VCT-02`,
  `PILOT_COGNEE_TGZ=C:\...\pack\victframework-cognee-0.1.0.tgz`) → five tarballs
  packed/copied into `vendor\` (VICT tree untouched); `npm install --no-audit
  --no-fund` → **added 6 packages in 7s**; installed cognee 0.1.0, peers `^0.3.1`.
- `node server.mjs` without `PILOT_PYTHON` → **exit 2** with the guidance message ✓.
- Python used (explicit): `proof\.venv\Scripts\python.exe` — Python 3.12.10,
  cognee 1.6.1, gliner2 2.0.0, fastembed 0.8.0, lancedb 0.39.0.

## 3. Focused pilot checks — actual results (NOT green-marked)

Command: `PILOT_PYTHON=<venv python> node checks.mjs` (17 assertions, spawns the
server three times; disposable `.pilot-stores\`).

- **Run 1:** free RAM at start 3.81 GB → **15/17 PASS, exit 1.**
- **Run 2 (rerun to characterize):** → **15/17 PASS, exit 1.**

Failing in both runs: **C4b** (domain-B scoped search after B's cognify) and
**C5b** (search after the denied delete). Exact failure, confirmed in the worker logs
both times:

```
RuntimeError: Failed to read safetensors checkpoint
'C:\Users\RZ1\.cache\huggingface\hub\models--fastino--gliner2.5-base-v1\...
\model.safetensors': The paging file is too small for this operation to
complete. (os error 1455)   [in cognee's prepare_gliner_schema / classify_documents]
```

i.e. the SECOND worker's GLiNER model load failed on Windows commit-charge limits
while the first worker still held its mapping → B's cognify pipeline errored (contained
by the pack as typed `VICT_RUNTIME_CAPABILITY_THREW`) → the two domain-B searches
failed typed instead of returning candidates. **These two checks are reported as
INCONCLUSIVE (environment), not green, per the closure protocol** — the model run was
prevented by host memory, exactly the documented C6 limit. Not a regression: the pack
source is byte-identical to the C5-reviewed tree in all behavior-relevant files; the
C6 checks run itself recorded 17/17 earlier the same day on this host, and the C6
walkthrough hit this same os error 1455 an hour later — the host sits at the margin.
The second worker DID serve add/status/forget ops in both runs; only the model-bearing
cognify failed. No cross-domain content ever appeared in any response (the isolation
surface held; C4a status isolation, C4c foreign-scope refusal, C5a default denial,
C5c–C5e armed delete + post-forget, C6a/b boundary refusals, and the full C1–C3
owner-flow all PASS).

Resources: worker RSS ≈ 315–343 MB steady; cognify (first domain) ≈ 17–30 s; scoped
search ≈ 0.4–0.6 s; commit free at failure ≈ 3.2–4.1 GB of a 20.4 GB limit.

## 4. Decision check

`docs/c7-private-readiness.md` decides **GO for a bounded, private, single-app
integration trial (future C8)** with HOLD on npm publication, unattended production
deployment, and any adoption claim. The closure evidence supports that decision: the
artifact builds and packs reproducibly, the portable consumer path works end-to-end,
and the four explicit limits are real and correctly recorded — the `running` retry
state (reproduced in C6; no automatic resume), second-worker memory pressure
(reproduced twice today, see §3), candidate relevance without a universal threshold
(C6 off-corpus observations), and namespaces not being actor authorization. Nothing in
the repository claims production readiness.

## 5. Correction made on this branch

- `pack/README.md` (C7 deployment notes) and `docs/c7-private-readiness.md`
  (operator handoff item 3 + observations table): the GLiNER second-worker failure was
  documented as occurring only "under ~1 GB free RAM"; the closure runs reproduced it
  at ~3–4 GB free. The docs now state the binding constraint as Windows commit
  headroom (os error 1455) rather than free RAM alone. No other changes; historical
  evidence untouched.

## Verdict

**VERIFIED** — C7 closes as a bounded, private, single-app-trial-ready candidate with
the four operating limits explicit. Publication, production deployment, and adoption
claims remain HELD. The two memory-bound check assertions are recorded as
environment-inconclusive with the exact failure above; they are the same limit the C7
docs require a real-app host to be measured against.

C8 (one real-app vertical slice) is intentionally out of scope here.
