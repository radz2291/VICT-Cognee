# C1 proof report — pinned cognee 1.6.1 against synthetic Quellight-like and Trading-like data

Status: discovery deliverable (C1). Observed-behavior report only. No pack design, no
pack implementation. Stop for review.

Everything in §4–§11 is **observed** in the runs cited. Everything marked **[D]** is
documented/source-derived at the pinned tag and was not executed here. Documentation
claims and observations are kept separate throughout.

## 1. Provenance and pinning

| Item | Value |
| --- | --- |
| Cognee upstream | https://github.com/topoteretes/cognee, tag `v1.6.1` @ `eb90d03740755f5252b8b12cce91fd09970f2d81` (2026-09-24) |
| Python package | `cognee==1.6.1` (+ `gliner2==2.0.0`, `torch==2.14.0`, `fastembed==0.8.0`, `lancedb==0.39.0`, `ladybug==0.19.0`, `litellm==1.96.2`; full freeze: `proof/requirements-frozen.txt`, 176 packages) |
| TypeScript binding | `@cognee/cognee-ts@0.2.0` (npm; Neon bindings to topoteretes/cognee-rs — a **separate Rust engine**) |
| Python | 3.12.10 (Windows 11, 10.0.26200) |
| Node | 22.13.1 |
| VICT reference read | `docs/VICT-SYSTEM-REFERENCE.md` v0.4.32, SHA-256 `dc43c1672c3f75da886325f236945a40fe0b6c79a373b8da6a0763612c4baa42` (matches builder-kit content-address record) at radz2291/vict-02 `a746c34173838eb583d85a909207b6a0a7c7c832` |
| Consumer inspections (read-only) | Quellight `5f709a536ab1f4d5fea0407db1b9537e0aa7c0f6` (release set 0.3.1); Trading OS `38f654e2ceffa0455fd5e7c2f1b4da24d73aea25` (release set 0.1.1) |
| VICT/Quellight/Trading remotes | verified equal to local HEADs via `git ls-remote` before reliance; working trees clean (VICT had untracked `.pi/` only) |

## 2. Test route

No LLM API key and no Ollama were available, so the proof ran cognee's documented
keyless-local route (this is itself an operational capability):

- `EMBEDDING_PROVIDER=fastembed`, `EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`, 384 dims (local ONNX embeddings)
- `GRAPH_EXTRACTOR=gliner_demo` (LLM-free extraction + summaries; the source notes
  `GRAPH_EXTRACTOR=auto` picks this whenever no usable LLM key exists `[D]`)
- embedded defaults otherwise: `VECTOR_DB_PROVIDER=lancedb`, `GRAPH_DATABASE_PROVIDER=ladybug`, `DB_PROVIDER=sqlite`
- all storage roots redirected into the disposable workspace (`SYSTEM_ROOT_DIRECTORY`, `DATA_ROOT_DIRECTORY`, `CACHE_ROOT_DIRECTORY`, `LOGS_ROOT_DIRECTORY`, `COGNEE_REPOS_DIR`)

Consequence (recorded, not hidden): **completion-type searches and LLM-based
extraction/update paths are untested.** Retrieval, scoping, deletion, conflicts,
corrections, repeated ingestion, and failure behavior are observed at the
retrieval/context level.

## 3. Environment setup findings (all observed)

1. `pip install "cognee[gliner]==1.6.1"` → clean install, 176 transitive packages (includes torch).
2. Setting `EMBEDDING_PROVIDER=fastembed` **without** `EMBEDDING_MODEL` keeps the cloud
   default `openai/text-embedding-3-large` and fastembed rejects it at engine construction
   (`ValueError: Model openai/text-embedding-3-large is not supported…`). Provider, model,
   and dimensions must be set together.
3. Default roots live **inside site-packages** (`.cognee_system`) and `~/.cognee` unless
   redirected; a pack must pin roots to app data.
4. First-run model downloads: bge-small (67 MB → `%TEMP%\fastembed_cache`,
   `FASTEMBED_CACHE_PATH`) + `fastino/gliner2.5-base-v1` (750 MB → `~/.cache/huggingface`,
   `HF_HOME`). ~817 MB one-time.
5. Import cost 13–17 s. Alembic relational migrations run automatically at setup and are
   idempotent (`[O]` "Relational migrations applied (target head)").
6. gliner mode logs "Skipping LLM connection test: this pipeline has no LLM task."
7. Default auth posture: `authentication=required, multi_tenant=enabled` (startup log).
8. **Intermittent native segfault (exit 139) during battery cognify runs** on this
   Windows machine — **agent observation, not a reproduced finding**. The crashes were
   seen only in the agent's interactive tmux session (5 exit-139 events across ~10
   battery process starts; logs were overwritten by retries and no crash transcript was
   committed). A bounded reproduction attempt is committed as
   `proof/crash-reproduction.log`: 3/3 standalone gliner loader runs at ~2.4 GB free RAM
   **succeeded without thread limits**, so the loader-only path does not reproduce the
   crash. The suspected memory correlation and the success of single-thread env limits
   (`OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KUZU_BUFFER_POOL_SIZE=268435456`) therefore
   remain **unverified working hypotheses**, and `run_proof.sh` ships with those limits
   as a precaution, not a proven fix.

## 4. Retrieval evidence (battery_02; `proof/results/battery_02_retrieval.json`)

Setup: two datasets (`quellight_like`, `trading_like`) cognified warm in 39.8 s (both).

| Probe | Observed |
| --- | --- |
| CHUNKS, dataset-scoped | 1 hit in 0.28–0.48 s; envelope `{dataset_id, dataset_name, dataset_tenant_id, search_result[]}`; result items carry `text`, type `DocumentChunk` |
| CHUNKS cross-dataset (2 datasets) | 2 hits, 0.36 s |
| CHUNKS_LEXICAL (BM25) hit | 1 hit, 0.26 s |
| CHUNKS_LEXICAL nonsense term | **1 hit returned anyway** — source shows BM25 scores all chunks and returns top-k with no threshold (`lexical_retriever.py`: zero-score chunks still returned) `[D source, O behavior]`. A pack must filter by score (`with_scores=True` exists) |
| SUMMARIES | 1 hit, 0.27 s (gliner mode builds summaries without an LLM) |
| GRAPH_COMPLETION `only_context=True` | context string ("The question is: … node1 -- relation -- node2 triplets"), 0.54 s |
| GRAPH_COMPLETION (answer synthesis) | typed failure `LLMAPIKeyNotSetError` (422) with actionable fix message in 0.36 s — **clean failure hygiene** |
| `recall()` routing | returns source-tagged entries (`ResponseGraphEntry(kind='chunk', search_type='CHUNKS', …)`) — the documented no-LLM CHUNKS degradation `[D]` was observed |

## 5. Scope isolation (battery_03/03b/03c; `results/battery_03*.json`)

| Probe | Observed |
| --- | --- |
| Dataset isolation | **Zero identity overlap** between datasets for the same query; a trader-only query scoped to `alice_world` returned only alice content (a matched-but-irrelevant fallback chunk from *within the same dataset* — the top-k/no-threshold behavior again — never another dataset's content) |
| Default scope, no `datasets` arg | both of the user's datasets visible (`datasets_seen: [alice_world, trader_world]`) |
| NodeSets | `node_name=['preferences']` and `['incidents']` returned different chunk identities with the correct texts; unscoped returned both |
| Multi-user | `create_user(trader-b@example.com)` OK (note: `.proof.local`-style reserved domains are rejected by email validation). Default user querying user B's dataset by name → `DatasetNotFoundError: "Dataset names resolve only among the datasets you own in the current tenant; pass dataset_ids for datasets shared with you."` (404). Default user's **unrestricted** search for the secret → 0 hits, 0 datasets. Owner search → exact text returned. **Isolation verified at name resolution, unscoped search, and owner-read layers** |
| `datasets.list_data/get_status` | worked; status reported `DATASET_PROCESSING_COMPLETED` |

## 6. Conflicting and corrected information (battery_04/04b; `results/battery_04*.json`)

1. **Conflicts (ingested together)**: graph keeps BOTH edges — direct graph read shows
   `backup job occurred_on Saturday` AND `backup job occurred_on Sunday` (10 nodes/12
   edges). No contradiction detection, no supersession. Chunk level: both statements in
   one passage.
2. **Correction (new statement after graph exists)**: chunk retrieval returns both old and
   new passages, ranked per-query (old text first for the old query, new first for the new).
   Graph level: the extractor **merged the values into one node** — `quantity: 100, 250
   requests per minute`. Corrections are **additive at graph level, not superseding**.
3. **`update()` in place**: fails keyless with `LLMAPIKeyNotSetError` — the update path
   requires an LLM even in gliner mode. Correction-in-place is therefore an **LLM-gated
   surface**; keyless correction = add new + forget old.
4. Completion-level adjudication ("which answer wins"): **untested** (needs an LLM key).

## 7. Repeated ingestion and deletion (battery_05/05b; `results/battery_05*.json`)

| Probe | Observed |
| --- | --- |
| `add()` ×3 identical document | three `PipelineRunCompleted` returns, **one stored data item** — content-hash dedup at the registry layer |
| `cognify()` twice on unchanged dataset | 0.35 s / 0.38 s — incremental loading is real; no duplication (search hit count stable) |
| `forget(data_id=…)` | `{'status': 'success'}`; registry count 0 |
| **Residue probe** | after forget + re-cognify, CHUNKS still returns **1 hit with empty text**; direct graph read shows **0 nodes / 0 edges** — the graph layer is clean but the **vector layer keeps a phantom embedding row** that still surfaces (contentless hit). **OPEN FINDING — no repair demonstrated.** `cognee.validate()` is documented for cross-store consistency `[D]` but was **not run**; nothing here shows that it repairs, compacts, or even detects this residue |
| `forget(dataset=…)` | success; later search by name → `DatasetNotFoundError` (404). **This proves only that name resolution fails after deletion; physical purge of the dataset's graph/vector storage was NOT verified** (no direct storage read was taken after dataset forget — unlike the item-level probe above). Registry row removal is likewise unverified at storage level |
| `prune_system(metadata=True)` | drops the relational layer including users; a subsequent `setup()` is required before any user op (observed `DatabaseNotCreatedError` otherwise) — matches the "full test teardown" docs `[D]` |

## 8. Failure behavior (battery_06; `results/battery_06_failures.json`)

| Probe | Observed |
| --- | --- |
| search nonexistent dataset | returns quickly (0.07 s) without leaking other datasets |
| cognify nonexistent dataset | surfaced as a typed error (no partial writes observed) |
| `add(12345)` (unsupported input) | rejected with a typed error before ingestion |
| `forget(random uuid)` | typed not-found failure in 0.10 s (no crash) |
| GRAPH_COMPLETION without key | `LLMAPIKeyNotSetError` (422), actionable message, raw key material never echoed |
| `datasets.get_status` | per-dataset `DATASET_PROCESSING_COMPLETED` map |
| Windows segfault risk | see §3.8 — process-level, intermittent, memory-correlated |

## 9. TypeScript SDK comparison (`@cognee/cognee-ts@0.2.0`)

- **Separate engine**: NAPI bindings to cognee-rs (Rust). Creates its own
  `.cognee_system/databases/cognee.lancedb` in CWD. Data written by the Python engine is
  not shared (different implementations, different default backends — Kuzu graph,
  brute-force vector per its config surface `[D types/README]`).
- **Surface parity gap**: 16 search-type wire names vs Python's 20 (missing
  `AGENTIC_COMPLETION`, `CODE`, `GRAPH_REPORT`, `SKILLS`,
  `GRAPH_COMPLETION_DECOMPOSITION`; adds `FEEDBACK`). Mirrors remember/recall/forget/
  improve/memify/update/prune/datasets/sessions/notebooks/users.
- **Observed keyless behavior** (tested configuration: `@cognee/cognee-ts@0.2.0`, Node
  22.13.1, Windows 11): `new Cognee({}).warm()` fails cleanly with
  `ComponentError: llm_api_key must be configured`. **No keyless local mode exists in
  the tested TS SDK version** — the entire keyless proof route is Python-only. This
  result applies to the tested version/environment only; other versions were not tried.
- Verdict input: the Python API is the only route currently testable end-to-end; the TS
  engine is a tracked-but-later alternative.

## 10. Untested (explicit)

1. All completion-type searches (HYBRID/GRAPH/RAG/TRIPLET_COMPLETION, COT, decomposition,
   context-extension, summaries completion, TEMPORAL, NATURAL_LANGUAGE, AGENTIC, CODE,
   GRAPH_REPORT, FEELING_LUCKY) — need an LLM key.
2. LLM-based extraction quality (`extractor="llm"`), `custom_prompt`, ontologies — LLM-gated.
3. `update()` in place — LLM-gated (§6.3).
4. `improve()` stages with sessions/feedback — LLM-gated for distillation stages (`[D]`
   `no_llm_configured` skip reasons; only triplet enrichment is LLM-free).
5. HTTP server, MCP server, cloud/sync, push — server surfaces out of the embedded scope.
6. TS SDK pipeline end-to-end — needs an LLM key (§9).
7. Cross-user deletion cascades and tenant/role ACL routers — needs a server deployment.
8. Concurrency/throughput and graph-database subprocess isolation on Windows.
9. cognee's `validate()` against the observed vector residue (**candidate, untested —
   no claim is made that it repairs the residue**).
10. Non-English embedding/extraction alternatives (battery 07 observes the
    English-focused defaults on Malay input; no comparative benchmark was run).

## 11. Practical latency envelope (observed, this machine)

| Operation | Time |
| --- | --- |
| `import cognee` | 13–17 s |
| cold cognify (first ever; includes 817 MB model downloads) | 224.5 s |
| warm cognify, 2 datasets | 39.8 s |
| warm cognify, 1 small dataset | ~20–35 s (battery wall-clock segments) |
| re-cognify unchanged dataset | 0.35–0.38 s |
| gliner model load (warm cache) | 14–23 s per process |
| CHUNKS / CHUNKS_LEXICAL / SUMMARIES search | 0.24–0.72 s |
| `add()` ingestion of a small text | <0.1 s (pipeline commit) |
| `forget(data_id)` | 1.1 s (with the open residue finding, §7) |
| `forget(dataset)` | <1 s (name-resolution clean; physical purge unverified, §7) |

## 11b. Malay / mixed Malay–English retrieval probe (battery_07; correction pass)

Synthetic Quellight-like Malay content (`proof/data/malay_probe.txt`: 5 entries —
preferences, world lore, a mixed-language proposal record, an event, a correction).
Embedding `BAAI/bge-small-en-v1.5` (English-focused), extraction `gliner_demo`
(`fastino/gliner2.5-base-v1`, English-focused). Full numbers in
`proof/results/battery_07_malay.json`.

Results summary (filled from the committed run):

<!-- MALAY_RESULTS -->

## 12. Reproduce

Fresh clone (tested flow — Windows 11, Git for Windows/MINGW64 bash, Python 3.12):

```bash
# 1. verify pinned SHAs before anything else
git ls-remote https://github.com/radz2291/vict-02.git HEAD          # a746c34173838eb583d85a909207b6a0a7c7c832
git ls-remote https://github.com/radz2291/Quellight.git HEAD        # 5f709a536ab1f4d5fea0407db1b9537e0aa7c0f6
git ls-remote https://github.com/radz2291/VICT-Trading.git HEAD     # 38f654e2ceffa0455fd5e7c2f1b4da24d73aea25
git ls-remote https://github.com/topoteretes/cognee.git refs/tags/v1.6.1  # eb90d03740755f5252b8b12cce91fd09970f2d81

# 2. clone this workspace and run everything
git clone https://github.com/radz2291/VICT-Cognee.git
cd VICT-Cognee/proof
bash run_proof.sh                 # venv + cognee[gliner]==1.6.1 + .env generation + all batteries
```

`run_proof.sh` generates `proof/.env` from the committed credential-free
`proof/.env.example` (substituting the absolute proof directory for `@PROOF_DIR@`),
exports the single-thread native limits, and runs smoke_01 plus batteries 02, 03, 03b,
03c, 04, 04b, 05, 05b, 06, and 07 **sequentially**. Committed fixtures in `proof/data/`
are the only inputs. Models download once into user caches outside the repo
(`~/.cache/huggingface`, `%TEMP%/fastembed_cache`); all runtime databases stay under
`proof/.cognee/` (gitignored). Equivalent manual commands: `python -m venv .venv`,
`.venv/Scripts/python -m pip install "cognee[gliner]==1.6.1"`, then per battery
`OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KUZU_BUFFER_POOL_SIZE=268435456 \
.venv/Scripts/python battery_XX.py > battery_XX.output.txt 2>&1`.

TypeScript probe (separate Rust engine; requires an LLM key past `warm()`;
result scoped to `@cognee/cognee-ts@0.2.0`):

```bash
cd ../ts-sdk && npm install @cognee/cognee-ts@0.2.0 && node probe_keyless.mjs
```

Notes: run batteries **sequentially** (never two cognee processes on one system root);
`run_proof.sh` ships the single-thread env limits as a precaution (§3.8 — agent
observation, not a reproduced finding).
