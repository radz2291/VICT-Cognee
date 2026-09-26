/**
 * C4-exit cognify retry semantics — GRAPH equivalence proof (contract §7.3).
 *
 * Question: after a forced post-write/pre-commit crash (worker os._exit(2)
 * AFTER cognee's cognify write lands, BEFORE the journal commit) and a keyed
 * reissue, is the resulting graph EQUIVALENT to an uninterrupted cognify of
 * the identical input in an isolated store — at the level of graph nodes,
 * edges, identities, and properties?
 *
 * Design (one store per trust domain, isolated, fresh):
 *   store A (baseline):  add(content) -> cognify(key A)                [uninterrupted]
 *   store B (crash):     add(content) -> cognify with PROOF-ONLY fault
 *                        (worker/worker_proof.py, C4_PROOF_FAULT) ->
 *                        COGNEE_WRITE_UNKNOWN -> keyed reissue cognify(key B)
 * Both stores then get their FULL graph dumped (worker/graph_dump_c4.py,
 * ladybug engine via cognee's graph adapter) and compared as MULTISETS
 * (correction pass 2 — duplicate identities count, never overwrite):
 *   - RAW counts: total node/edge counts must match, not just identities;
 *   - node identities: (type, name) with per-identity MULTIPLICITY, plus the
 *     multiset of property variants (volatile per-store fields excluded:
 *     random ids, timestamps, pipeline-run provenance — each exclusion
 *     individually justified in graph_dump_c4.py);
 *   - edge identities: (source identity, target identity, relationship) with
 *     multiplicities and property-variant multisets;
 *   - item counts from the receipts;
 *   - NEGATIVE CONTROLS: the comparator is proven to FAIL when an extra
 *     duplicate node/edge instance (same identity) or an extra edge is
 *     injected (g7).
 *
 * Searchability alone is NOT accepted as equivalence — this proof is the
 * graph-diff granularity the contract previously lacked.
 *
 * Results: worker/c4-graph-equiv-results.json.
 */

import { WorkerClient, WorkerError } from './client.mjs';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const PY = path.join(repo, 'proof', '.venv', 'Scripts', 'python.exe');
const WORKER = path.join(repo, 'pack', 'src', 'worker', 'cognee_worker.py');
const PROOF_WORKER = path.join(repo, 'worker', 'worker_proof.py');

// ---- C5 (audit M1): controlled failing assertion ----------------------------
// C5_FORCED_FAIL=1 makes this driver record one deliberately failing assertion
// and exit 1 WITHOUT running the suite — proving the exit-status coupling (a
// FAIL/observation can never exit 0).
if (process.env.C5_FORCED_FAIL === '1') {
  console.error('[equiv] forced-fail: controlled failing assertion (C5_FORCED_FAIL=1)');
  writeFileSync(path.join(here, 'c4-graph-equiv-results.json'), JSON.stringify({
    proof: 'c4-exit-cognify-graph-equivalence', forcedFail: true,
    started: new Date().toISOString(), duration_s: 0,
    results: [{ id: 'forced-fail', name: 'controlled failing assertion', outcome: 'FAIL', detail: { forced: true } }],
  }, null, 2));
  process.exit(1);
}

const DOC = 'C4EQUIV marker: settlement windows close at 17:00 local time; ' +
  'ledger reconciliation runs nightly under dual approval; exceptions escalate ' +
  'to the on-call settlement controller before the next business day; the ' +
  'reconciliation report is countersigned by the operations lead.';

async function freshStore(name) {
  const store = path.join(repo, 'proof', name);
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(store, { recursive: true, force: true });
      break;
    } catch {
      if (attempt >= 4) throw new Error(`cannot clear ${store}`);
      await new Promise((r) => setTimeout(r, 2_000)); // transient EBUSY (Windows)
    }
  }
  mkdirSync(path.join(store, 'system'), { recursive: true });
  writeFileSync(path.join(store, '.env'), [
    `# Fresh disposable C4 graph-equivalence store (${name})`,
    'ENV=dev', 'RUNTIME__LOG_LEVEL=INFO',
    ...['system', 'data', 'cache', 'logs', 'repos'].map((r) => {
      const key = { system: 'SYSTEM_ROOT_DIRECTORY', data: 'DATA_ROOT_DIRECTORY',
        cache: 'CACHE_ROOT_DIRECTORY', logs: 'LOGS_ROOT_DIRECTORY',
        repos: 'COGNEE_REPOS_DIR' }[r];
      return `${key}=${path.join(store, r).replace(/\\/g, '/')}`;
    }),
    'VECTOR_DB_PROVIDER=lancedb', 'GRAPH_DATABASE_PROVIDER=ladybug',
    'DB_PROVIDER=sqlite', 'EMBEDDING_PROVIDER=fastembed',
    'EMBEDDING_MODEL=BAAI/bge-small-en-v1.5', 'EMBEDDING_DIMENSIONS=384',
    'GRAPH_EXTRACTOR=gliner_demo', 'AUTO_FEEDBACK=false', '',
  ].join('\n'));
  return store;
}

const t0 = Date.now();
const results = [];
function record(id, name, outcome, detail, ms) {
  results.push({ id, name, outcome, detail, ms });
  console.error(`[equiv] ${id} ${outcome} ${name} ${ms ? `(${ms}ms)` : ''}`);
}

const storeA = await freshStore('.cognee-equiv-a');
const storeB = await freshStore('.cognee-equiv-b');

const clients = [];
function clientFor(store, worker = WORKER, env = {}) {
  const c = new WorkerClient(PY, worker,
    { cwd: store, namespaces: ['qa'], readyBudgetMs: 180_000, storeRoot: store,
      env, diag: (m) => console.error(m) });
  clients.push(c);
  return c;
}

function journalOf(store, key) {
  try {
    return readFileSync(path.join(store, 'system', 'cognee_idempotency_journal.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
      .filter((r) => r.key === key).map((r) => r.state);
  } catch {
    return [];
  }
}

async function run() {
  // ---- store A: uninterrupted baseline --------------------------------------
  const a = clientFor(storeA);
  await a.ensureReady();
  const addA = await a.request('add', { datasetName: 'qa.equiv', content: DOC },
    { mutating: true, deadlineMs: 120_000, ctx: { idempotencyKey: 'A-add' } });
  const cogA = await a.request('cognify', { datasetName: 'qa.equiv' },
    { mutating: true, deadlineMs: 300_000, ctx: { idempotencyKey: 'A-cog' } });
  record('g1', 'baseline store A: add + cognify (uninterrupted)', 'PASS',
    { addItems: addA.itemsAfter, cogItems: cogA.itemsAfter,
      reconciled: cogA.reconciled });
  await a.shutdown();

  // ---- store B: forced crash after cognify write, before journal commit -----
  const b = clientFor(storeB);
  await b.ensureReady();
  await b.request('add', { datasetName: 'qa.equiv', content: DOC },
    { mutating: true, deadlineMs: 120_000, ctx: { idempotencyKey: 'B-add' } });
  // park the plain worker; arm the PROOF-ONLY crash harness worker
  await b.shutdown();
  let crashed = false;
  {
    const cc = clientFor(storeB, PROOF_WORKER, { C4_PROOF_FAULT: 'cognify.after-write-before-commit' });
    try {
      await cc.ensureReady();
      await cc.request('cognify', { datasetName: 'qa.equiv' },
        { mutating: true, deadlineMs: 300_000, ctx: { idempotencyKey: 'B-cog' } });
      record('g2', 'crash hook did not fire', 'FAIL-UNEXPECTED', {});
    } catch (e) {
      if (e instanceof WorkerError && e.code === 'COGNEE_WRITE_UNKNOWN' &&
          e.detail?.workerExit?.code === 2) {
        crashed = true;
        record('g2', 'forced crash after cognify write -> COGNEE_WRITE_UNKNOWN', 'PASS',
          { workerExit: e.detail?.workerExit });
      } else {
        record('g2', 'unexpected failure during armed cognify', 'ERROR',
          { code: e.code, message: String(e.message).slice(0, 200) });
      }
    }
  }
  const journalAfterCrash = journalOf(storeB, 'B-cog');
  record('g3', 'journal shows begun-without-commit after the crash',
    crashed && journalAfterCrash.length === 1 && journalAfterCrash[0] === 'begun'
      ? 'PASS' : 'FAIL', { journalAfterCrash });
  // keyed reissue on the PLAIN (pack-bundled) worker
  const reissue = await b.request('cognify', { datasetName: 'qa.equiv' },
    { mutating: true, deadlineMs: 300_000, ctx: { idempotencyKey: 'B-cog' } });
  const search = await b.request('search_chunks',
    { datasets: ['qa.equiv'], query: 'settlement windows', topK: 5 });
  record('g4', 'keyed reissue completes (reissued-after-interruption) and is searchable',
    reissue.reconciled === 'reissued-after-interruption' && search.total > 0
      ? 'PASS' : 'FAIL',
    { reconciled: reissue.reconciled, itemsAfter: reissue.itemsAfter,
      searchTotal: search.total });
  await b.shutdown();

  // ---- dump both graphs -------------------------------------------------------
  const dumpA = path.join(here, 'c4-equiv-graph-a.json');
  const dumpB = path.join(here, 'c4-equiv-graph-b.json');
  const pa = spawnSync(PY, [path.join(here, 'graph_dump_c4.py'), '--dump', dumpA],
    { cwd: storeA, encoding: 'utf8', timeout: 300_000 });
  const pb = spawnSync(PY, [path.join(here, 'graph_dump_c4.py'), '--dump', dumpB],
    { cwd: storeB, encoding: 'utf8', timeout: 300_000 });
  if (pa.status !== 0 || pb.status !== 0) {
    record('g5', 'graph dumps', 'ERROR',
      { a: pa.status, aErr: String(pa.stderr).slice(-400),
        b: pb.status, bErr: String(pb.stderr).slice(-400) });
    return;
  }
  const ga = JSON.parse(readFileSync(dumpA, 'utf8'));
  const gb = JSON.parse(readFileSync(dumpB, 'utf8'));
  record('g5', 'full graph dumps (ladybug, nodes + edges + properties)', 'PASS',
    { a: { nodes: ga.nodeCount, edges: ga.edgeCount,
      nodeIdentities: ga.nodeIdentityCount, edgeIdentities: ga.edgeIdentityCount,
      duplicateNodeInstances: ga.duplicateNodeInstances,
      duplicateEdgeInstances: ga.duplicateEdgeInstances },
      b: { nodes: gb.nodeCount, edges: gb.edgeCount,
        nodeIdentities: gb.nodeIdentityCount, edgeIdentities: gb.edgeIdentityCount,
        duplicateNodeInstances: gb.duplicateNodeInstances,
        duplicateEdgeInstances: gb.duplicateEdgeInstances } });

  // ---- structural comparison (MULTISET semantics; correction pass 2) ----------
  // Per identity key, the property-variant LIST is compared as a multiset:
  // duplicate identities count (a duplicate in one store with no counterpart
  // in the other is a difference — the previous key→props comparison silently
  // overwrote duplicates and could not detect this). RAW counts are asserted
  // as well: raw node/edge totals AND per-identity multiplicities must match,
  // not just the set of identities.
  function multisetDiff(listA, listB) {
    const count = (arr) => {
      const m = new Map();
      for (const v of arr) { const k = JSON.stringify(v); m.set(k, (m.get(k) ?? 0) + 1); }
      return m;
    };
    const ma = count(listA), mb = count(listB);
    const missing = [], extra = [];
    for (const [k, n] of ma) {
      const d = n - (mb.get(k) ?? 0);
      for (let i = 0; i < d; i++) missing.push(JSON.parse(k));
    }
    for (const [k, n] of mb) {
      const d = n - (ma.get(k) ?? 0);
      for (let i = 0; i < d; i++) extra.push(JSON.parse(k));
    }
    return { missing, extra };
  }
  function compareGraphs(ga2, gb2) {
    const diff = { missingInB: [], extraInB: [], multiplicityDiffs: [], rawCountDiffs: [] };
    for (const [kind, rawA, rawB] of [['node', ga2.nodeCount, gb2.nodeCount],
      ['edge', ga2.edgeCount, gb2.edgeCount]]) {
      if (rawA !== rawB) diff.rawCountDiffs.push({ kind, inA: rawA, inB: rawB });
    }
    const compareTable = (kind, ta, tb) => {
      const idents = new Set([...Object.keys(ta), ...Object.keys(tb)]);
      for (const k of idents) {
        const la = ta[k] ?? [], lb = tb[k] ?? [];
        if (la.length !== lb.length) {
          diff.multiplicityDiffs.push({ kind, identity: k.slice(0, 160), inA: la.length, inB: lb.length });
        }
        const { missing, extra } = multisetDiff(la, lb);
        for (const v of missing) diff.missingInB.push({ kind, identity: k.slice(0, 160), variant: v });
        for (const v of extra) diff.extraInB.push({ kind, identity: k.slice(0, 160), variant: v });
      }
    };
    compareTable('node', ga2.nodes, gb2.nodes);
    compareTable('edge', ga2.edges, gb2.edges);
    diff.equivalent = diff.rawCountDiffs.length === 0 &&
      diff.multiplicityDiffs.length === 0 && diff.missingInB.length === 0 &&
      diff.extraInB.length === 0;
    return diff;
  }
  const diff = compareGraphs(ga, gb);
  record('g6', 'GRAPH EQUIVALENCE (raw counts + per-identity multiplicities + identities + property-variant multisets)',
    diff.equivalent ? 'PASS' : 'FAIL',
    { rawCountDiffs: diff.rawCountDiffs, multiplicityDiffs: diff.multiplicityDiffs.slice(0, 10),
      missingInB: diff.missingInB.slice(0, 10), extraInB: diff.extraInB.slice(0, 10),
      counts: { rawCountDiffs: diff.rawCountDiffs.length,
        multiplicityDiffs: diff.multiplicityDiffs.length,
        missingInB: diff.missingInB.length, extraInB: diff.extraInB.length } });

  // ---- NEGATIVE CONTROLS (correction pass 2): the comparator must FAIL when
  // an extra duplicate instance (same identity, the exact case the old
  // key→props comparison silently overwrote) or an extra edge is injected.
  const controls = [];
  {
    // (i) extra duplicate NODE instance under an EXISTING identity
    const nodeKey = Object.keys(ga.nodes)[0];
    const dup = JSON.parse(JSON.stringify(ga.nodes[nodeKey][0]));
    dup.__injected = 'negative-control-duplicate-node';
    const mutated = { ...ga, nodes: { ...ga.nodes, [nodeKey]: [...ga.nodes[nodeKey], dup] } };
    const d = compareGraphs(mutated, gb);
    controls.push({ control: 'extra-duplicate-node', detected: !d.equivalent });
  }
  {
    // (ii) extra duplicate EDGE instance under an EXISTING identity
    const edgeKey = Object.keys(ga.edges)[0];
    const dup = JSON.parse(JSON.stringify(ga.edges[edgeKey][0]));
    dup.__injected = 'negative-control-duplicate-edge';
    const mutated = { ...ga, edges: { ...ga.edges, [edgeKey]: [...ga.edges[edgeKey], dup] } };
    const d = compareGraphs(mutated, gb);
    controls.push({ control: 'extra-duplicate-edge', detected: !d.equivalent });
  }
  {
    // (iii) extra edge with a NEW identity (topology change)
    const edgeKey = Object.keys(ga.edges)[0];
    const novel = JSON.parse(JSON.stringify(ga.edges[edgeKey][0]));
    const mutated = { ...ga, edgeCount: ga.edgeCount + 1,
      edges: { ...ga.edges, [edgeKey + '::NOVEL']: [novel] } };
    const d = compareGraphs(mutated, gb);
    controls.push({ control: 'extra-new-identity-edge', detected: !d.equivalent });
  }
  record('g7', 'negative controls: comparator FAILS on injected duplicate/extra node or edge',
    controls.every((c) => c.detected) ? 'PASS' : 'FAIL', { controls });

  record('verdict', diff.equivalent
    ? 'cognify keyedRetry SUPPORTED by multiset graph equivalence (incl. raw counts + negative controls)'
    : 'graph equivalence NOT demonstrated -> cognify must be ambiguity: block',
    diff.equivalent && controls.every((c) => c.detected) ? 'PASS' : 'FAIL', {});
}

try {
  await run();
} catch (e) {
  record('FATAL', 'unhandled error', 'ERROR',
    { code: e.code, message: String(e.message).slice(0, 300) });
} finally {
  for (const c of clients) { try { await c.shutdown(); } catch { /* best effort */ } }
}

const out = {
  proof: 'c4-exit-cognify-graph-equivalence',
  stores: { baseline: 'proof/.cognee-equiv-a', crashReissue: 'proof/.cognee-equiv-b' },
  method: 'full ladybug graph dump (graph_dump_c4.py) + MULTISET diff: raw node/edge counts + per-identity multiplicities + property-variant multisets; volatile per-store fields excluded with per-property justification in graph_dump_c4.py; negative controls prove the comparator fails on injected duplicates',
  started: new Date(t0).toISOString(),
  duration_s: Math.round((Date.now() - t0) / 1000),
  results,
};
writeFileSync(path.join(here, 'c4-graph-equiv-results.json'), JSON.stringify(out, null, 2));
console.error(`[equiv] COMPLETE ${out.duration_s}s — ` +
  `${results.filter((r) => r.outcome === 'PASS').length}/${results.length} PASS`);
// C5 (audit M1): failed assertions AND unexpected-worker observations MUST
// produce a non-zero exit status — an observation is recorded, never green.
process.exit(results.some((r) => r.outcome !== 'PASS') ? 1 : 0);

// Crash guards: never orphan workers silently — record and shut down.
process.on('uncaughtException', async (e) => {
  console.error('[equiv] uncaughtException:', e);
  for (const c of clients) { try { c.child?.kill('SIGKILL'); } catch { /* */ } }
  process.exit(1);
});
process.on('unhandledRejection', async (e) => {
  console.error('[equiv] unhandledRejection:', e);
  for (const c of clients) { try { c.child?.kill('SIGKILL'); } catch { /* */ } }
  process.exit(1);
});