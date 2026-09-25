/**
 * Hardened Node-facing client for the disposable cognee worker (C3/C4).
 *
 * Implements docs/c3-pack-contract.md §7/§9 at the interface layer:
 *  - bounded NDJSON on the worker's stdout (1 MiB line cap; abort on violation);
 *    worker stderr is diagnostics only (counted, never parsed);
 *  - per-op deadline; mutating timeout => COGNEE_WRITE_UNKNOWN (outcome unknown),
 *    worker poisoned, then killed + respawned before the next request;
 *    the worker never auto-retries;
 *  - reads that time out => CLIENT_DEADLINE;
 *  - ANY worker exit while a MUTATING op is in flight => COGNEE_WRITE_UNKNOWN
 *    (outcome unknown — crash, kill, fault injection, anything), then poison
 *    + respawn; worker exit during a read => COGNEE_WORKER_UNAVAILABLE;
 *  - retry key travels exclusively in `ctx` (VICT CapabilityContext); the
 *    worker rejects keys smuggled through op params (C4 exclusivity);
 *  - strict request serialization (one op at a time — cognee store-lock discipline).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const MAX_LINE = 1024 * 1024;

export class WorkerError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export class WorkerClient {
  /**
   * @param {string} pythonPath  absolute path to the venv python
   * @param {string} workerPath  absolute path to worker.py
   * @param {object} opts        { cwd, namespaces: string[], readyBudgetMs, diag }
   */
  constructor(pythonPath, workerPath, opts) {
    this.pythonPath = pythonPath;
    this.workerPath = workerPath;
    this.opts = opts;
    this.child = null;
    this.ready = null;        // promise resolving with the ready message
    this.pending = new Map(); // id -> { resolve, reject, timer, mutating }
    this.nextId = 1;
    this.queue = Promise.resolve();
    this.poisoned = false;
    this.diag = opts.diag ?? (() => {});
    this.stderrLines = 0;
    this.stdoutViolations = 0;
    this.respawns = 0;
  }

  spawnChild() {
    const args = [this.workerPath];
    for (const ns of this.opts.namespaces) args.push('--allow-ns', ns);
    if (this.opts.storeRoot) args.push('--store-root', this.opts.storeRoot);
    this.child = spawn(this.pythonPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}), PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (line.length > MAX_LINE) {
        this.diag(`FATAL: stdout line exceeds ${MAX_LINE} bytes — aborting`);
        this.child.kill('SIGKILL');
        return;
      }
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // cognee internals can leak non-protocol lines to stdout (observed:
        // alembic migration prints on a fresh store's first connect). Demote
        // to diagnostics and count — never parse, never fatal. The 1 MiB line
        // bound above stays fatal (memory discipline).
        this.stdoutViolations += 1;
        this.diag(`stdout violation (non-JSON, demoted): ${line.slice(0, 120)}`);
        return;
      }
      if (msg.type === 'ready') {
        this.readyInfo = msg;
        if (this.readyResolve) {
          clearTimeout(this.readyTimer);
          this.readyResolve(msg);
          this.readyResolve = null;
          this.readyReject = null;
        }
        return;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new WorkerError(msg.error.code, msg.error.message, msg.error.detail));
      } else {
        this.diag(`unexpected stdout message: ${JSON.stringify(msg).slice(0, 120)}`);
      }
    });
    this.child.stderr.on('data', (d) => {
      this.stderrLines += 1;
      this.diag(`[stderr] ${String(d).trimEnd().slice(0, 200)}`);
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.readyReject) {
        clearTimeout(this.readyTimer);
        this.readyReject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
          `worker exited (code=${code} signal=${signal}) before ready`));
        this.readyResolve = null;
        this.readyReject = null;
      }
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        if (p.mutating) {
          // §7.2 (C4): ANY worker exit with a pending mutation is an unknown
          // outcome — regardless of cause (crash, kill, fault injection).
          this.poisoned = true; // kill + respawn before the next request
          p.reject(new WorkerError('COGNEE_WRITE_UNKNOWN',
            `worker exited (code=${code} signal=${signal}) while mutating op '${p.op}' was in flight; outcome unknown`,
            { op: p.op, idempotencyKey: p.idempotencyKey,
              datasetName: p.datasetName, workerExit: { code, signal } }));
        } else {
          p.reject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
            `worker exited (code=${code} signal=${signal}) while op '${p.op}' was pending`));
        }
      }
      this.pending.clear();
    });
    // ready budget
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(new WorkerError('COGNEE_WORKER_UNAVAILABLE', 'worker not ready in budget'));
      }, this.opts.readyBudgetMs ?? 120_000);
    });
  }

  /** Lifecycle (spawn/kill/respawn + wait ready). NEVER touches this.queue —
   *  safe to call from inside a queue-serialized op. */
  async _lifecycle() {
    if (this.child && !this.poisoned) return this.ready;
    if (this.child) {
      this.child.kill('SIGKILL');
      await delay(300);
      this.child = null;
      this.poisoned = false;
      this.respawns += 1;
    }
    this.spawnChild();
    return this.ready;
  }

  /** Spawn (or respawn) and wait for ready. Serializes with the op queue. */
  ensureReady() {
    return (this.queue = this.queue.then(() => this._lifecycle(),
                                          () => this._lifecycle()));
  }

  /** One serialized op with deadline; mutating timeout => unknown outcome.
   *  `ctx` carries {idempotencyKey, attemptNumber?} — the retry key travels
   *  EXCLUSIVELY here, mirroring VICT CapabilityContext. */
  request(op, params = {}, { deadlineMs = 120_000, mutating = false, ctx = null } = {}) {
    const run = async () => {
      await this._lifecycle();
      const id = String(this.nextId++);
      const message = { id, op, ...params, ...(ctx ? { ctx } : {}) };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          if (mutating) {
            this.poisoned = true; // §7.2: kill + respawn before next request
            reject(new WorkerError('COGNEE_WRITE_UNKNOWN',
              `mutating op '${op}' exceeded ${deadlineMs}ms deadline; outcome unknown`,
              { op, idempotencyKey: ctx?.idempotencyKey ?? null,
                datasetName: params.datasetName }));
          } else {
            reject(new WorkerError('CLIENT_DEADLINE',
              `op '${op}' exceeded ${deadlineMs}ms deadline`));
          }
        }, deadlineMs);
        this.pending.set(id, { resolve, reject, timer, mutating, op,
          idempotencyKey: ctx?.idempotencyKey ?? null,
          datasetName: params.datasetName ?? null });
        this.diag(`send op=${op} id=${id} bytes=${JSON.stringify(message).length}`);
        this.child.stdin.write(JSON.stringify(message) + '\n');
      });
    };
    return (this.queue = this.queue.then(run, run));
  }

  async shutdown() {
    try {
      await this.request('shutdown', {}, { deadlineMs: 25_000 });
    } catch { /* fall through to kill */ }
    if (this.child) {
      this.child.kill();
      await delay(500);
      if (this.child) this.child.kill('SIGKILL');
    }
  }
}