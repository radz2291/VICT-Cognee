# C6 browser pilot — walkthrough capture (2026-09-26)

Run by the pilot agent in a clean consumer workspace
(`C:/Users/RZ1/Desktop/RZ/260925-VCT-c6-pilot`), against the audited pack candidate
`c5/package-readiness` @ `3509533` tarball and VICT 0.3.1 tarballs, with the proof venv
(cognee 1.6.1). All screenshots in `capture/shots/`.

## Focused checks — `npm run checks` → **17/17 PASS, exit 0**

C1a–C1c owner flow (add → cognify → scoped search candidate with raw score) ·
C2a–C2b verbatim candidates + searchSummaries · C3 restart persistence ·
C4a–C4c cross-domain isolation (status names, content, foreign scope refused) ·
C5a–C5e deletion denied by default / armed delete on disposable data /
post-forget typed failure · C6a–C6b boundary refusals.
Resource record: free RAM 3.87 → 2.79 GB over the suite; worker RSS ≈ 315 MB steady;
add ≈ 16–59 s (first run includes worker cold boot), cognify ≈ 17–30 s, scoped search ≈ 0.4–0.6 s.

## Browser walkthrough (Chromium via CDP; screenshots)

1. **00-initial.png** — landing page: two trust-domain tabs, dataset status ("no datasets
   yet"), boundary explanations on every card.
2. **01-add-receipt.png** — note added to `notes.team` through the durable keyed write
   graph: contract-conform receipt (`idempotencyKey`, `reconciled: fresh-execution`,
   itemsBefore/After, deduplicated). Cognify receipt follows (deduplicated: true).
3. **02-candidates-search.png** — scoped search `settlement windows` over the picked
   dataset only. Yellow banner: "CANDIDATES — retrieval output, not an answer. No
   threshold is applied by the pack or this app." One candidate with raw score 0.2234
   displayed verbatim; no answer composed anywhere.
4. **03-mixed-language.png** — Malay/English sample note ("Nota ringkas: … dual
   approval…") added + cognified into `notes.melayu`; a Malay query ("pembayaran besar
   dual approval") across `notes.melayu`+`notes.team` returns candidates with scores
   0.4151 / 0.1592. Limitation visible: the English-centric embedding model
   (BAAI/bge-small-en-v1.5) matches via the embedded English half; pure-Malay recall is
   not guaranteed and scores are not comparable across queries.
5. **04-off-corpus.png** — off-corpus query ("quarterly orbital telescope maintenance
   schedule") returns two weak candidates (0.3852 / 0.4465) — *higher* raw scores than
   the on-corpus query's 0.2234. The page explains: no universal relevance threshold;
   every score is a candidate signal, not correctness.
6. **05-delete-denied.png** — "Try delete — default policy" on `vault.personal`
   (trust domain B): `run.status: blocked · 4 ms` — VICT's effect policy denies the
   irreversible capability; nothing was deleted (the dataset remains searchable).
7. **06-armed-delete.png** — after restarting the server with the server-side
   `PILOT_ALLOW_IRREVERSIBLE=1` switch and typing the dataset name to confirm:
   armed `cognee.forgetDataset` runs with `{ policy: { allowIrreversible: true } }` →
   receipt `purged: file-level, storeFilesBefore: 2, storeFilesAfter: 0`; the dataset
   status immediately shows "no datasets yet". Demonstrated ONLY on disposable demo data.

## Cross-domain isolation (observed live)

Switching to trust domain B shows "no datasets yet" — domain A's `notes.*` datasets are
never named (separate store, worker, lock). Checks C4a–C4c assert the same at the API
level: B's status never names A's datasets; B's scoped searches never return A's
content; foreign-namespace scopes are refused at the app boundary (and the worker's
`--allow-ns` rail refuses them regardless of what the app does).

## Resource observations & limitations recorded during the walkthrough

- **Windows low-memory class (documented in C4/C5, re-observed here):** with ~0.4–1 GB
  free physical RAM, the SECOND trust domain's worker failed its GLiNER model load —
  `Failed to read safetensors checkpoint …\models--fastino--gliner2.5-base-v1\…
  \model.safetensors: The paging file is too small for this operation` — while the first
  domain's worker held its own mapping. The pack contained the failure as a typed
  `VICT_RUNTIME_CAPABILITY_THREW`; searches on the uncognified dataset then fail typed
  (`NoDataError` 404 — empty knowledge graph). This is an environment resource limit
  (single-worker-at-a-time on this host), NOT a packaging fault; the isolation
  properties were still verified (checks C4a–C4c do not depend on B's cognify).
- **Durable-run retry quiescence:** when a cognify attempt fails and the graph's retry
  policy schedules the keyed retry, the orchestration run quiesces on its retry timer
  and `runtime.run` returns `run.status: 'running'` with a timer wait; this VICT stage
  has no automatic resume. The app surfaces the status verbatim (screenshot 05 shows
  `run.status: running`); a fresh cognify run is the recovery. Recorded as an
  application-visible VICT-stage behavior, not worked around in the app.
- **cognee 1.6.1 requires ABSOLUTE storage-root paths** in the store `.env` (relative
  values fail BaseConfig validation at worker import). The pilot writes absolute paths
  exactly like the C5 evidence scripts.
- Worker RSS ≈ 315–343 MB steady; cognify peak ≈ 2.0 GB (matches the C4/C5 records).

## Boundary between application code and pack machinery

- **Pack (`@victframework/cognee` tarball):** the six capabilities, contracts, worker +
  guard, store ownership/lock, keyed retries, namespace rail.
- **VICT runtime (0.3.1 tarballs):** graphs, effect policy (irreversible denied unless
  `{ policy: { allowIrreversible: true } }`), authority grants, durable keyed runs.
- **This app (thin, ~600 lines total):** input mapping (`mapActionInput` + one pure
  `pilot.route` capability), the `/api/act` boundary (scope/confirm guards), static
  file serving, the browser UI (display + clicks). The browser can never grant itself
  permissions; deletion is denied by the runtime policy and only armed server-side.
- The app NEVER imports pack internals (`supervision`/bindings) directly — it goes
  through `createCogneePack` + `installCapabilityPack` + graph runs, exactly like the
  C5 evidence scripts.