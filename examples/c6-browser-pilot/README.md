# C6 browser pilot — first consumer of `@victframework/cognee`

A small, runnable **browser-based VICT application pilot**. It is committed to the
`c6/consumer-pilot` branch of `radz2291/VICT-Cognee` but is **run from a clean consumer
workspace** (a plain directory with an ordinary `npm install`), so no source-path import
can hide a packaging fault.

The package under test is the audited candidate
`c5/package-readiness` @ `35095331b23098f3c0287e43235b831cbf1c85e8` (C5 closure verdict:
**verified** — `audit/c5-closure-review` @ `7efedde`). The pack stays **private and
unpublished**; this pilot makes no product-adoption claim.

## What is app vs. what is pack machinery

| Layer | Responsibility |
| --- | --- |
| **Pack (`@victframework/cognee`, tarball)** | the six capabilities (`cognee.add`, `cognee.cognify`, `cognee.searchChunks`, `cognee.searchSummaries`, `cognee.datasetsStatus`, `cognee.forgetDataset`), contracts, worker + guard, store ownership, keyed retries, namespace rail |
| **VICT runtime (`@victframework/runtime` + kernel/contracts/sdk, 0.3.1 tarballs)** | graphs, effect policy (irreversible denied unless `{ policy: { allowIrreversible: true } }`), authority grants, durable keyed runs |
| **This app (thin)** | input mapping (route capability + `mapActionInput`), the `/api/act` boundary, static UI, candidates display, buttons |

App code inventory (everything else is pack/runtime machinery):
`server.mjs` (~330 lines incl. comments: two trust domains, boundary, static serving),
`public/` (HTML + ~200-line client + CSS), `checks.mjs`, `setup.mjs`.
**No capability logic lives in the app**: every cognee effect goes through a VICT graph
run (`runtime.activate/run`), and search hits are displayed **verbatim as candidates** —
no threshold, no answer composition, anywhere in the app.

## Setup (exact commands)

Prereqs: Node v22, npm 10; a Python env with `cognee 1.6.1` installed (the repo's proof
venv works: `proof/.venv`), and the VICT clone with `packages/{contracts,kernel,sdk,runtime}`
at **0.3.1** (tarballs are packed straight into `vendor/`; the VICT tree is never modified).

```bat
:: from a CLEAN directory (never inside the pack checkout)
xcopy /E /I <repo>\examples\c6-browser-pilot c6-pilot && cd c6-pilot

set PILOT_VICT_ROOT=C:\Users\RZ1\Desktop\RZ\260831-VCT-02
set PILOT_COGNEE_TGZ=C:\Users\RZ1\Desktop\RZ\260925-VCT-Cognee\pack\victframework-cognee-0.1.0.tgz
set PILOT_PYTHON=C:\Users\RZ1\Desktop\RZ\260925-VCT-Cognee\proof\.venv\Scripts\python.exe

npm run setup                       :: packs/copies 5 tarballs into vendor\ (VICT stays clean)
npm install --no-audit --no-fund    :: ordinary consumer install (no flags, no overrides)
npm start                           :: http://localhost:4173
```

For the walkthrough you can also arm irreversible delete (server-side switch; deletion is
demonstrated only on the disposable demo stores):

```bat
set PILOT_ALLOW_IRREVERSIBLE=1 && npm start
```

Reset everything at any time: stop the server (Ctrl+C) and delete `.pilot-stores\`.

## Walkthrough (owner-facing flow)

1. **Add + cognify + scoped search** — pick a dataset (`notes.team`), type a short note,
   **Add note** (receipt shows the keyed run), **Process with cognify** (second keyed run),
   then tick the dataset and **Search passages** — your note comes back as a **CANDIDATE**
   with a raw score.
2. **Candidates, not answers** — the yellow banner says it: retrieval output only, no
   threshold applied by pack or app. Scores are raw similarity values, not correctness.
3. **Dataset status + restart** — status lists this domain's datasets only (hidden count
   shows the store filter is live). Ctrl+C the server, `npm start` again — the note is
   still there (lock re-acquired cleanly; the pack's C5-precise release runs on shutdown).
4. **Limitations visible** — **Fill Malay/English sample** then search in either language:
   the embedding model is English-centric (`BAAI/bge-small-en-v1.5`), so mixed-language
   recall is a genuine limitation to observe. **Fill off-corpus query** returns zero or
   weak candidates — there is no universal relevance threshold and no fabricated answer.
5. **Deletion** — **Try delete (default)** → VICT denies it verbatim
   ("Effect class 'irreversible' is denied by default…"). Armed server + typed confirmation
   → the forget receipt; the dataset is gone (disposable demo store only).

## Two trust domains (isolation)

The page has two tabs: **A · notes** (`notes.*` namespace) and **B · vault** (`vault.*`).
Each is a `createCogneePack()` + `createRuntime()` pair with its **own store root, own
worker process, own lock** (contract §3/§8; a second pack on the same store refuses —
C5-proven, not re-checked here). Checks C4a–C4c verify: B's status never names A's
datasets; B's searches never return A's content; foreign-namespace scopes are refused at
the boundary (and would be refused by the worker's `--allow-ns` rail regardless).
**Namespaces are a store-safety rail, NOT end-user authorization** — the pilot is
single-user and holds its authority profile server-side (like the Stage 05 reference app);
real per-actor authorization is an application/runtime concern outside this pack.

## Security-boundary summary (what denies what)

- The browser can only `POST /api/act`; the server maps and guards every input
  (`mapActionInput`): scope, content limits, confirmation typing.
- The server holds the authority grants; the browser cannot grant itself permissions.
- Irreversible deletion: denied by default by VICT's effect policy; the armed path needs
  (1) the server started with `PILOT_ALLOW_IRREVERSIBLE=1`, (2) `{policy:{allowIrreversible:true}}`
  attached server-side, (3) typed dataset-name confirmation.
- The pack's own rails beneath all of this: keyed-only writes, mandatory scope, namespace
  guard, store ownership lock with precise release (C5).

## Focused checks (not the C0–C5 batteries)

```bat
npm run checks     :: spawns the server twice; ~13 focused assertions (C1–C6)
```

C1 owner flow (add→cognify→scoped search) · C2 verbatim candidates + summaries search ·
C3 restart persistence · C4 cross-domain isolation · C5 default denial / armed delete on
disposable data · C6 boundary refusals. Results land in `checks-summary.json`
(resource observations included: free RAM start/end, worker RSS).

## Why not the declarative `vict.application@2` host?

VICT's browser-app shape is the Stage 05 reference app (declarative
`vict.application@2` definition rendered by the generic `renderer-svelte` host). This
pilot mirrors its **architectural discipline** (server holds runtime + authority; explicit
act boundary; "the boundary — not button visibility — denies") but keeps app code thin
per the C6 mandate; the declarative host's plan/component machinery would add hundreds of
lines for a disposable pilot. The Vict Builder Kit (`@victframework/builder-kit@0.1.0`)
is the builder-bootstrapping protocol layer (context/task packs, `init-app` provenance,
freshness gate) and is explicitly **not a release-set member** — using `init-app` here
would add ceremony without changing the consumer surface; noted as the natural next step
if this pilot graduates to a real product.

## Resource observations

See `capture/WALKTHROUGH.md` for the recorded run: worker RSS ≈ 315–343 MB steady,
cognify peak ≈ 2.0 GB (the C4/C5 "Windows low-memory class" re-observed — with <1 GB
free, a SECOND concurrent worker can fail its GLiNER load with "paging file is too
small"; the pack contains it as a typed failure), add ≈ 16–59 s (cold boot included),
cognify ≈ 17–30 s, scoped search ≈ 0.4–0.6 s.

## Notes

- `vendor/` and `.pilot-stores/` are gitignored; `setup.mjs` regenerates them.
- The stores are **disposable by construction** (`.pilot-stores/`, tiny, local, keyless).
- All six capabilities are exercised through VICT graphs: add, cognify (durable keyed
  runs with retry policies), searchChunks/searchSummaries/datasetsStatus (reads),
  forgetDataset (irreversible, explicit policy only).