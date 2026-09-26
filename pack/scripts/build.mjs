/**
 * C5 build script — compiles pack/src (TypeScript) to distributable
 * JavaScript and ships the Python worker + guard inside dist/worker/.
 *
 * Produces the exact layout the package ships (npm `files`: ["dist",
 * "README.md"]):
 *   dist/index.js + *.d.ts + *.js.map      (compiled from src/*.ts)
 *   dist/worker/cognee_worker.py           (pack-bundled worker, protocol 5)
 *   dist/worker/guard_store_roots.py       (fail-closed store-root guard)
 *
 * The supervision default workerPath resolves against the compiled module
 * (`import.meta.url` dirname + worker/cognee_worker.py), so the SAME code
 * resolves pack/src/worker/ in the repo and dist/worker/ in the installed
 * package — no repo-relative path, no tsx, no build tooling at runtime.
 *
 * TypeScript is NOT a runtime dependency of the package: this script locates
 * the compiler from the local VICT reference clone (read-only) or $C5_TSC.
 *
 * Run (from repo root):  node pack/scripts/build.mjs
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packDir = path.resolve(here, '..');
const repo = path.resolve(packDir, '..');
const dist = path.join(packDir, 'dist');

// Locate the TypeScript compiler (build-time only; never shipped).
const victHome = process.env.C5_VICT_HOME ?? path.resolve(repo, '..', '260831-VCT-02');
const tscCandidates = [
  process.env.C5_TSC,
  path.join(victHome, 'node_modules', 'typescript', 'bin', 'tsc'),
].filter(Boolean);
const tsc = tscCandidates.find((p) => existsSync(p));
if (!tsc) {
  console.error(`[build] TypeScript compiler not found (looked at: ${tscCandidates.join(', ')})`);
  console.error('[build] set C5_TSC=<path to typescript/bin/tsc> or C5_VICT_HOME=<vict clone>');
  process.exit(1);
}
// @types/node for the compile (also build-time only).
const typeRootsNode = process.env.C5_TYPES_ROOTS ?? path.join(victHome, 'node_modules', '@types');
const typeRootsArg = existsSync(path.join(typeRootsNode, 'node')) ? typeRootsNode : null;

const node = process.execPath;
const rel = (p) => path.relative(repo, p).replace(/\\/g, '/');

// ---- clean + compile ---------------------------------------------------------
for (let attempt = 0; ; attempt++) {
  try { rmSync(dist, { recursive: true, force: true }); break; }
  catch {
    if (attempt >= 4) { console.error('[build] cannot clear dist/'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 1_000));
  }
}
const t = Date.now();
const args = ['-p', path.join(packDir, 'tsconfig.json')];
if (typeRootsArg) args.push('--typeRoots', typeRootsArg);
const run = spawnSync(node, [tsc, ...args], { encoding: 'utf8', timeout: 180_000 });
if (run.status !== 0) {
  console.error(`[build] tsc failed:\n${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  process.exit(1);
}
console.error(`[build] tsc ok (${Date.now() - t}ms)`);

// ---- ship the Python worker + guard inside dist/worker/ ----------------------
mkdirSync(path.join(dist, 'worker'), { recursive: true });
for (const py of ['cognee_worker.py', 'guard_store_roots.py']) {
  const src = path.join(packDir, 'src', 'worker', py);
  cpSync(src, path.join(dist, 'worker', py));
  console.error(`[build] shipped ${rel(src)} -> dist/worker/${py}`);
}

// ---- sanity: the compiled module resolves the bundled worker -----------------
const supSrc = readFileSync(path.join(dist, 'supervision.js'), 'utf8');
if (!supSrc.includes("'worker'") && !supSrc.includes('"worker"')) {
  console.error('[build] FATAL: dist/supervision.js lost the worker/ resolution');
  process.exit(1);
}
// Strip comments, then require that no repo-relative path survived as code.
const supCode = supSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
if (supCode.includes('pack/src') || supCode.includes(repo.replace(/\\/g, '\\\\'))) {
  console.error('[build] FATAL: dist/supervision.js contains a repo-relative path');
  process.exit(1);
}

// ---- report ------------------------------------------------------------------
const walk = (dir, prefix = '') => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(path.join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]);
const files = walk(dist).sort();
const bytes = files.reduce((n, f) => n + statSync(path.join(dist, f)).size, 0);
console.error(`[build] dist/ (${files.length} files, ${bytes} bytes):`);
for (const f of files) console.error(`[build]   ${f}`);
console.error('[build] DONE');
