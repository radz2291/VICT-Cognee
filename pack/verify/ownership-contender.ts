/**
 * Ownership-contender runner — VERIFICATION ONLY.
 *
 * A child process that attempts to claim exclusive store ownership on the
 * store root given as argv[2], optionally with the VERIFICATION-ONLY recovery
 * delay (argv[3], ms). Emits NDJSON events on stdout:
 *   {"event":"judged"}          — a stale lock was judged; claim pending
 *                                 (only when the recovery delay is in use)
 *   {"event":"claiming"}       — about to judge + claim (recovery delay in
 *                                 use; the claim lands delayMs later)
 *   {"event":"done",...}        — final result:
 *                                 { acquired: true, instanceId, lock }
 *                                 { acquired: false, code }
 * With argv[4] === 'hold' the process stays alive holding its ownership
 * (used as the "fresh owner" in the stale-contender test).
 */

import { readFileSync } from 'node:fs';
import { createCogneePack, WorkerError } from '../src/index.js';

const store = process.argv[2] ?? '';
const delayMs = Number(process.argv[3] ?? 0) || 0;
const hold = process.argv[4] === 'hold';

if (delayMs > 0) {
  // Signal the parent that the stale lock is about to be judged (the delay
  // below blocks this thread between judgment and claim).
  console.log(JSON.stringify({ event: 'claiming', delayMs }));
}

try {
  const pack = createCogneePack({
    pythonPath: 'python', cwd: store, storeRoot: store, namespaces: ['qa'],
    ownershipRecoveryDelayMs: delayMs,
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
  const msg = e instanceof Error ? e.message.slice(0, 160) : String(e);
  console.log(JSON.stringify({ event: 'done', acquired: false, code, message: msg }));
  process.exit(0);
}