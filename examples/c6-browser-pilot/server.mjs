/**
 * C6 pilot — thin browser-app server (the app's ONLY reusable-code boundary).
 *
 * What this file does (application code, deliberately thin):
 *   - holds TWO VICT runtimes = TWO TRUST DOMAINS (contract §3/§8): each with
 *     its OWN @victframework/cognee pack instance, OWN store root, OWN worker
 *     process, OWN namespace grant. The stores share nothing: no dataset
 *     names, no content (worker `--allow-ns` rail + store-scope enforcement).
 *   - holds the authority profile (like the Stage 05 reference app server):
 *     the browser can NEVER grant itself permissions — every action crosses
 *     the explicit `/api/act` boundary below and is dispatched server-side.
 *   - maps browser input to VICT graph runs; the six Cognee capabilities are
 *     invoked ONLY through VICT graphs (write via the durable keyed path,
 *     reads via capability-only graphs) — never by touching the pack's
 *     supervision/binding internals.
 *
 * What this file deliberately does NOT do:
 *   - no retrieval thresholding, no answer composition: search hits are
 *     passed through VERBATIM and displayed as CANDIDATES only;
 *   - no namespace-based end-user authorization: namespaces are the pack's
 *     store-safety rail (§4), not per-actor authorization (README §Boundary);
 *   - no auto stale-lock recovery, no lock deletion beyond the pack's own
 *     C5-precise release behavior;
 *   - irreversible deletion is DENIED BY DEFAULT: the default-policy act
 *     returns VICT's denial verbatim; the armed act requires the server-side
 *     ARM DELETE flag (not a UI toggle) plus a typed dataset-name
 *     confirmation, and the demo stores are disposable by construction.
 *
 * Trust-domain isolation facts asserted by checks.mjs (C4/C5 evidence class):
 *   - two packs on the same store refuse (COGNEE_STORE_OWNED — C5-proven,
 *     not repeated here); each domain below has a distinct store root;
 *   - datasetsStatus is namespace-filtered per domain: domain B's status
 *     never names domain A's datasets (only a hidden-count shows that the
 *     store-level filter is live);
 *   - searches are dataset-SCOPED and namespace-granted: cross-domain
 *     leakage of names or content is impossible through the pack surface.
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createRuntime, createInMemoryStores, installCapabilityPack,
} from '@victframework/runtime';
import { createCogneePack, WorkerError } from '@victframework/cognee';
import { defineCapability } from '@victframework/sdk';

const here = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PILOT_PORT ?? 4173);
/** Python env with cognee 1.6.1 (see README: proof venv or your own). */
const PY = process.env.PILOT_PYTHON ??
  'C:/Users/RZ1/Desktop/RZ/260925-VCT-Cognee/proof/.venv/Scripts/python.exe';
if (!existsSync(PY)) {
  console.error(`[pilot] PILOT_PYTHON not found: ${PY}
Set PILOT_PYTHON to a Python env that has cognee 1.6.1 installed (see README §Setup).`);
  process.exit(1);
}

/** Disposable demo stores live INSIDE this workspace and are regenerated. */
const STORES_ROOT = path.join(here, '.pilot-stores');

/**
 * Trust domains. Each domain = one createCogneePack() + one runtime (§8:
 * never share a pack object or store across runtimes). Namespaces are the
 * pack's store-safety rail — datasets MUST carry the domain's namespace
 * prefix; the worker enforces it (guard + --allow-ns) regardless of what the
 * browser sends.
 */
const DOMAINS = {
  a: {
    id: 'a',
    label: 'Trust domain A — "notes"',
    namespaces: ['notes'],
    storeRoot: path.join(STORES_ROOT, 'domain-a'),
    grants: ['cognee.write', 'cognee.search'], // NO cognee.delete in A
  },
  b: {
    id: 'b',
    label: 'Trust domain B — "vault"',
    namespaces: ['vault'],
    storeRoot: path.join(STORES_ROOT, 'domain-b'),
    grants: ['cognee.write', 'cognee.search', 'cognee.delete'], // armed delete lives in B only
  },
};

/** Armed irreversible delete: the SERVER holds this switch, never the UI.
 *  Default OFF — /api/act forgetArmed refuses until the server was started
 *  with PILOT_ALLOW_IRREVERSIBLE=1. Deletion is demonstrated ONLY on the
 *  disposable demo stores (delete .pilot-stores/ to reset everything). */
const ARM_DELETE = process.env.PILOT_ALLOW_IRREVERSIBLE === '1';

/* ------------------------------------------------------------------ */
/* Runtime per trust domain                                            */
/* ------------------------------------------------------------------ */

/** App-local PURE capabilities for input mapping only (no domain logic):
 *  the browser's note input is mapped into the pack's add-input shape here,
 *  exactly like the reference-app's neutral input-mapping capabilities. */
const routeCapability = defineCapability({
  id: 'pilot.route', revision: '1', effect: 'pure',
  input: neutralContract('pilot.any-input'),
  output: routeContract(),
  invoke: (input) => ({ route: 'go', value: input }),
});

function neutralContract(id) {
  return {
    id, revision: '1', expected: 'any object',
    parse: (input) => (input !== null && typeof input === 'object'
      ? { ok: true, value: input }
      : { ok: false, issues: [{ code: 'SHAPE', path: '$', message: 'expected object' }] }),
  };
}
function routeContract() {
  return {
    id: 'pilot.route-result', revision: '1', expected: '{ route, value }',
    parse: (input) => (input && typeof input === 'object' && typeof input.route === 'string' &&
      typeof input.value === 'object'
      ? { ok: true, value: input }
      : { ok: false, issues: [{ code: 'SHAPE', path: '$', message: 'expected { route, value }' }] }),
  };
}

/** VICT graphs (per domain; identical shapes — the pack supplies behavior). */
const ADD_GRAPH = {
  id: 'pilot.add', entry: 'decide',
  nodes: [
    { id: 'decide', kind: 'decision', capability: 'pilot.route' },
    { id: 'put', capability: 'cognee.add',
      retry: { maxAttempts: 2, retryOn: ['VICT_RUNTIME_CAPABILITY_THREW'],
        backoff: { kind: 'fixed', delayMs: 200 } },
      timeoutMs: 180_000, output: 'cognee.mutating-receipt' },
  ],
  edges: [{ from: 'decide', to: 'put', kind: 'route', key: 'go' }],
};
const COGNIFY_GRAPH = {
  id: 'pilot.cognify', entry: 'process',
  nodes: [
    { id: 'process', capability: 'cognee.cognify',
      retry: { maxAttempts: 2, retryOn: ['VICT_RUNTIME_CAPABILITY_THREW'],
        backoff: { kind: 'fixed', delayMs: 200 } },
      timeoutMs: 300_000, output: 'cognee.mutating-receipt' },
  ],
  edges: [],
};
const SEARCH_CHUNKS_GRAPH = {
  id: 'pilot.search-chunks', entry: 'find',
  nodes: [{ id: 'find', capability: 'cognee.searchChunks', output: 'cognee.search-output' }],
  edges: [],
};
const SEARCH_SUMMARIES_GRAPH = {
  id: 'pilot.search-summaries', entry: 'find',
  nodes: [{ id: 'find', capability: 'cognee.searchSummaries', output: 'cognee.search-output' }],
  edges: [],
};
const STATUS_GRAPH = {
  id: 'pilot.status', entry: 'list',
  nodes: [{ id: 'list', capability: 'cognee.datasetsStatus', output: 'cognee.status-output' }],
  edges: [],
};
const FORGET_GRAPH = {
  id: 'pilot.forget', entry: 'forget',
  nodes: [
    { id: 'forget', capability: 'cognee.forgetDataset', timeoutMs: 240_000,
      output: 'cognee.forget-receipt' },
  ],
  edges: [],
};

const GRAPH_BY_ACTION = {
  addNote: ADD_GRAPH,
  cognify: COGNIFY_GRAPH,
  searchChunks: SEARCH_CHUNKS_GRAPH,
  searchSummaries: SEARCH_SUMMARIES_GRAPH,
  status: STATUS_GRAPH,
  forgetDefault: FORGET_GRAPH,
  forgetArmed: FORGET_GRAPH,
};

/** Boundary input mapping: browser input -> graph run input, with the
 *  server-side scope rule enforced HERE (the UI cannot map around it). */
function mapActionInput(domain, action, input) {
  const nsOk = (name) => typeof name === 'string' &&
    domain.namespaces.some((ns) => name.startsWith(`${ns}.`));

  switch (action) {
    case 'addNote': {
      const datasetName = String(input?.datasetName ?? '');
      const content = String(input?.content ?? '').trim();
      if (!nsOk(datasetName)) throw new AppError('SCOPE_REFUSED',
        `datasetName must carry this domain's namespace prefix (${domain.namespaces.join(' / ')}.*): '${datasetName}'`);
      if (!content) throw new AppError('INPUT_REFUSED', 'content must be non-empty');
      if (content.length > 4000) throw new AppError('INPUT_REFUSED',
        `note too long for the pilot (${content.length} > 4000 chars)`);
      return { datasetName, content };
    }
    case 'cognify': {
      const datasetName = String(input?.datasetName ?? '');
      if (!nsOk(datasetName)) throw new AppError('SCOPE_REFUSED',
        `datasetName must carry this domain's namespace prefix: '${datasetName}'`);
      return { datasetName };
    }
    case 'searchChunks':
    case 'searchSummaries': {
      // MANDATORY dataset scope: an unscoped search is refused at the
      // boundary — the pack surface has no "search everything" anyway.
      const datasets = Array.isArray(input?.datasets) ? input.datasets.map(String) : [];
      if (datasets.length < 1 || datasets.length > 8 || !datasets.every(nsOk)) {
        throw new AppError('SCOPE_REFUSED',
          'search requires 1..8 dataset names inside this domain\'s namespaces (mandatory scope)');
      }
      const query = String(input?.query ?? '').trim();
      if (!query) throw new AppError('INPUT_REFUSED', 'query must be non-empty');
      const topK = Number.isFinite(Number(input?.topK)) && Number(input.topK) > 0
        ? Math.min(Math.floor(Number(input.topK)), 20) : 8;
      return { datasets, query, topK };
    }
    case 'status':
      return {};
    case 'forgetDefault':
    case 'forgetArmed': {
      const datasetName = String(input?.datasetName ?? '');
      if (!nsOk(datasetName)) throw new AppError('SCOPE_REFUSED',
        `datasetName must carry this domain's namespace prefix: '${datasetName}'`);
      if (action === 'forgetArmed') {
        if (!ARM_DELETE) throw new AppError('DELETE_NOT_ARMED',
          'irreversible delete is not armed: start the server with PILOT_ALLOW_IRREVERSIBLE=1 ' +
          '(demo stores are disposable; the default stays denied)');
        if (String(input?.confirm ?? '') !== datasetName) {
          throw new AppError('CONFIRM_REFUSED',
            `type the dataset name to confirm irreversible deletion: expected '${datasetName}'`);
        }
      }
      return { datasetName };
    }
    default:
      throw new AppError('ACTION_UNKNOWN', `unknown action '${String(action)}'`);
  }
}

class AppError extends Error {
  constructor(code, message) { super(message); this.code = code; this.name = 'AppError'; }
}

/* ------------------------------------------------------------------ */
/* Boot the two trust domains                                          */
/* ------------------------------------------------------------------ */

function bootDomain(domain) {
  mkdirSync(domain.storeRoot, { recursive: true });
  mkdirSync(path.join(domain.storeRoot, 'system'), { recursive: true });
  // Minimal disposable .env for the cognee worker's store (same shape the
  // C5 evidence scripts used — keyless, local, tiny). cognee 1.6.1 requires
  // ABSOLUTE root paths; the C5 batteries write path.join(STORE, sub).
  const envPath = path.join(domain.storeRoot, '.env');
  if (!existsSync(envPath)) {
    const abs = (sub) => path.join(domain.storeRoot, sub).replace(/\\/g, '/');
    writeIfAbsent(envPath, [
      '# C6 pilot disposable store (safe to delete; regenerates on next start)',
      'ENV=dev', 'RUNTIME__LOG_LEVEL=ERROR',
      `SYSTEM_ROOT_DIRECTORY=${abs('system')}`,
      `DATA_ROOT_DIRECTORY=${abs('data')}`,
      `CACHE_ROOT_DIRECTORY=${abs('cache')}`,
      `LOGS_ROOT_DIRECTORY=${abs('logs')}`,
      `COGNEE_REPOS_DIR=${abs('repos')}`,
      'VECTOR_DB_PROVIDER=lancedb', 'GRAPH_DATABASE_PROVIDER=ladybug',
      'DB_PROVIDER=sqlite', 'EMBEDDING_PROVIDER=fastembed',
      'EMBEDDING_MODEL=BAAI/bge-small-en-v1.5', 'EMBEDDING_DIMENSIONS=384',
      'GRAPH_EXTRACTOR=gliner_demo', 'AUTO_FEEDBACK=false', '',
    ].join('\n'));
  }

  const pack = createCogneePack({
    pythonPath: PY, cwd: domain.storeRoot, storeRoot: domain.storeRoot,
    namespaces: domain.namespaces,
    readyBudgetMs: 180_000,
    diag: (line) => console.error(`[sup:${domain.id}] ${line.slice(0, 160)}`),
  });
  const runtime = createRuntime({
    stores: createInMemoryStores(),
    authority: { grants: domain.grants },
  });
  runtime.registerCapability(routeCapability);
  const { installed } = installCapabilityPack(runtime, pack);
  console.error(`[pilot] domain ${domain.id}: store=${domain.storeRoot} ` +
    `namespaces=${domain.namespaces.join(',')} installed=${installed.length}/6 armedDelete=${ARM_DELETE}`);
  return { domain, pack, runtime };
}

function writeIfAbsent(file, content) { if (!existsSync(file)) { try { writeFileSync(file, content); } catch { /* ignore */ } } }

const BOOT = [];
for (const key of Object.keys(DOMAINS)) BOOT.push(bootDomain(DOMAINS[key]));

async function ensureActivation(handle, graph) {
  // The runtime keeps ONE active graph: re-activate before EVERY run so
  // switching actions (add → cognify → search → forget) always pins the
  // right graph. (A cache here would silently run the wrong capability.)
  const activated = await handle.runtime.activate(graph);
  if (!activated.ok) {
    throw new AppError('ACTIVATION_REFUSED',
      `graph ${graph.id}: ${activated.issues?.map((i) => i.code).join(', ')}`);
  }
}

/** The ONE action boundary (mirrors the reference-app dispatcher). */
async function act(domainId, action, input) {
  const handle = BOOT.find((h) => h.domain.id === domainId);
  if (!handle) throw new AppError('DOMAIN_UNKNOWN', `unknown trust domain '${String(domainId)}'`);
  const runInput = mapActionInput(handle.domain, action, input);
  const graph = GRAPH_BY_ACTION[action];
  const t0 = Date.now();
  await ensureActivation(handle, graph);
  const runOptions = { mode: 'normal' };
  if (action === 'forgetArmed') {
    if (!ARM_DELETE) throw new AppError('DELETE_NOT_ARMED',
      'server is not armed: restart with PILOT_ALLOW_IRREVERSIBLE=1 (the boundary, not the UI, denies deletion)');
    // Explicit irreversible run policy — the ONLY way forgetDataset runs.
    runOptions.policy = { allowIrreversible: true };
  }
  const run = await handle.runtime.run(runInput, runOptions);
  return {
    action, domain: domainId,
    status: run.status,
    output: run.output ?? null,
    error: run.error ?? null,
    durationMs: Date.now() - t0,
    workerRssBytes: handle.pack.supervision.stats?.lastRssBytes ?? null,
    spawns: handle.pack.supervision.stats?.spawns ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP: static UI + the act boundary (no other surface)               */
/* ------------------------------------------------------------------ */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, domains: Object.keys(DOMAINS), armedDelete: ARM_DELETE });
    }
    if (req.method === 'POST' && url.pathname === '/api/act') {
      const body = await readBody(req);
      const result = await act(body.domain, body.action, body.input);
      return json(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      // Dev convenience: graceful stop = the pack's C5-precise store release.
      // (A hard kill would strand an unattributable lock; §8 recovery.)
      json(res, 200, { ok: true, note: 'shutting down; store ownership released precisely' });
      setTimeout(shutdown, 50);
      return;
    }
    if (req.method === 'GET') {
      // Static UI only: everything resolves under public/ (traversal guard).
      const rel = path.join('public', url.pathname === '/' ? 'index.html' : url.pathname);
      const file = path.resolve(here, rel);
      if (!file.startsWith(path.join(here, 'public')) || !existsSync(file) ||
          !path.extname(file)) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      return res.end(readFileSync(file));
    }
    res.writeHead(405); res.end();
  } catch (e) {
    const code = e instanceof AppError ? e.code :
      e instanceof WorkerError ? e.code : 'RUN_FAILED';
    json(res, 200, { status: 'refused', error: { code, message: String(e.message ?? e).slice(0, 500) } });
  }
});

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new Error('body too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** Graceful shutdown: stop accepting requests FIRST, then release BOTH
 *  store locks via the pack's C5-precise release (missing/corrupt/foreign
 *  locks are never deleted), sequentially and error-tolerant. A hard kill
 *  here would strand unattributable locks (§8 operator recovery). */
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  console.error('[pilot] shutting down (releasing store ownership)...');
  try { server.close(); } catch { /* already closed */ }
  for (const h of BOOT) {
    try { await h.pack.supervision.shutdown(); }
    catch (e) { console.error(`[pilot] domain ${h.domain.id} shutdown error: ${String(e.message ?? e).slice(0, 200)}`); }
  }
  process.exit(0);
}
/** A crashed worker can surface as an unhandled stdin EPIPE (the pack kills
 *  the child asynchronously). The store locks must STILL be released —
 *  fail closed everywhere EXCEPT the precise release path. */
process.on('uncaughtException', (e) => {
  console.error(`[pilot] uncaught: ${String(e?.message ?? e).slice(0, 300)} — releasing store locks before exit`);
  (async () => {
    shuttingDown = true;
    try { server.close(); } catch { /* ignore */ }
    for (const h of BOOT) {
      try { await h.pack.supervision.shutdown(); } catch { /* best effort */ }
    }
  })().finally(() => process.exit(1));
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.error(`[pilot] C6 browser pilot on http://localhost:${PORT}`);
  console.error(`[pilot] stores (disposable): ${STORES_ROOT}`);
  console.error(`[pilot] irreversible delete armed: ${ARM_DELETE} (server-side switch)`);
});