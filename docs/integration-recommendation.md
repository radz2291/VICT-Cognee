# Integration route recommendation and proposed first-release boundary

Status: discovery deliverable (C0/C1). A recommendation for owner review — **not** a pack
design, **not** an implementation. Companion to `docs/capability-map.md` and
`docs/proof-report.md`.

## 1. Recommended integration route

**`@victframework/cognee`: a capability pack that drives the Python cognee engine in a
separate worker process, wired to the Node host through a small bridge.** cognee is a
Python library — it **cannot** be loaded into the Node host process; any pack is
necessarily a two-process design.

| Decision | Recommendation | Basis (all observed unless noted) |
| --- | --- | --- |
| Engine | Python `cognee==1.6.x` (pinned exact) running as a **separate worker process** beside the Node host | Only route with a working keyless-local mode; full surface (§ proof report); TS engine (`@cognee/cognee-ts@0.2.0`, tested configuration) is a separate Rust implementation with parity gaps and no keyless mode — and would not need a second process, but is not the proven surface |
| Wiring | A capability pack whose capabilities call the Python surface **from Node via a small bridge to the worker process** (child process or local HTTP are the candidate shapes) | VICT hosts are Node/TypeScript (`@victframework/*`); cognee is Python, so a separate process is mandatory, not optional. Candidate bridge shapes keep cognee out of the kernel/runtime import graph (ARCH-013) and behind effect-declared capabilities (CAP-002). Final bridge choice is a pack-design decision, not made here |
| Retrieval subset (first release) | `CHUNKS`, `CHUNKS_LEXICAL`, `SUMMARIES`, `GRAPH_COMPLETION` with `only_context=True` | Proven keyless, sub-second, evidence-shaped; completion types wait for an LLM-port story |
| Write subset (first release) | `add`, `cognify`, `forget` (**dataset-level only**), `datasets.list_data/get_status` | All proven; `update` excluded (LLM-gated), `remember`/`improve` deferred |
| Isolation model | 1 cognee dataset per VICT consumer-scope (e.g. per user or per workspace) + NodeSets for sub-scoping; map VICT actor → cognee user for the multi-user path | Dataset isolation proven (0 identity overlap); node_set filtering proven; user isolation proven at three layers; avoids cognee tenants/roles (server surface) in first release |
| Deletion posture | **Dataset-level `forget` only** in the first-release surface. C2 update: file-level physical purge of the dataset's graph/vector stores observed and verified after restart (c2-feasibility-report §5). Item-level `forget` is **not exposed at all** (leaves a phantom vector hit; no repair demonstrated) | Item-level forget leaves a phantom vector hit (proof §7, open finding); dataset-level purge verified at file level in C2 |
| Deployment defaults | Embedded lancedb + ladybug + sqlite, storage roots redirected under VICT app-data, model caches pinned via `FASTEMBED_CACHE_PATH`/`HF_HOME`, `AUTO_FEEDBACK=false`, telemetry off unless the host opts in | Proof §3 findings; local-first alignment |
| Effect classes (proposal input) | `add`=write (idempotent by content hash), `cognify`=write (long-running), `search*`=read, `forget(dataset)`=write (purge depth unresolved — open finding), `prune`/`forget(everything)`=irreversible (excluded from pack surface) | Maps observed behavior onto the VICT effect model; final classes are pack-design decisions |
| Version policy | Pin exact cognee version in the pack; declare `victCompatibility` against the release set the pack is verified with | Upstream moves fast (v1.6.1 is days old); ECO-002 compatibility obligation |

Rejected routes (with reasons):

- **cognee MCP server as the integration** — bypasses VICT capability governance; a
  second agent surface with its own authority model. Wrong direction for a VICT pack.
- **cognee HTTP server as the first integration** — adds a deployment surface before the
  embedded route is proven; revisit for server topologies (Stage 11 territory).
- **TypeScript SDK (cognee-rs) as the engine** — separate implementation, 16/20 search
  types, no keyless mode in the tested `@cognee/cognee-ts@0.2.0` configuration,
  disjoint storage; re-evaluate when the Rust engine matures.

## 2. Proposed first-release boundary

> **C2 revision (2026-09-25, docs/c2-feasibility-report.md §6): scored lexical
> search is REMOVED** — the scored retriever cannot combine scores with safe
> dataset/NodeSet scoping through a supported API. Dataset-level `forget` is
> upgraded: file-level physical purge observed and verified after restart.
> The list below is the C1 proposal, superseded by the C2 report's §6 table.

**In (candidate capabilities — names are placeholders, not API design):**

1. `memory.add` (write) — text/file into a named dataset, optional node_set tags; idempotent.
2. `memory.cognify` (write) — build/extend the graph for a dataset; run-to-completion or background+status.
3. `memory.searchChunks` (read) — semantic passage retrieval, dataset+nodeset scoped.
4. `memory.searchLexical` (read) — BM25 retrieval with pack-side score filtering. Note:
   in cognee 1.6.1 `with_scores` is **not reachable through the public search API** (the
   CHUNKS_LEXICAL registry passes only `top_k`); the pack must use the direct
   `BM25ChunksRetriever(with_scores=True)` construction — tested in battery 07.
5. `memory.searchSummaries` (read) — summary retrieval.
6. `memory.graphContext` (read) — graph-evidence context (no answer synthesis).
7. `memory.datasetsStatus` (read) — list datasets/data/status for operator surfaces.
8. `memory.forgetDataset` (write) — governed deletion path; **name-resolution and
   search cleanliness observed; physical purge depth is an open finding** and must be
   disclosed in pack documentation, not claimed as verified.

**Out (first release):** completion searches (until an LLM port exists), `update()`,
**item-level `forget`** (open residue finding; no repair demonstrated),
`remember`/`improve`/sessions/feedback, ontologies/custom graph models, visualization/
export/validate (pack-tooling candidates, not capabilities), tenants/roles/ACL routers,
agents API, cloud/sync/push, MCP/HTTP/CLI surfaces, prune, `forget(everything)`,
tools/external-connections broker.

**Configuration surface (declared, no secret values):** storage roots, embedding
provider/model/dims, extractor (`gliner_demo` pinned), vector/graph providers,
`AUTO_FEEDBACK=false`, telemetry opt-in.

**Required pack furniture (ECO-002):** declared effects/permissions per capability;
doubles for every read capability (canned chunk/summary/context results) and for
`add`/`cognify`/`forget` (status-shaped results); conformance fixtures from the proof
corpus; documentation of the setup pitfalls (§3 of the proof report); provenance
(Apache-2.0 cognee dependency, model licenses noted).

## 3. Consumer-fit summary (from read-only inspections)

**These inspections are observations of how the products integrate `@victframework`
today. Neither product has adopted, committed to, or been asked about the proposed
pack; the fit notes below are the discovery agent's assessment, not adoption
statements.**

- **Quellight** (as inspected): reads fit naturally — graph context as deterministic
  per-turn data at the model seam, consistent with its Q4 boundary; user-attributed
  writes would need scoping per user-dataset. Its governed-ceremony philosophy implies
  cognee writes should be proposal-bound, never agent-attributed — an adoption would
  have to respect that; Quellight has made no such decision.
- **Trading OS** (as inspected): rules/journal ingestion and evidence retrieval
  (chunks/lexical/context) fit its capability catalog; its evidence-governance model
  would require the correction additivity behavior (proof §6) to be disclosed — again
  an assessment, not a commitment.

The Stage-10 ecosystem gate (≥2 genuine consumers) is **not** satisfied by inspection
alone; both products would need to actually adopt the pack. Stage 8 remains a separate
track and no consumer commitments are claimed here.

## 4. Unresolved questions (for owner/review disposition)

1. **Bridge mechanics**: Node↔Python sidecar (child process vs local HTTP) — needs a
   small proof of its own before pack design; includes startup/teardown lifecycle and
   failure propagation.
2. **LLM port for completion searches**: reuse the mastra adapter pattern, host-provided
   OpenAI-compatible endpoint, or stay retrieval-only for v1? (Proof shows typed failures
   without a key, so v1-retrieval-only is viable.)
3. **Deletion guarantees**: first release exposes dataset-level forget only (item-level
   is out); the remaining question is whether physical purge depth (graph/vector storage
   after dataset forget) must be verified and documented before release, and what
   remediation exists if residue is found (none demonstrated — `validate()` untested).
4. **Windows stability**: the intermittent segfault at gliner load (memory-correlated) —
   needs either a minimum-RAM contract, subprocess isolation, or an extraction fallback
   decision before any embedded deployment.
5. **Actor mapping**: map VICT actors to cognee users per dataset (proven) vs a single
   service principal with VICT-side authorization only — the latter is simpler but gives
   up cognee's own isolation layer as defense-in-depth.
6. **Upgrade cadence**: exact-pin policy vs tolerated range for cognee patch releases.
7. **Where cognify runs**: synchronous capability with long duration vs background job +
   status capability (VICT wait/timer semantics are Stage-9 territory; first release
   needs a stance).
8. **Scope of `victCompatibility`**: which release set(s) the first pack certifies
   against (consumers currently span 0.1.1 and 0.3.1).

## 5. What this task did NOT do

- No pack API design, no capability ID naming, no manifest authoring.
- No implementation of any pack or bridge code.
- No writes to VICT, Quellight, or Trading OS repositories (verified clean throughout).
- No Stage 9 work; no release publication; no remote other than the supplied
  VICT-Cognee discovery repository.
