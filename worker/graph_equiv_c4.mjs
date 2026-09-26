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
 * ladybug engine via cognee's graph adapter) and compared:
 *   - node set: identity (type, name) + properties (volatile per-store fields
 *     excluded: random ids, timestamps, pipeline-run provenance);
 *   - edge set: (source identity, target identity, relationship) + properties;
 *   - item counts from the receipts.
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
    { a: { nodes: ga.nodeCount, edges: ga.edgeCount },
      b: { nodes: gb.nodeCount, edges: gb.edgeCount } });

  // ---- structural comparison --------------------------------------------------
  const diff = { missingInB: [], extraInB: [], propertyDiffs: [] };
  const keys = (obj) => new Set(Object.keys(obj));
  for (const k of keys(ga.nodes)) if (!gb.nodes[k]) diff.missingInB.push(['node', k]);
  for (const k of keys(gb.nodes)) if (!ga.nodes[k]) diff.extraInB.push(['node', k]);
  for (const k of keys(ga.edges)) if (!gb.edges[k]) diff.missingInB.push(['edge', k]);
  for (const k of keys(gb.edges)) if (!ga.edges[k]) diff.extraInB.push(['edge', k]);
  const propDiff = (kind, tableA, tableB) => {
    for (const k of Object.keys(tableA)) {
      if (!tableB[k]) continue;
      const pa2 = tableA[k], pb2 = tableB[k];
      const allKeys = new Set([...Object.keys(pa2), ...Object.keys(pb2)]);
      for (const pk of allKeys) {
        if (JSON.stringify(pa2[pk]) !== JSON.stringify(pb2[pk])) {
          diff.propertyDiffs.push({ kind, identity: k.slice(0, 120), property: pk,
            inA: pa2[pk], inB: pb2[pk] });
        }
      }
    }
  };
  propDiff('node', ga.nodes, gb.nodes);
  propDiff('edge', ga.edges, gb.edges);
  const equivalent = diff.missingInB.length === 0 && diff.extraInB.length === 0 &&
    diff.propertyDiffs.length === 0;
  record('g6', 'GRAPH EQUIVALENCE (nodes, edges, identities, properties)',
    equivalent ? 'PASS' : 'FAIL',
    { missingInB: diff.missingInB.slice(0, 10), extraInB: diff.extraInB.slice(0, 10),
      propertyDiffs: diff.propertyDiffs.slice(0, 10),
      counts: { missingInB: diff.missingInB.length, extraInB: diff.extraInB.length,
        propertyDiffs: diff.propertyDiffs.length } });
  record('verdict', equivalent
    ? 'cognify keyedRetry SUPPORTED by graph equivalence'
    : 'graph equivalence NOT demonstrated -> cognify must be ambiguity: block',
    equivalent ? 'PASS' : 'FAIL', {});
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
  method: 'full ladybug graph dump (graph_dump_c4.py) + node/edge/property set diff; volatile per-store fields (random ids, timestamps, pipeline-run provenance) excluded and listed in graph_dump_c4.py',
  started: new Date(t0).toISOString(),
  duration_s: Math.round((Date.now() - t0) / 1000),
  results,
};
writeFileSync(path.join(here, 'c4-graph-equiv-results.json'), JSON.stringify(out, null, 2));
console.error(`[equiv] COMPLETE ${out.duration_s}s — ` +
  `${results.filter((r) => r.outcome === 'PASS').length}/${results.length} PASS`);
process.exit(0);

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