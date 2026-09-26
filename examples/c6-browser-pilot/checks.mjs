/**
 * C6 focused checks — experience + security boundaries ONLY.
 * Deliberately NOT the C0–C5 model batteries (those are closed): these
 * checks exercise the consumer surface (HTTP act boundary) of this pilot.
 *
 * C1  owner flow end-to-end: add -> cognify -> scoped search returns the
 *     note as a CANDIDATE with a score (pack output passed through raw).
 * C2  candidate honesty: app/pack apply no threshold; hits pass through
 *     verbatim; summaries search works (all six capabilities exercised).
 * C3  restart persistence: stop the server (lock released), start again,
 *     the note is still there and searchable.
 * C4  cross-domain isolation: domain B never names or returns domain A's
 *     dataset names or content (status filter + scoped search).
 * C5  deletion denied by default; armed delete works ONLY with the explicit
 *     irreversible run policy + typed confirmation, on disposable data.
 * C6  boundary: unscoped search and foreign-namespace datasets refused at
 *     the app boundary (namespaces are a store rail, not user auth).
 */

import { spawn } from 'node:child_process';
import { writeFileSync, createWriteStream } from 'node:fs';
import { freemem } from 'node:os';

const PORT = Number(process.env.PILOT_PORT ?? 4699);
const BASE = `http://localhost:${PORT}`;
const out = [];
const check = (id, name, cond, detail) => {
  out.push({ id, name, outcome: cond ? 'PASS' : 'FAIL', detail });
  console.error(`[check] ${id} ${cond ? 'PASS' : 'FAIL'} ${name}`);
  if (!cond && detail !== undefined) console.error(`[check]   detail: ${JSON.stringify(detail)?.slice(0, 400)}`);
  return cond;
};

const act = async (domain, action, input) => {
  const res = await fetch(`http://localhost:${PORT}/api/act`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ domain, action, input }),
  });
  return res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeRamGb = () => freemem() / 2 ** 30;

let bootIndex = 0;
function startServer(armed) {
  bootIndex += 1;
  const logPath = `pilot-server-boot${bootIndex}.log`;
  const logStream = createWriteStream(logPath);
  const child = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env, PILOT_PORT: String(PORT),
      PILOT_ALLOW_IRREVERSIBLE: armed ? '1' : '0',
      PILOT_PYTHON: process.env.PILOT_PYTHON,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (c) => { logStream.write(c); });
  child.logPath = logPath;
  return child;
}

async function stopServer(child) {
  // Graceful: the server's /api/shutdown closes the listener first, then
  // releases both locks via the pack's C5-precise release. Wait for the
  // PROCESS to exit (not just the port) — booting a replacement while the
  // old owner is mid-release would hit the store lock (fail-closed).
  try { await fetch(`http://localhost:${PORT}/api/shutdown`, { method: 'POST' }); } catch { /* already down */ }
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', resolve);
    setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 40000);
  });
  await sleep(1500);
}

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://localhost:${PORT}/api/health`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error('server did not become healthy in 120s');
}

const ramStart = freeRamGb();
let server = startServer(false);
try {
  const health = await waitHealthy();

  /* ---- C1: owner flow end-to-end on domain A (disposable) ---- */
  const NOTE = 'C6 pilot marker: settlement windows close at 17:00 local time; ' +
    'ledger reconciliation runs nightly under dual approval.';
  const add = await act('a', 'addNote', { datasetName: 'notes.team', content: NOTE });
  check('C1a', 'add through VICT graph returns contract-conform receipt',
    add.status === 'completed' && add.output?.datasetName === 'notes.team' &&
      add.output?.idempotencyKey && add.output?.reconciled === 'fresh-execution',
    { status: add.status, output: add.output, error: add.error });

  const cog = await act('a', 'cognify', { datasetName: 'notes.team' });
  check('C1b', 'cognify through VICT graph completes (durable keyed run)',
    cog.status === 'completed' && cog.output?.datasetName === 'notes.team',
    { status: cog.status, ms: cog.durationMs, error: cog.error });

  const search = await act('a', 'searchChunks',
    { datasets: ['notes.team'], query: 'settlement windows' });
  const hit = search.output?.hits?.[0];
  check('C1c', 'scoped search returns the note as a CANDIDATE with raw score',
    search.status === 'completed' && (search.output?.total ?? 0) > 0 &&
      hit?.datasetName === 'notes.team' && hit.text.includes('C6 pilot marker') &&
      (hit.score === undefined || typeof hit.score === 'number'),
    { status: search.status, total: search.output?.total, first: hit });

  /* ---- C2: candidates pass through verbatim; summaries search works ---- */
  const raw = await act('a', 'searchChunks', { datasets: ['notes.team'], query: 'ledger reconciliation' });
  check('C2a', 'hits pass through verbatim (no threshold, no answer composition at the boundary)',
    raw.status === 'completed' && Array.isArray(raw.output?.hits) &&
      raw.output.hits.every((h) => typeof h.text === 'string' &&
        (h.score === undefined || typeof h.score === 'number')),
    { total: raw.output?.total, first: raw.output?.hits?.[0] });
  const summaries = await act('a', 'searchSummaries', { datasets: ['notes.team'], query: 'settlement' });
  check('C2b', 'cognee.searchSummaries works through the runtime (all six capabilities exercised)',
    summaries.status === 'completed' && Array.isArray(summaries.output?.hits),
    { status: summaries.status, total: summaries.output?.total });

  /* ---- C3: restart persistence (fresh store lock cycle) ---- */
  await stopServer(server);
  server = startServer(false);
  await waitHealthy();
  const persisted = await act('a', 'searchChunks', { datasets: ['notes.team'], query: 'settlement windows' });
  check('C3', 'restart the app: the note survives (durable store; lock re-acquired cleanly)',
    persisted.status === 'completed' && (persisted.output?.total ?? 0) > 0 &&
      persisted.output.hits[0]?.text.includes('C6 pilot marker'),
    { status: persisted.status, total: persisted.output?.total });

  /* ---- C4: cross-domain isolation (second trust domain) ---- */
  await act('b', 'addNote', { datasetName: 'vault.personal', content: 'vault marker: personal runway projection 14 months.' });
  await act('b', 'cognify', { datasetName: 'vault.personal' });
  const bStatus = await act('b', 'status', {});
  const bNames = (bStatus.output?.datasets ?? []).map((d) => d.name);
  const aNames = ['notes.team'];
  check('C4a', 'domain B status never names domain A datasets (namespace-filtered status)',
    !bNames.some((n) => aNames.some((a) => n.startsWith('notes.'))) &&
      (bStatus.output?.hiddenDatasets ?? -1) >= 0,
    { datasets: bNames, hidden: bStatus.output?.hiddenDatasets });
  const crossSearch = await act('b', 'searchChunks', { datasets: ['vault.personal'], query: 'settlement windows ledger reconciliation' });
  const leaked = (crossSearch.output?.hits ?? []).some((h) => h.text.includes('C6 pilot marker'));
  check('C4b', 'domain B search cannot surface domain A content (separate store/worker/runtime)',
    crossSearch.status === 'completed' && !leaked,
    { status: crossSearch.status, total: crossSearch.output?.total });
  const foreignScope = await act('b', 'searchChunks', { datasets: ['notes.team'], query: 'anything' });
  check('C4c', 'foreign-namespace scope refused at the boundary (namespaces are the store rail)',
    foreignScope.status === 'refused' && foreignScope.error?.code === 'SCOPE_REFUSED',
    { error: foreignScope.error });

  /* ---- C5: deletion denied by default; armed on disposable data ---- */
  const denied = await act('b', 'forgetDefault', { datasetName: 'vault.personal' });
  const denialVisible = denied.status !== 'completed' && (
    denied.status === 'refused' || denied.status === 'blocked' ||
    String(denied.error?.message ?? '').length > 0);
  check('C5a', 'delete with DEFAULT policy is denied by VICT (irreversible, no allowIrreversible)',
    denialVisible, { result: denied });
  const stillThere = await act('b', 'searchChunks', { datasets: ['vault.personal'], query: 'vault marker' });
  check('C5b', 'denied delete left the dataset intact',
    stillThere.status === 'completed' && (stillThere.output?.total ?? 0) > 0,
    { status: stillThere.status, total: stillThere.output?.total, error: stillThere.error });

  /* ---- C6: boundary refusals (thin-app guard rails) ---- */
  const unscoped = await act('a', 'searchChunks', { datasets: [], query: 'x' });
  check('C6a', 'unscoped search refused (mandatory dataset scope at the boundary)',
    unscoped.status === 'refused' && unscoped.error?.code === 'SCOPE_REFUSED', { error: unscoped.error });
  const wrongNs = await act('a', 'addNote', { datasetName: 'vault.smuggle', content: 'attempted cross-domain write' });
  check('C6b', 'foreign-namespace write refused at the boundary (and would be refused by the worker rail too)',
    wrongNs.status === 'refused' && wrongNs.error?.code === 'SCOPE_REFUSED', { error: wrongNs.error });

  /* ---- C5c: ARMED delete (second server boot, armed) on disposable data ---- */
  await stopServer(server);
  server = startServer(true);
  const health2 = await waitHealthy();
  check('C5c-pre', 'server rebooted with DELETE ARMED (server-side switch)', health2.armedDelete === true);
  const armed = await act('b', 'forgetArmed', { datasetName: 'vault.personal', confirm: 'vault.personal' });
  check('C5c', 'armed irreversible delete runs ONLY with explicit policy and typed confirmation',
    armed.status === 'completed' && armed.output?.datasetName === 'vault.personal' &&
      typeof armed.output?.purged === 'string',
    { status: armed.status, receipt: armed.output });
  const afterForget = await act('b', 'searchChunks', { datasets: ['vault.personal'], query: 'vault marker' });
  // The pack's documented behavior (eval.cognee.forget.purges): post-forget
  // searches return ZERO candidates or FAIL TYPED — either proves the purge.
  check('C5d', 'post-forget search returns no candidates (typed failure or empty)',
    (afterForget.status === 'completed' && (afterForget.output?.total ?? 0) === 0) ||
      (afterForget.status === 'failed' && !!afterForget.error),
    { status: afterForget.status, total: afterForget.output?.total, error: afterForget.error });
  const bStatus2 = await act('b', 'status', {});
  check('C5e', 'datasetsStatus after forget no longer lists the purged dataset',
    !(bStatus2.output?.datasets ?? []).some((d) => d.name === 'vault.personal'),
    { datasets: bStatus2.output?.datasets });

  /* ---- resources ---- */
  const rss = armed.workerRssBytes ?? null;
  writeFileSync('checks-summary.json', JSON.stringify({
    started: new Date().toISOString(),
    freeRamGbStart: Number(ramStart.toFixed(2)),
    freeRamGbEnd: Number(freeRamGb().toFixed(2)),
    workerRssBytes: rss,
    results: out,
  }, null, 2));
  const pass = out.filter((r) => r.outcome === 'PASS').length;
  console.error(`[checks] COMPLETE — ${pass}/${out.length} PASS`);
  // Graceful stop BEFORE exiting (a hard kill would strand store locks — the
  // pack then refuses the next boot, by C5 fail-closed design).
  await stopServer(server);
  process.exit(pass === out.length ? 0 : 1);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    try { await stopServer(server); } catch { /* best effort */ }
  }
}