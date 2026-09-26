// C5 audit — runtime boundary spot checks FROM THE INSTALLED ARTIFACT.
// Disposable store inside this throwaway project; real worker; plain node.
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const { createCogneePack, WorkerError } = await import('@victframework/cognee');
const { validateCapabilityPack } = await import('@victframework/sdk');

const PY = 'C:/Users/RZ1/Desktop/RZ/260925-VCT-Cognee/proof/.venv/Scripts/python.exe';
const STORE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '.probe-store');
try { rmSync(STORE, { recursive: true, force: true }); } catch {}
mkdirSync(path.join(STORE, 'system'), { recursive: true });
writeFileSync(path.join(STORE, '.env'), [
  '# C5 audit probe store (disposable)',
  'ENV=dev', 'RUNTIME__LOG_LEVEL=INFO',
  ...Object.entries({
    SYSTEM_ROOT_DIRECTORY: 'system', DATA_ROOT_DIRECTORY: 'data',
    CACHE_ROOT_DIRECTORY: 'cache', LOGS_ROOT_DIRECTORY: 'logs',
    COGNEE_REPOS_DIR: 'repos',
  }).map(([k, v]) => `${k}=${path.join(STORE, v).replace(/\\/g, '/')}`),
  'VECTOR_DB_PROVIDER=lancedb', 'GRAPH_DATABASE_PROVIDER=ladybug',
  'DB_PROVIDER=sqlite', 'EMBEDDING_PROVIDER=fastembed',
  'EMBEDDING_MODEL=BAAI/bge-small-en-v1.5', 'EMBEDDING_DIMENSIONS=384',
  'GRAPH_EXTRACTOR=gliner_demo', 'AUTO_FEEDBACK=false', '',
].join('\n'));

const results = [];
const check = (id, name, cond, detail) => {
  results.push({ id, outcome: cond ? 'PASS' : 'FAIL' });
  console.error(`[probe] ${id} ${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' :: ' + JSON.stringify(detail)?.slice(0, 400)}`);
  return cond;
};

const pack = createCogneePack({
  pythonPath: PY, cwd: STORE, storeRoot: STORE, namespaces: ['qa'],
  readyBudgetMs: 180_000,
  diag: (l) => console.error(`[probe-sup] ${l.slice(0, 120)}`),
});
const sup = pack.supervision;
const addB = pack.bindings.capabilities.find((b) => b.id === 'cognee.add');
const forgetB = pack.bindings.capabilities.find((b) => b.id === 'cognee.forgetDataset');
const searchB = pack.bindings.capabilities.find((b) => b.id === 'cognee.searchChunks');

// P1: manifest validates; six capabilities; irreversible declared for forget.
{
  const v = validateCapabilityPack(pack, { victVersion: '0.1.0' });
  const forget = pack.manifest.capabilities.find((c) => c.id === 'cognee.forgetDataset');
  check('P1', 'manifest validates via installed SDK; forgetDataset declares irreversible',
    v.ok === true && pack.manifest.capabilities.length === 6 &&
      JSON.stringify(forget).includes('irreversible'),
    { ok: v.ok, issues: v.ok ? null : v.issues, forget });
}

// P2: mode refusal — real binding refuses test/simulate BEFORE any spawn/dispatch.
{
  const spawnsBefore = sup.stats.spawns;
  let err = null;
  try { await addB.invoke({ datasetName: 'qa.p2', content: 'x' }, { mode: 'test', idempotencyKey: 'k-p2' }); }
  catch (e) { err = e; }
  check('P2', "mode='test' refused pre-spawn (COGNEE_MODE_REFUSED)",
    err instanceof WorkerError === false && err?.code === 'COGNEE_MODE_REFUSED' &&
      sup.stats.spawns === spawnsBefore,
    { code: err?.code ?? String(err), spawns: sup.stats.spawns });
}

// P3: unkeyed mutating write refused pre-spawn.
{
  let err = null;
  try { await addB.invoke({ datasetName: 'qa.p3', content: 'x' }, { mode: 'normal' }); }
  catch (e) { err = e; }
  check('P3', 'mutating add WITHOUT ctx.idempotencyKey refused (no unkeyed writes)',
    err instanceof Error && err instanceof WorkerError === false &&
      /idempotencyKey/.test(String(err?.message)) && sup.stats.spawns === 0,
    { msg: String(err?.message).slice(0, 120), spawns: sup.stats.spawns });
}

// P4: expired deadline refused BEFORE dispatch (absolute deadline, no re-arm).
{
  let err = null;
  const servedBefore = sup.stats.opsServed;
  try {
    await addB.invoke({ datasetName: 'qa.p4', content: 'x' },
      { mode: 'normal', idempotencyKey: 'k-p4', deadlineAt: Date.now() - 5_000 });
  } catch (e) { err = e; }
  check('P4', 'expired ctx.deadlineAt refused before dispatch (COGNEE_DEADLINE_EXCEEDED, nothing sent)',
    err?.code === 'COGNEE_DEADLINE_EXCEEDED' && sup.stats.opsServed === servedBefore,
    { code: err?.code ?? String(err), served: sup.stats.opsServed });
}

// P5: scope enforcement through the REAL worker — out-of-namespace dataset refused.
{
  let err = null;
  try {
    await addB.invoke({ datasetName: 'outside.vault', content: 'smuggle' },
      { mode: 'normal', idempotencyKey: 'k-p5' });
    await sup._lifecycle(); // ensure worker is up even if refusal was pre-dispatch
  } catch (e) { err = e; }
  const scopeCodes = new Set(['COGNEE_SCOPE_REJECTED', 'COGNEE_DATASET_NOT_ALLOWED', 'COGNEE_SCOPE', 'COGNEE_ERROR']);
  check('P5', "dataset 'outside.vault' (namespace not granted: qa) refused",
    err instanceof WorkerError && scopeCodes.has(err.code),
    { code: err?.code ?? String(err), msg: String(err?.message ?? '').slice(0, 160) });
}

// P6: keyed write through the real worker — contract-conform receipt.
{
  const receipt = await addB.invoke(
    { datasetName: 'qa.probe', content: 'C5 audit probe marker: dual approval required for settlement windows.' },
    { mode: 'normal', idempotencyKey: 'k-p6-audit' });
  check('P6', 'keyed add through the real worker returns a contract-conform receipt',
    receipt?.datasetName === 'qa.probe' && receipt?.idempotencyKey === 'k-p6-audit' &&
      receipt?.reconciled === 'fresh-execution' &&
      typeof receipt?.itemsAfter === 'number' && typeof receipt?.deduplicated === 'boolean',
    receipt);
}

// P7: cognify then scoped search — in-scope only.
{
  const cognifyB = pack.bindings.capabilities.find((b) => b.id === 'cognee.cognify');
  await cognifyB.invoke({ datasetName: 'qa.probe' },
    { mode: 'normal', idempotencyKey: 'k-p7-cognify', deadlineAt: Date.now() + 240_000 });
  const out = await searchB.invoke({ datasets: ['qa.probe'], query: 'audit probe' },
    { mode: 'normal', deadlineAt: Date.now() + 60_000 });
  const inScope = (out?.hits ?? []).every((h) => String(h.datasetName).startsWith('qa.'));
  check('P7', 'scoped search returns only qa.* datasets', inScope, { total: out?.total });
}

// P8: deletion gating — irreversible forgetDataset refused outside normal mode.
{
  let err = null;
  try { await forgetB.invoke({ datasetName: 'qa.probe' }, { mode: 'simulate' }); }
  catch (e) { err = e; }
  check('P8', "forgetDataset (irreversible) refused in mode='simulate' (COGNEE_MODE_REFUSED)",
    err?.code === 'COGNEE_MODE_REFUSED', { code: err?.code ?? String(err) });
}

// P9: worker lifecycle — second instance refuses pre-spawn; shutdown releases the lock.
{
  const LOCK = path.join(STORE, 'cognee-store-owner.lock');
  let refused = null;
  try { createCogneePack({ pythonPath: PY, cwd: STORE, storeRoot: STORE, namespaces: ['qa'] }); }
  catch (e) { refused = e; }
  await sup.shutdown();
  check('P9', 'second instance refuses (COGNEE_STORE_OWNED); shutdown releases ownership (lock gone)',
    refused instanceof WorkerError && refused.code === 'COGNEE_STORE_OWNED' &&
      !existsSync(LOCK) && !sup.storeOwnershipHeld,
    { code: refused?.code ?? String(refused), lockGone: !existsSync(LOCK) });
}

const pass = results.filter((r) => r.outcome === 'PASS').length;
console.error(`[probe] COMPLETE — ${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
