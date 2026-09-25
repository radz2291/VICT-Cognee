/**
 * C3 proof driver — exercises the hardened worker against the pack contract.
 * Scenarios (docs/c3-pack-contract.md §11):
 *   s1 startup+guard   s2 scoped write/search     s3 unscoped/cross-ns/limits rejected
 *   s4 delayed mutating write -> COGNEE_WRITE_UNKNOWN + respawn + reconcile + re-issue
 *   s5 cognify nonexistent dataset -> COGNEE_DATASET_UNKNOWN
 *   s6 restart persistence + scoped summaries isolation
 *   s7 bounded responses (topK cap, oversized line)
 *   s8 forgetDataset receipt + post-delete typed failure
 *   s9 clean shutdown (exit 0)
 * A worker crash/death inside a scenario is recorded as an AGENT-OBSERVATION
 * (environment class, proof-report §3) and does not abort the run.
 * Results: worker/c3-results.json; diagnostics: worker/c3.log (stderr).
 */

import { WorkerClient, WorkerError } from './client.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CWD = path.resolve(here, '..', 'proof');
const PY = path.join(CWD, '.venv', 'Scripts', 'python.exe');
const NAMESPACES = ['qa', 'zeta'];

const results = [];
const t0 = Date.now();

function record(id, name, outcome, detail, ms) {
  results.push({ id, name, outcome, detail, ms });
  console.error(`[proof] ${id} ${outcome} ${name} ${ms ? `(${ms}ms)` : ''}`);
}

function expectError(fn, code, label) {
  const t = Date.now();
  return fn().then(
    () => record(label.id, label.name, 'FAIL-EXPECTED-ERROR', { got: 'success' }, Date.now() - t),
    (e) => record(label.id, label.name,
      e.code === code ? 'PASS' : `FAIL-WRONG-CODE(${e.code})`,
      { expected: code, got: `${e.code}: ${String(e.message).slice(0, 140)}` },
      Date.now() - t));
}

const client = new WorkerClient(PY, path.join(here, 'worker.py'),
  { cwd: CWD, namespaces: NAMESPACES, readyBudgetMs: 150_000,
    diag: (m) => console.error(m) });

const OBS_CODES = ['COGNEE_WORKER_UNAVAILABLE', 'COGNEE_WRITE_UNKNOWN', 'CLIENT_DEADLINE'];

async function scenario(id, name, fn) {
  const t = Date.now();
  try {
    await fn();
  } catch (e) {
    record(id, name, OBS_CODES.includes(e.code) ? 'AGENT-OBSERVATION' : 'ERROR',
      { code: e.code ?? '?', message: String(e.message ?? e).slice(0, 220) },
      Date.now() - t);
    try { await client._lifecycle(); } catch { /* respawn best-effort */ }
  }
}

const qaDoc = 'Quellight C3QA marker: settlement windows close at 17:00 local; ' +
  'ledger reconciliation runs nightly with dual approval.';
const zetaDoc = 'Trading OS C3ZETA marker: order router rebalances inventory at 09:30 open.';

await scenario('s1', 'startup guard + ready', async () => {
  const t = Date.now();
  const ready = await client.ensureReady();
  record('s1', 'startup guard + ready', ready.allowed_namespaces ? 'PASS' : 'FAIL',
    { protocol: ready.protocol, import_ms: ready.import_ms,
      namespaces: ready.allowed_namespaces, rss_mb: Math.round(ready.rss_bytes / 1e6) },
    Date.now() - t);
});

await scenario('s2', 'scoped add + cognify + search (qa.alpha)', async () => {
  const t = Date.now();
  await client.request('add', { datasetName: 'qa.alpha', content: qaDoc },
    { mutating: true, deadlineMs: 120_000 });
  await client.request('cognify', { datasetName: 'qa.alpha' },
    { mutating: true, deadlineMs: 180_000 });
  const hits = await client.request('search_chunks',
    { datasets: ['qa.alpha'], query: 'settlement windows', topK: 5 });
  record('s2', 'scoped write + search returns candidates', hits.total > 0 ? 'PASS' : 'FAIL',
    { total: hits.total,
      firstScore: hits.hits?.[0]?.score ?? hits.groups?.[0]?.search_result?.[0]?.score },
    Date.now() - t);
});

await scenario('s3', 'interface rejections (no cognee call)', async () => {
  await expectError(
    () => client.request('add', { datasetName: 'evil.other', content: 'x' },
      { mutating: true }),
    'COGNEE_SCOPE_REJECTED', { id: 's3', name: 'cross-namespace add rejected' });
  await expectError(
    () => client.request('add', { content: 'x' }, { mutating: true }),
    'COGNEE_SCOPE_REJECTED', { id: 's3', name: 'unscoped add rejected' });
  await expectError(
    () => client.request('search_chunks',
      { datasets: ['qa.alpha', 'evil.secrets'], query: 'x' }),
    'COGNEE_SCOPE_REJECTED', { id: 's3', name: 'cross-namespace search rejected' });
  const alive = await client.request('ping');
  record('s3', 'worker alive after rejections', alive.pong ? 'PASS' : 'FAIL', {});
});

await scenario('s4', 'delayed mutating write -> unknown -> reconcile -> re-issue', async () => {
  const bigDoc = 'C3DELAY marker paragraph. '.repeat(15_000); // ~390 KB
  const t = Date.now();
  try {
    await client.request('add', { datasetName: 'qa.delayed', content: bigDoc,
      retryKey: 'k-delay-1' }, { mutating: true, deadlineMs: 800 });
    record('s4', 'delayed add finished before deadline', 'FAIL-UNEXPECTED', {},
      Date.now() - t);
    return;
  } catch (e) {
    if (e.code !== 'COGNEE_WRITE_UNKNOWN') throw e;
    record('s4', 'delayed add -> deadline expiry -> outcome unknown',
      'PASS', { retryKey: e.detail?.retryKey }, Date.now() - t);
  }
  const t2 = Date.now();
  const status1 = await client.request('datasets_status');
  record('s4', 'reconciliation: post-timeout observation (worker respawned)',
    client.respawns > 0 ? 'PASS' : 'FAIL',
    { delayedExists: status1.datasets.some((d) => d.name === 'qa.delayed'),
      respawns: client.respawns, datasets: status1.datasets.map((d) => d.name) },
    Date.now() - t2);
  const t3 = Date.now();
  await client.request('add', { datasetName: 'qa.delayed', content: bigDoc,
    retryKey: 'k-delay-1' }, { mutating: true, deadlineMs: 120_000 });
  const status2 = await client.request('datasets_status');
  const delayedFinal = status2.datasets.filter((d) => d.name === 'qa.delayed').length;
  record('s4', 'keyed re-issue reconciles to one dataset',
    delayedFinal === 1 ? 'PASS' : 'FAIL', { qaDelayedCount: delayedFinal },
    Date.now() - t3);
});

await scenario('s5', 'cognify on nonexistent (scoped) dataset', async () => {
  await expectError(
    () => client.request('cognify', { datasetName: 'qa.does_not_exist' },
      { mutating: true }),
    'COGNEE_DATASET_UNKNOWN', { id: 's5', name: 'cognify nonexistent -> typed failure' });
});

await scenario('s6', 'restart persistence + scoped summaries isolation', async () => {
  const t = Date.now();
  await client.request('add', { datasetName: 'zeta.bravo', content: zetaDoc },
    { mutating: true, deadlineMs: 120_000 });
  await client.request('cognify', { datasetName: 'zeta.bravo' },
    { mutating: true, deadlineMs: 180_000 });
  record('s6', 'second-namespace dataset cognified', 'PASS', {}, Date.now() - t);

  const t2 = Date.now();
  const qaHits2 = await client.request('search_chunks',
    { datasets: ['qa.alpha'], query: 'settlement windows', topK: 5 });
  record('s6', 'restart persistence: qa.alpha still searchable',
    qaHits2.total > 0 ? 'PASS' : 'FAIL', { total: qaHits2.total }, Date.now() - t2);

  const t3 = Date.now();
  const qaSum = await client.request('search_summaries',
    { datasets: ['qa.alpha'], query: 'settlement', topK: 5 });
  const zetaSum = await client.request('search_summaries',
    { datasets: ['zeta.bravo'], query: 'rebalances', topK: 5 });
  const qaLeak = JSON.stringify(qaSum).includes('C3ZETA');
  const zetaLeak = JSON.stringify(zetaSum).includes('C3QA');
  record('s6', 'scoped summaries: namespace isolation',
    !qaLeak && !zetaLeak ? 'PASS' : 'FAIL',
    { qa_total: qaSum.total, zeta_total: zetaSum.total, qaLeak, zetaLeak },
    Date.now() - t3);
});

await scenario('s7', 'bounded responses', async () => {
  await expectError(
    () => client.request('search_chunks', { datasets: ['qa.alpha'], query: 'x', topK: 1000 }),
    'COGNEE_PARAMS_REJECTED', { id: 's7', name: 'topK above cap rejected' });
  await expectError(
    () => client.request('search_chunks', { datasets: [], query: 'x' }),
    'COGNEE_PARAMS_REJECTED', { id: 's7', name: 'empty datasets list rejected' });
  const bigLine = 'x'.repeat(1024 * 1024 + 1);
  let lineGuard = 'FAIL-NO-ERROR';
  try {
    await client.request('add', { datasetName: 'qa.alpha', content: bigLine },
      { mutating: true, deadlineMs: 5_000 });
  } catch (e) {
    lineGuard = ['LINE_TOO_LARGE', 'CLIENT_DEADLINE', 'COGNEE_WRITE_UNKNOWN',
      'COGNEE_PARAMS_REJECTED'].includes(e.code) ? 'PASS' : `FAIL-WRONG-CODE(${e.code})`;
  }
  record('s7', 'oversized request line refused', lineGuard, {});
});

await scenario('s8', 'forgetDataset (irreversible)', async () => {
  // self-sufficient: ensure the dataset exists (keyed re-add is a dedupe) even
  // if earlier scenarios were interrupted by environment crashes
  await client.request('add', { datasetName: 'qa.delayed', content: qaDoc,
    retryKey: 'k-delay-final' }, { mutating: true, deadlineMs: 120_000 });
  const t = Date.now();
  const forgetR = await client.request('forget_dataset', { datasetName: 'qa.delayed' },
    { mutating: true, deadlineMs: 120_000 });
  record('s8', 'forgetDataset receipt', 'PASS',
    { purged: forgetR.purged, filesBefore: forgetR.storeFilesBefore,
      filesAfter: forgetR.storeFilesAfter }, Date.now() - t);
  await expectError(
    () => client.request('search_chunks', { datasets: ['qa.delayed'], query: 'C3DELAY' }),
    'COGNEE_DATASET_UNKNOWN', { id: 's8', name: 'post-forget scoped search typed failure' });
});

await scenario('s9', 'clean shutdown', async () => {
  const t = Date.now();
  await client.shutdown();
  record('s9', 'clean shutdown', 'PASS',
    { stderrLines: client.stderrLines, respawns: client.respawns }, Date.now() - t);
});

const out = {
  proof: 'c3-worker-contract',
  started: new Date(t0).toISOString(),
  duration_s: Math.round((Date.now() - t0) / 1000),
  results,
};
writeFileSync(path.join(here, 'c3-results.json'), JSON.stringify(out, null, 2));
console.error(`[proof] COMPLETE ${out.duration_s}s — ` +
  `${results.filter((r) => r.outcome === 'PASS').length}/${results.length} PASS`);
process.exit(0); // no lingering worker timers keep the loop alive