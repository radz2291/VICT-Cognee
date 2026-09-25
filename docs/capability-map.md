# Cognee capability map — C0 inventory against the VICT pack model

Status: discovery deliverable (C0). No pack design, no pack implementation.
Reference: VICT-SYSTEM-REFERENCE.md **v0.4.32** (SHA-256 `dc43c167…`, per builder-kit
content-address record), read at radz2291/vict-02 `a746c341…`.
Target inventoried: topoteretes/cognee tag **v1.6.1** @ `eb90d037…` (Python package
`cognee==1.6.1`; TS binding `@cognee/cognee-ts@0.2.0` inspected separately).

Legend — classification classes:

- **FRC** first-release candidate (core memory loop the pack would need on day one)
- **LATER** real capability, deferred past first release
- **PROV** provider-specific (cognee implementation/broker detail, exposed but not
  normalized by the pack)
- **EXCL** excluded from the pack boundary entirely (conflicts with VICT semantics
  or duplicates a VICT-owned concern)

Evidence codes: `[D]` from cognee source/docs at the pinned tag (not observed here);
`[O]` observed in the C1 proof run (`proof/results/*.json`, `proof/*.output.txt`).

---

## 1. Main memory operations

| # | Capability (cognee surface) | Effect class (VICT view) | Class | Reason |
| --- | --- | --- | --- | --- |
| 1.1 | `cognee.add(data, dataset_name, node_set, …)` — ingest raw text/files/URLs/binary into a dataset `[O]` | write | FRC | The store leg of the memory loop; maps to a VICT `write` capability with idempotency policy (content-hash dedup observed in battery 05) |
| 1.2 | `cognee.cognify(datasets, extractor, …)` — build/extend the knowledge graph `[O]` | write (long-running) | FRC | The derive leg; CPU-bound pipeline with embedded DBs; needs run_in_background/poll semantics in a pack |
| 1.3 | `cognee.search(query, query_type, datasets, node_name, top_k)` — 20 search types `[O]` | read | FRC (subset) | The retrieve leg; retrieval-only types first (see §3) |
| 1.4 | `cognee.remember(data, dataset_name, session_id?, …)` = add+cognify+improve `[D]` | write | FRC (or LATER) | V2 convenience wrapper; pack may expose raw legs instead to keep effect boundaries explicit — decision recorded in §10 |
| 1.5 | `cognee.recall(query, datasets, session_id?)` — session-first rule-based retrieval router `[O]` | read | FRC (subset) | Router degrades to CHUNKS when no LLM is configured (`llm_available()` preflight, `[D]` source); observed routing in battery 02 |
| 1.6 | `cognee.forget(data_id / dataset / everything, memory_only)` — unified deletion `[O]` | write (arguably irreversible for dataset/everything) | FRC (dataset-scope only; item-scope deferred — residue open finding) | Retention/deletion is a VICT Stage-07D-proven concern; dataset-level forget observed clean at name-resolution level (physical purge unverified); item-level forget leaves a phantom vector hit (proof §7, open finding) |
| 1.7 | `cognee.update(data_id, data, dataset_id)` — in-place document replace `[O]` | write | FRC | Corrected-information path; keeps data_id, re-extracts touched chunks (docs claim `[D]`; observed battery 04) |
| 1.8 | `cognee.delete(data_id, dataset_id, mode)` — deprecated alias of datasets.delete_data `[D]` | write | EXCL | Deprecated surface; pack binds to `forget`/`datasets.delete_data` only |
| 1.9 | `cognee.prune.prune_data / prune_system(graph, vector, metadata, cache)` `[O]` | irreversible | EXCL (pack) / FRC (tooling) | Full-system teardown incl. users/ACLs registry — test fixture only; a product pack must never expose it as a capability |
| 1.10 | `cognee.memify()` — triplet-embedding enrichment pass `[D]` | write | LATER | Required only for TRIPLET_COMPLETION search; not in the first-release retrieval subset |

## 2. V2 memory-object operations

| # | Capability | Effect | Class | Reason |
| --- | --- | --- | --- | --- |
| 2.1 | `remember(QAEntry/TraceEntry/FeedbackEntry, session_id)` — session memory objects without graph write `[D]` | write | LATER | Session tier is useful for agent conversations (Quellight-flavored) but the first release proves the dataset/graph tier |
| 2.2 | `cognee.session.get_session / add_feedback / delete_feedback` `[D]` | read/write | LATER | Same session tier; feedback loops depend on it |
| 2.3 | `cognee.improve(dataset, session_ids, build_global_context_index, build_truth_subspace)` — 9-stage self-improvement pipeline `[D]` | write | LATER | Feedback-distillation into the graph is powerful but needs LLM for most stages (`no_llm_configured` skip reasons `[D]`); deferred |
| 2.4 | `@cognee.agent_memory` decorator, `cognee.agent` registration/verification `[D]` | — | EXCL | Agent-framework integration duplicates what VICT's `@victframework/mastra` + capability governance already own |
| 2.5 | `cognee.tools` — authorized external DB connections for recall "tools" scope `[D]` | read/write | EXCL | VICT grants ports through capability context (CAP-004); a second tool-connection broker would bypass the authority model |

## 3. Retrieval types (SearchType enum, 20 values)

| Type | Needs LLM | Class | Reason |
| --- | --- | --- | --- |
| CHUNKS `[O]` | no | **FRC** | Passage-level semantic retrieval; observed 0.34–0.67s warm |
| CHUNKS_LEXICAL `[O]` | no | **FRC** | BM25 lexical; deterministic evidence |
| SUMMARIES `[O]` | no (gliner builds summaries) / yes (cloud mode) | **FRC** (with caveat) | Summary *build* is LLM-dependent in cloud mode; keyless gliner mode produced summaries `[O]` |
| GRAPH_COMPLETION `only_context=True` `[O]` | no | **FRC** | Graph-context evidence without answer synthesis; the pack's graph-evidence read |
| HYBRID_COMPLETION / GRAPH_COMPLETION / RAG_COMPLETION / TRIPLET_COMPLETION / GRAPH_COMPLETION_COT / _DECOMPOSITION / _CONTEXT_EXTENSION / GRAPH_SUMMARY_COMPLETION | yes | LATER | Answer-synthesis types; untestable keyless; expose after an LLM-port story exists (VICT mastra adapter precedent) |
| TEMPORAL | yes | LATER | Time-aware retrieval; extraction also needs temporal cognify |
| NATURAL_LANGUAGE | yes | LATER | NL→graph query translation |
| CYPHER | no (execution) but gated | PROV | Raw Cypher gated by `ALLOW_CYPHER_QUERY`; graph-engine-specific syntax (ladybug/Kuzu dialect) — provider-specific, not normalized |
| GRAPH_REPORT | LLM for suggested questions | LATER | Insight report (hub nodes, cross-node_set links) |
| CODING_RULES | — | EXCL | Domain-specific store (coding rules) irrelevant to VICT consumers |
| SKILLS | no | EXCL | SKILL.md playbook discovery — overlaps VICT's own skill/builder-kit model |
| CODE | no | LATER/PROV | Deterministic code-graph operations (callers, impact) — interesting but separate scope; needs repo ingestion |
| AGENTIC_COMPLETION | yes | EXCL (first) | Multi-step agent loop with tools/skills — VICT does not let a memory pack run an agent |
| FEELING_LUCKY | yes | EXCL | Non-deterministic routing gimmick; no governance value |

## 4. Datasets, permissions, users

| # | Capability | Effect | Class | Reason |
| --- | --- | --- | --- | --- |
| 4.1 | `datasets.list_datasets / list_data / get_status / get_progress / has_data` `[O]` | read | FRC | Operational visibility the pack needs for status reporting |
| 4.2 | Dataset isolation (per-dataset graph/vector namespaces) `[O]` | — | FRC | Primary isolation mechanism; observed disjoint results in battery 03 |
| 4.3 | NodeSets (`node_set=` tags at add; `node_name=` filter at search) `[O]` | — | FRC | Lightweight intra-dataset scoping (per-user/per-topic buckets) |
| 4.4 | Multi-user: `get_default_user`, `create_user`, per-user dataset authorization `[O]` | — | FRC (thin) | Keyless default posture is auth=required + multi_tenant=enabled `[O]`; pack maps VICT actor → cognee user; full tenant/role surface deferred |
| 4.5 | HTTP permission routers: roles, tenants, `give_datasets_permission_to_principal`, `revoke…` `[D]` | write | LATER | Server-surface ACL administration; needs the FastAPI server, not the embedded path |
| 4.6 | `agents.create/register/unregister/connections` — agent identities with scoped access `[D]` | write | LATER | Maps to VICT actor model; interesting but not first release |
| 4.7 | `api_keys`, cloud module, push/sync `[D]` | — | EXCL | Cognee Cloud / remote-sync surface conflicts with VICT local-first topology and data-control requirements |

## 5. Graph access

| # | Capability | Effect | Class | Reason |
| --- | --- | --- | --- | --- |
| 5.1 | `graph engine interface`: get_graph_data, get_node(s), add/delete node/edge, source-ref provenance finders `[D]` | read/write | PROV | Raw engine access stays behind the pack; pack exposes read-only inspection capability (counts, graph snapshot via export) instead |
| 5.2 | `cognee.visualize_graph(path, query?, full=?)` — bounded subgraph HTML render `[D]` | read | LATER | Useful operator surface; needs graph + template rendering; bounded by default (k-hop, max 500 nodes) `[D]` |
| 5.3 | `cognee.export(dataset, format=[cogx,json,graphml,cypher], destination)` — GraphSnapshot `[D]` | read | LATER | Portability/backup story; aligns with VICT export/retention obligations later |
| 5.4 | `cognee.validate(dataset)` — cross-store graph/vector consistency report, read-only `[D]` | read | LATER | Excellent fit for VICT verification culture; needs evidence in a later proof. Not claimed to repair the observed item-level residue |
| 5.5 | `cognee.report(datasets)` — markdown graph insight report `[D]` | read | LATER | Convenience over graph inspection |
| 5.6 | CYPHER search type (see §3) | read | PROV | Engine-dialect raw query; excluded from normalized surface |

## 6. Customization

| # | Capability | Effect | Class | Reason |
| --- | --- | --- | --- | --- |
| 6.1 | `graph_model=` custom Pydantic/DataPoint extraction schema; `add_data_points` direct insertion `[D]` | write | LATER | Schema-shaped memory is the strongest customization hook; requires per-consumer models — pack passes them through, first release proves generic loop |
| 6.2 | `custom_prompt=` extraction steering `[D]` | write | LATER | LLM-mode only |
| 6.3 | `ontology_file_path=` ontology grounding; `ontologies` API `[D]` | write | LATER | Enterprise-adjacent; later |
| 6.4 | `run_custom_pipeline(tasks=Task[…])` — arbitrary task graphs `[D]` | write | EXCL | Raw pipeline authorship would let a pack consumer bypass effect declarations; VICT capabilities are the only executable boundary |
| 6.5 | Extractor selection: `extractor="llm" / "gliner_demo"` (+ enterprise GLiNER) `[O]` | — | PROV | Extraction engine is a provider detail; pack pins one default and records it |
| 6.6 | Chunker/chunk_size/chunk_overlap config `[D]` | — | PROV | Tunables passed through configuration, not capabilities |

## 7. Operational behavior

| # | Area | Observed/documented | Class |
| --- | --- | --- | --- |
| 7.1 | Embedded defaults: vector=lancedb, graph=ladybug, relational=sqlite `[O]` | Zero external services; aligns with VICT local-first topology | FRC (as config) |
| 7.2 | Storage roots redirectable via env (`SYSTEM_ROOT_DIRECTORY`, `DATA_ROOT_DIRECTORY`, `CACHE_ROOT_DIRECTORY`, `LOGS_ROOT_DIRECTORY`) `[O]` | Required for embedding under a VICT app data dir | FRC (as config) |
| 7.3 | Keyless local mode: `GRAPH_EXTRACTOR=auto` → gliner_demo; fastembed bge-small embeddings `[O]` | Entire add→cognify→search loop runs without any LLM key | FRC (evidence) |
| 7.4 | Model caches: fastembed → `%TEMP%/fastembed_cache` (FASTEMBED_CACHE_PATH), gliner → `~/.cache/huggingface` (HF_HOME) `[O]` | Pack must document/pin cache locations; first cognify downloads ~817MB models | FRC (setup doc) |
| 7.5 | Import cost ~13–17s; first cognify 224s incl. model download; warm CHUNKS ~0.3–0.7s `[O]` | Latency envelope for pack design | evidence |
| 7.6 | `config.set(key, value, persist=True)` writes `.env` in CWD `[D]` | Side-effecting config persistence outside process memory — pack uses env vars instead | EXCL (surface) |
| 7.7 | Sessions cache (CACHING=true default), AUTO_FEEDBACK structured-LLM call default-on `[D]` | LLM-dependent defaults must be disabled in keyless/pure-local deployments `[O]` (AUTO_FEEDBACK=false set) | FRC (config) |
| 7.8 | Recall warm-up short-circuit: ungrown datasets return "memory warming up" marker instead of running search `[D]` | Observable degradation semantics | evidence later |
| 7.9 | Telemetry: `run_tasks_with_telemetry()` pipeline events; `COGNEE_TRACING_ENABLED`; Langfuse auto-enable if keys present `[D]` | Pack must pin observability to VICT event emission | FRC (config) |
| 7.10 | Alembic relational migrations run automatically at setup `[O]` | Versioned migrations — matches VICT store discipline | evidence |

## 8. Surfaces (how cognee is driven)

| Surface | Class | Reason |
| --- | --- | --- |
| Python SDK (separate worker process) `[O]` | **FRC route** | The reference engine; full capability surface; cognee is Python, so the pack drives it from Node in a **separate worker process** via a bridge (never in the Node process) |
| HTTP API server (cognee-frontend, FastAPI) `[D]` | LATER | Needed for remote/multi-process deployment; VICT already owns its server boundary — a cognee sidecar server would be a deployment choice, not a pack API |
| MCP server (cognee-mcp: remember/recall/forget/improve/cognify_status) `[D]` | PROV | Alternative integration route for agent hosts; bypasses VICT capability governance — not the pack route |
| TypeScript SDK `@cognee/cognee-ts@0.2.0` (cognee-rs Rust engine, Neon bindings) `[D]` | PROV/LATER | Separate Rust implementation: 16 search types (no AGENTIC_COMPLETION/CODE/GRAPH_REPORT/SKILLS/DECOMPOSITION; has FEEDBACK), different default backends (Kuzu graph, brute-force vector). **Not** the same engine — data written by Python is not shared. Parity risk too high for first release; Python route recommended, TS engine tracked |
| CLI (cognee-cli) `[D]` | EXCL | Operator convenience only; VICT owns its CLI |

## 9. Consumer fit notes (read-only inspections)

- **Quellight** @ `5f709a53…` (release set 0.3.1): governed-memory philosophy — proposals,
  user-confirmed ceremony, quiet inbox, retention/deletion, deterministic context assembly;
  the agent has NO direct read path to memory. A cognee pack complements this as an
  evidence-store: `read` capabilities return graph context the agent may consume as data;
  all writes stay user-attributed or proposal-bound. NodeSets ≈ per-user memory buckets.
- **Trading OS** @ `38f654e2…` (release set 0.1.1): product-defined capability catalog
  (analysis/rule/judgment/risk/execution) with typed fields; journal/rules content is a
  natural knowledge-graph fit (rule corrections = battery-04 correction path). Trading OS
  consumes an older release set — a pack must support consumers across set versions or
  state a minimum.

## 10. Open design inputs carried to review (not decisions)

1. `remember` (1.4) convenience vs explicit add/cognify legs — effect-boundary clarity
   favors explicit legs in the pack; decision deferred to pack design stage.
2. Completion-type searches need an LLM port decision (probably via the existing mastra
   adapter pattern or an OpenAI-compatible endpoint configured by the host).
3. Which deletion operations map to `write` vs `irreversible` effect classes.
4. Minimum VICT release-set version a pack binary can state (`victCompatibility`).
