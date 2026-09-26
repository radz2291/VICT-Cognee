/**
 * Ownership-contender runner — VERIFICATION ONLY.
 *
 * A child process that attempts to claim exclusive store ownership on the
 * store root given as argv[2]. C5 DESIGN: there is NO automatic stale-lock
 * recovery — a contender REFUSES (COGNEE_STORE_OWNED) whenever a lock exists,
 * live or stale; it never moves, overwrites, or deletes a lock. With
 * argv[3] === 'hold' the process stays alive holding its ownership (used as
 * the fresh owner in contention tests).
 *
 * Emits NDJSON events on stdout:
 *   {"event":"done",...} — final result:
 *     { acquired: true,  instanceId, pid }
 *     { acquired: false, code, message }
 */

import { readFileSync } from 'node:fs';
import { createCogneePack, WorkerError } from '../src/index.js';

const store = process.argv[2] ?? '';
const hold = process.argv[3] === 'hold';

try {
  const pack = createCogneePack({
    pythonPath: 'python', cwd: store, storeRoot: store, namespaces: ['qa'],
    diag: () => { /* keep runner output pure JSON lines */ },
  });
  const lock = JSON.parse(readFileSync(`${store.replace(/[\\/]+$/, '')}/cognee-store-owner.lock`, 'utf8'));
  console.log(JSON.stringify({ event: 'done', acquired: true, instanceId: lock.instanceId, pid: process.pid }));
  if (hold) {
    setInterval(() => { /* hold ownership until killed */ }, 1e6);
  } else {
    process.exit(0);
  }
} catch (e) {
  const code = e instanceof WorkerError ? e.code : String((e as Error).message ?? e).slice(0, 80);
  const msg = e instanceof Error ? e.message.slice(0, 220) : String(e);
  console.log(JSON.stringify({ event: 'done', acquired: false, code, message: msg }));
  process.exit(0);
}
