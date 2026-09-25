# Integration route recommendation and proposed first-release boundary

Status: discovery deliverable (C0/C1). A recommendation for owner review — **not** a pack
design, **not** an implementation. Companion to `docs/capability-map.md` and
`docs/proof-report.md`.

## 1. Recommended integration route

**Python-engine, in-process adapter package, consuming cognee as a pinned dependency.**

| Decision | Recommendation | Basis (all observed unless noted) |
| --- | --- | --- |
| Engine | Python `cognee==1.6.x` (pinned exact) embedded in the VICT host process | Only route with a working keyless-local mode; full surface (§ proof report); TS engine (`@cognee/cognee-ts`) is a separate Rust implementation with parity gaps and no keyless mode |
| Wiring | A capability pack whose capabilities call the Python surface from Node via a small **sidecar bridge** (child process or local HTTP) OR as a **host-provided port** | VICT hosts are Node/TypeScript (`@victframework/*`); cognee is Python. Two viable bridges; both keep cognee out of the kernel/runtime import graph (ARCH-013) and behind effect-declared capabilities (CAP-002). Final bridge choice is a pack-design decision, not made here |
| Retrieval subset (first release) | `CHUNKS`, `CHUNKS_LEXICAL`, `SUMMARIES`, `GRAPH_COMPLETION` with `only_context=True` | Proven keyless, sub-second, evidence-shaped; completion types wait for an LLM-port story |
| Write subset (first release) | `add`, `cognify`, `forget` (item + dataset), `datasets.list_data/get_status` | All proven; `update` excluded (LLM-gated), `remember`/`improve` deferred |
| Isolation model | 1 cognee dataset per VICT consumer-scope (e.g. per user or per workspace) + NodeSets for sub-scoping; map VICT actor → cognee user for the multi-user path | Dataset isolation proven (0 identity overlap); node_set filtering proven; user isolation proven at three layers; avoids cognee tenants/roles (server surface) in first release |
| Deletion posture | Dataset-level `forget` as the governed path for first release; item-level `forget` exposed only with a post-delete verification step (re-search + `validate()`) | Item-level forget leaves a phantom vector hit (proof §7); dataset forget is clean |
| Deployment defaults | Embedded lancedb + ladybug + sqlite, storage roots redirected under VICT app-data, model caches pinned via `FASTEMBED_CACHE_PATH`/`HF_HOME`, `AUTO_FEEDBACK=false`, telemetry off unless the host opts in | Proof §3 findings; local-first alignment |
| Effect classes (proposal input) | `add`=write (idempotent by content hash), `cognify`=write (long-running), `search*`=read, `forget(dataset)`=write, `forget(item)`=write + verification obligation, `prune`/`forget(everything)`=irreversible (excluded from pack surface) | Maps observed behavior onto the VICT effect model; final classes are pack-design decisions |
| Version policy | Pin exact cognee version in the pack; declare `victCompatibility` against the release set the pack is verified with | Upstream moves fast (v1.6.1 is days old); ECO-002 compatibility obligation |

Rejected routes (with reasons):

- **cognee MCP server as the integration** — bypasses VICT capability governance; a
  second agent surface with its own authority model. Wrong direction for a VICT pack.
- **cognee HTTP server as the first integration** — adds a deployment surface before the
  embedded route is proven; revisit for server topologies (Stage 11 territory).
- **TypeScript SDK (cognee-rs) as the engine** — separate implementation, 16/20 search
  types, no keyless mode, disjoint storage; re-evaluate when the Rust engine matures.

## 2. Proposed first-release boundary

**In (candidate capabilities — names are placeholders, not API design):**

1. `memory.add` (write) — text/file into a named dataset, optional node_set tags; idempotent.
2. `memory.cognify` (write) — build/extend the graph for a dataset; run-to-completion or background+status.
3. `memory.searchChunks` (read) — semantic passage retrieval, dataset+nodeset scoped.
4. `memory.searchLexical` (read) — BM25 retrieval with score filtering at the pack boundary.
5. `memory.searchSummaries` (read) — summary retrieval.
6. `memory.graphContext` (read) — graph-evidence context (no answer synthesis).
7. `memory.datasetsStatus` (read) — list datasets/data/status for operator surfaces.
8. `memory.forgetDataset` (write) — clean, proven deletion path.

**Out (first release):** completion searches (until an LLM port exists), `update()`,
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

- **Quellight** would consume reads (graph context as deterministic per-turn data at the
  model seam, consistent with its Q4 boundary) and user-attributed writes scoped per
  user-dataset; the governed-ceremony philosophy means cognee writes should be
  proposal-bound, never agent-attributed.
- **Trading OS** would consume rules/journal ingestion and evidence retrieval
  (chunks/lexical/context); its evidence-governance model needs the correction
  additivity behavior (proof §6) to be disclosed, not hidden.

Two genuine consumers satisfy the Stage-10 ecosystem gate's consumer-count criterion;
neither product defines the pack.

## 4. Unresolved questions (for owner/review disposition)

1. **Bridge mechanics**: Node↔Python sidecar (child process vs local HTTP) — needs a
   small proof of its own before pack design; includes startup/teardown lifecycle and
   failure propagation.
2. **LLM port for completion searches**: reuse the mastra adapter pattern, host-provided
   OpenAI-compatible endpoint, or stay retrieval-only for v1? (Proof shows typed failures
   without a key, so v1-retrieval-only is viable.)
3. **Deletion guarantees**: is the item-level vector residue acceptable with verification,
   or must first release expose dataset-level forget only? (Quellight's Stage-07D-grade
   deletion expectations suggest the stricter posture.)
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
