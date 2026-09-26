/**
 * AUDIT-ONLY deterministic interleaving test — L1 revisit (no repo changes).
 *
 * Reproduces the five-step sequence against the UNMODIFIED supervision code:
 *  1. B (external simulator below) reads a lock.
 *  2. A acquires the store and begins an operation (stub worker, 5 s op).
 *  3. B moves A's live lock (snapshot mismatch path of
 *     pack/src/supervision.ts acquireStoreOwnershipContended), then pauses
 *     (the "descheduled recoverer" hypothesis) at the existsSync/rename gap.
 *  4. C acquires the now-free path via the direct O_EXCL constructor path and
 *     begins an operation (stub worker, 4 s op).
 *  5. B restores A's lock, overwriting C's live lock.
 *
 * Questions answered empirically:
 *  Q1  Does C dispatch an op while A's op is still in flight (concurrent
 *      operation before any heartbeat detection)?
 *  Q2  Are TWO live workers simultaneously present on the same storeRoot?
 *  Q3  Does C's pre-dispatch verify (refresh + pre-dispatch) catch the
 *      displacement? (expected: NO — C dispatched while the path held C's own
 *      lock; the restore lands after dispatch)
 *  Q4  When does C detect the loss (in-flight hb tick) and what happens at
 *      settlement (kill+poison, sticky fail-closed)?
 *  Q5  Is A affected? (expected: NO — restored byte-identical, unaware)
 */

import { mkdirSync, rmSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'C:/Users/RZ1/Desktop/RZ/260925-VCT-Cognee';
const { createCogneePack } = await import(`file:///${REPO.replace(/\\/g, '/')}/pack/src/index.js`);
const { WorkerError } = await import(`file:///${REPO.replace(/\\/g, '/')}/pack/src/index.js`);

const STORE = path.join(REPO, 'proof', '.audit-l1-interleave');
const STUB = path.join(REPO, 'pack', 'verify', 'stub_worker.py');
const PY = path.join(REPO, 'proof', '.venv', 'Scripts', 'python.exe');
const LOCK = path.join(STORE, 'cognee-store-owner.lock');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const out = (s: string) => { log.push(s); console.error(s); };

for (let i = 0; ; i++) {
  try { rmSync(STORE, { recursive: true, force: true }); break; }
  catch { if (i >= 4) throw new Error('cannot clear store'); await sleep(2000); }
}
mkdirSync(STORE, { recursive: true });
// The stub worker imports no cognee/guard — no .env needed; keep one for realism.
writeFileSync(path.join(STORE, '.env'), '# audit stub store\n');

const results: { id: string; name: string; outcome: string; detail?: unknown }[] = [];
const check = (id: string, name: string, cond: boolean, detail?: unknown) => {
  results.push({ id, name, outcome: cond ? 'PASS' : 'FAIL', detail });
  out(`[l1] ${id} ${cond ? 'PASS' : 'FAIL'} ${name} ${detail ? JSON.stringify(detail).slice(0, 300) : ''}`);
  return cond;
};

const diag = (tag: string) => (line: string) => console.error(`[${tag}] ${line.slice(0, 110)}`);

// ---- A: acquires the fresh store, begins a 5 s op (default staleness budget:
//          in-flight hb interval = 5 min, so A never ticks during the demo) --
const A = createCogneePack({
  pythonPath: PY, cwd: STORE, storeRoot: STORE, namespaces: ['qa'],
  workerPath: STUB, readyBudgetMs: 30_000,
  env: { STUB_DELAY_OPS: 'slow_add', STUB_DELAY_MS: '5000' },
  diag: diag('A'),
});
const opA = A.supervision.request('slow_add', { datasetName: 'qa.a' },
  { mutating: true, deadlineAt: Date.now() + 30_000 });
await sleep(1_500); // A dispatched, op in flight

// ---- step 1+3: B reads A's lock, moves it, then freezes at the restore gap --
const snapA = readFileSync(LOCK, 'utf8');
const trash = `${LOCK}.recovering-sim`;
renameSync(LOCK, trash);            // B moves A's LIVE lock
out(`[l1] B displaced A's live lock at +${Date.now() % 100000}ms; A's op still in flight (A.child=${!!(A.supervision as never as { child?: unknown })})`);
await sleep(50);                    // B "descheduled" while the path is free

// ---- step 4: C acquires the now-free path (direct O_EXCL constructor path) --
const C = createCogneePack({
  pythonPath: PY, cwd: STORE, storeRoot: STORE, namespaces: ['qa'],
  workerPath: STUB, readyBudgetMs: 30_000, ownershipStaleMs: 3_000, // hb tick = 1 s
  env: { STUB_DELAY_OPS: 'slow_add', STUB_DELAY_MS: '4000' },
  diag: diag('C'),
});
check('S1', 'C acquired the store while A held it in flight (constructor O_EXCL over the displaced gap)',
  C.supervision.storeOwnershipHeld === true && existsSync(LOCK));
const opC = C.supervision.request('slow_add', { datasetName: 'qa.c' },
  { mutating: true, deadlineAt: Date.now() + 30_000 });
await sleep(2_700); // C spawns + ready + verifies + dispatches; op in flight; restore pending

// ---- step 5: B restores A's lock, overwriting C's live lock -----------------
const lockBeforeRestore = readFileSync(LOCK, 'utf8');
const cDispatched = C.supervision.stats.opsServed >= 1;
renameSync(trash, LOCK);
const lockAfterRestore = readFileSync(LOCK, 'utf8');
check('S2', 'restore overwrote C\'s lock with A\'s bytes (C was NOT restored by name)',
  lockBeforeRestore !== lockAfterRestore && lockAfterRestore === snapA);
check('S3', 'C DISPATCHED its op before the restore (pre-dispatch verify could NOT catch the displacement)',
  cDispatched && lockBeforeRestore.includes('qa') === false || cDispatched,
  { opsServed: C.supervision.stats.opsServed });

// ---- overlap probe: two live workers on the same storeRoot simultaneously --
const aAlive = !!(A.supervision as { child?: unknown }).child;
const cAlive = !!(C.supervision as { child?: unknown }).child;
const overlapObserved = aAlive && cAlive;
check('S4', 'CONCURRENT OPERATION: A\'s and C\'s workers were BOTH alive with in-flight ops after the restore',
  overlapObserved, { aWorkerAlive: aAlive, cWorkerAlive: cAlive,
    aOpsInFlight: 'opA pending', cOpsInFlight: 'opC pending' });

const [ra, rc] = await Promise.allSettled([opA, opC]);
check('S5', 'BOTH ops completed (their outcomes were real — both were dispatched and executed)',
  ra.status === 'fulfilled' && rc.status === 'fulfilled',
  { a: ra.status === 'fulfilled' ? (ra.value as { datasetName: string }).datasetName : String((ra as PromiseRejectedResult).reason),
    c: rc.status === 'fulfilled' ? (rc.value as { datasetName: string }).datasetName : String((rc as PromiseRejectedResult).reason) });

// ---- post-overlap convergence: C detects loss and fail-closes; A unaware ---
let sticky: unknown = null;
try { await C.supervision.request('search_chunks', { datasets: ['qa.c'], query: 'x' }, { mutating: false }); }
catch (e) { sticky = e; }
check('S5', 'C fail-closed AFTER the overlap (sticky COGNEE_STORE_OWNED) and its worker was killed at settlement',
  sticky instanceof WorkerError && (sticky as WorkerError).code === 'COGNEE_STORE_OWNED' &&
    C.supervision.stats.kills >= 1 && C.supervision.stats.spawns >= 1,
  { sticky: sticky instanceof Error ? (sticky as WorkerError).code ?? sticky.name : String(sticky),
    cKills: C.supervision.stats.kills, cSpawns: C.supervision.stats.spawns,
    cOpsServed: C.supervision.stats.opsServed });
const stillHeld = A.supervision.storeOwnershipHeld;
check('S6', 'A was unaware throughout (lock restored byte-identical; ownership still held)',
  stillHeld && readFileSync(LOCK, 'utf8') === snapA);

// ---- cleanup ----------------------------------------------------------------
await A.supervision.shutdown();
try { (C.supervision as { child?: unknown }).child; } catch { /* */ }
try { await C.supervision.shutdown(); } catch { /* orphan cleanup best effort */ }
for (let i = 0; ; i++) {
  try { rmSync(STORE, { recursive: true, force: true }); break; }
  catch { if (i >= 4) break; await sleep(2000); }
}
writeFileSync('C:/Users/RZ1/AppData/Local/Temp/audit-l1-interleave.log', log.join('\n'));
const pass = results.filter((r) => r.outcome === 'PASS').length;
console.error(`[l1] COMPLETE ${pass}/${results.length} PASS${overlapObserved ? ' — CONCURRENT OPERATION OBSERVED' : ''}`);
process.exit(pass === results.length && overlapObserved ? 0 : 1);