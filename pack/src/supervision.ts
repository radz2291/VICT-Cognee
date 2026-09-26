/**
 * Worker supervision for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Implements the docs/c3-pack-contract.md §7/§8/§9 Node-facing rules:
 *  - ONE live worker per store per trust domain (§3/§7.2): all capability
 *    bindings of a pack instance share one supervision instance; a second
 *    live worker on the same store would collide on the ladybug lock (C4
 *    observation) and is made impossible here.
 *  - EXCLUSIVE STORE OWNERSHIP (C4 exit correction): pack-level supervision
 *    covers one process, but separate pack instances or separate PROCESSES
 *    could still point at the same Cognee root. An owner lock (atomic
 *    O_EXCL create inside the store root) is claimed at construction and
 *    FAILS CLOSED on a live owner (COGNEE_STORE_OWNED), recovers a
 *    verifiably STALE owner (dead pid on this host; foreign host whose
 *    heartbeat exceeded the stale budget), and is RELEASED on orderly
 *    shutdown — a live owner's lock is never deleted.
 *  - bounded NDJSON on the worker's stdout (1 MiB line cap); stderr is
 *    diagnostics only (never parsed);
 *  - per-op deadline mapped from the invocation context when available;
 *  - mutating timeout OR ANY worker exit during an in-flight mutation =>
 *    COGNEE_WRITE_UNKNOWN (outcome unknown) + poison + kill/respawn before
 *    the next request; the worker never auto-retries;
 *  - the retry key travels EXCLUSIVELY in the request `ctx`
 *    (VICT CapabilityContext.idempotencyKey); never in op params;
 *  - strict request serialization (one op at a time).
 *
 * The supervised worker is the PACK-BUNDLED worker (src/worker/
 * cognee_worker.py, protocol vict-cognee-worker/5) — it carries NO fault
 * injection (C4 exit: crash injection lives only in the proof harness
 * worker/worker_proof.py).
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const MAX_LINE = 1024 * 1024;

/** Default staleness budget for a foreign-host owner's heartbeat. A same-host
 *  owner is verified exactly by pid liveness; only cross-host owners rely on
 *  the heartbeat, so the budget is deliberately generous (§8 residual risk). */
const DEFAULT_OWNERSHIP_STALE_MS = 15 * 60_000;
const OWNERSHIP_SCHEMA = 'vict.cognee.store-ownership@1';

/** Default path of the PACK-BUNDLED worker, resolved against this module. */
function bundledWorkerPath(): string {
  // supervision.js lives in pack/src; the bundled worker is pack/src/worker/.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker', 'cognee_worker.py');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // existence probe — works on Windows (uv_kill)
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, not ours
  }
}

export class WorkerError extends Error {
  code: string;
  detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface SupervisionOptions {
  pythonPath: string;
  /** Worker entry script. Defaults to the PACK-BUNDLED worker
   *  (pack/src/worker/cognee_worker.py) resolved against this module. */
  workerPath?: string;
  /** Worker cwd — the store directory holding its own .env (§8 dotenv rule). */
  cwd: string;
  namespaces: readonly string[];
  /** Fail-closed containment boundary passed to the worker guard. */
  storeRoot: string;
  readyBudgetMs?: number;
  /** Ownership staleness budget for foreign-host owners (default 15 min).
   *  Same-host owners are verified exactly by pid liveness. */
  ownershipStaleMs?: number;
  diag?: (line: string) => void;
}

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: WorkerError) => void;
  timer: NodeJS.Timeout;
  mutating: boolean;
  op: string;
  idempotencyKey: string | null;
  datasetName: string | null;
}

interface OwnerRecord {
  schema: string;
  instanceId: string;
  pid: number;
  host: string;
  user?: string;
  startedAt: string;
  heartbeatAt: string;
}

export class CogneeWorkerSupervision {
  private readonly opts: SupervisionOptions & { workerPath: string };
  private readonly ownershipLockPath: string;
  private readonly staleMs: number;
  private readonly instanceId = randomUUID();
  private ownsStore = false;
  private child: ReturnType<typeof spawn> | null = null;
  private readyInfo: Record<string, unknown> | null = null;
  private readyPromise: Promise<Record<string, unknown>> | null = null;
  private readyResolve: ((v: Record<string, unknown>) => void) | null = null;
  private readyReject: ((e: WorkerError) => void) | null = null;
  private readyTimer: NodeJS.Timeout | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private readonly diag: (line: string) => void;

  /** Observable resource/lifecycle stats (contract §9, recorded by the harness). */
  readonly stats = { spawns: 0, respawns: 0, kills: 0, lastRssBytes: 0, opsServed: 0, stderrLines: 0, stdoutViolations: 0 };

  constructor(opts: SupervisionOptions) {
    this.opts = { ...opts, workerPath: opts.workerPath ?? bundledWorkerPath() };
    this.diag = opts.diag ?? (() => {});
    this.ownershipLockPath = path.join(opts.storeRoot, 'cognee-store-owner.lock');
    this.staleMs = opts.ownershipStaleMs ?? DEFAULT_OWNERSHIP_STALE_MS;
    this.acquireStoreOwnership();
  }

  // ---- exclusive store ownership (C4 exit; contract §3/§8) ---------------
  // Pack-level supervision covers one process, but separate pack instances
  // or separate PROCESSES could still point at the same Cognee root (the
  // ladybug lock only fails at op time — after a worker spawn, possibly
  // mid-write). Ownership is claimed atomically at construction, verified
  // against liveness, refreshed per op, released on orderly shutdown, and
  // NEVER deleted while a live owner holds it.

  private lockRecord(): OwnerRecord {
    let user: string | undefined;
    try { user = userInfo().username; } catch { /* diagnostics only */ }
    return {
      schema: OWNERSHIP_SCHEMA,
      instanceId: this.instanceId,
      pid: process.pid,
      host: hostname(),
      ...(user !== undefined ? { user } : {}),
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
  }

  private readOwner(): { rec: OwnerRecord | null; mtimeAgeMs: number } {
    let raw: string;
    try {
      raw = readFileSync(this.ownershipLockPath, 'utf8');
    } catch {
      return { rec: null, mtimeAgeMs: Infinity };
    }
    let mtimeAgeMs = Infinity;
    try { mtimeAgeMs = Date.now() - statSync(this.ownershipLockPath).mtimeMs; } catch { /* gone */ }
    try {
      return { rec: JSON.parse(raw) as OwnerRecord, mtimeAgeMs };
    } catch {
      return { rec: null, mtimeAgeMs }; // torn/corrupt lock: judged by mtime
    }
  }

  private ownerIsLive(rec: OwnerRecord | null, mtimeAgeMs: number): boolean {
    if (!rec || rec.schema !== OWNERSHIP_SCHEMA) {
      // Unparseable/foreign lock: treat as live unless provably ancient.
      return mtimeAgeMs < this.staleMs;
    }
    if (rec.host === hostname()) {
      // Same host: pid liveness is EXACT. A dead pid proves staleness
      // regardless of heartbeat age; a live pid is live even with a stale
      // heartbeat (never deleted).
      return pidAlive(rec.pid);
    }
    // Foreign host: pid cannot be verified — heartbeat only.
    const hb = Date.parse(rec.heartbeatAt);
    return Number.isFinite(hb) ? (Date.now() - hb) < this.staleMs : mtimeAgeMs < this.staleMs;
  }

  private createLockAtomically(): boolean {
    // 'wx' fails with EEXIST if a concurrent owner wins the race.
    let fd: number;
    try {
      fd = openSync(this.ownershipLockPath, 'wx');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    try { writeSync(fd, JSON.stringify(this.lockRecord())); } finally { closeSync(fd); }
    return true;
  }

  /** Claim the store or fail closed (COGNEE_STORE_OWNED). */
  private acquireStoreOwnership(): void {
    if (this.ownsStore) return;
    if (!existsSync(this.opts.storeRoot)) {
      throw new WorkerError('COGNEE_STORE_ROOT_MISSING',
        `store root ${this.opts.storeRoot} does not exist — the binding host must ` +
        'provision the pack-owned store directory (with its own .env) first (§8)');
    }
    if (existsSync(this.ownershipLockPath) || !this.createLockAtomically()) {
      this.acquireStoreOwnershipContended();
    }
    this.ownsStore = true;
    this.diag(`store ownership acquired: pid=${process.pid} host=${hostname()} ` +
      `instance=${this.instanceId.slice(0, 8)} -> ${this.ownershipLockPath}`);
  }

  private acquireStoreOwnershipContended(): void {
    const { rec, mtimeAgeMs } = this.readOwner();
    if (this.ownerIsLive(rec, mtimeAgeMs)) {
      const who = rec
        ? `instance=${rec.instanceId.slice(0, 8)} pid=${rec.pid} host=${rec.host}`
        : 'unreadable lock';
      throw new WorkerError('COGNEE_STORE_OWNED',
        `store ${this.opts.storeRoot} is owned by a LIVE owner (${who}); a second ` +
        'pack instance/process must not attach to the same Cognee root (§3/§8). ' +
        'Provision a separate store root for this runtime/trust domain.');
    }
    // Stale owner: recover. Evidence: same-host dead pid (exact), or foreign
    // host with a heartbeat older than the stale budget, or an unreadable
    // lock older than the stale budget. Recovery unlinks and re-creates via
    // 'wx'; if a racing owner re-created its lock in between, 'wx' fails and
    // we re-evaluate — a live owner's lock is never overwritten or deleted
    // on the strength of a stale observation alone.
    const why = rec
      ? (rec.host === hostname()
        ? `owner pid ${rec.pid} is dead on this host`
        : `foreign-host owner heartbeat older than ${this.staleMs}ms`)
      : `unreadable lock older than ${this.staleMs}ms`;
    this.diag(`stale store ownership recovered (${why})`);
    try { unlinkSync(this.ownershipLockPath); } catch { /* raced; wx decides */ }
    if (!this.createLockAtomically()) this.acquireStoreOwnershipContended();
  }

  /** Refresh the ownership heartbeat (called per serialized op). Never
   *  overwrites a lock this instance does not own. */
  private refreshOwnershipHeartbeat(): void {
    if (!this.ownsStore) return;
    const { rec } = this.readOwner();
    if (!rec || rec.instanceId !== this.instanceId) return; // lost/raced: untouched
    // Atomic replace (Node rename overwrites the destination on NTFS/ext).
    const tmp = `${this.ownershipLockPath}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w');
    try { writeSync(fd, JSON.stringify(this.lockRecord())); } finally { closeSync(fd); }
    renameSync(tmp, this.ownershipLockPath);
  }

  /** Release ownership on orderly shutdown. Deletes the lock ONLY if it
   *  still carries THIS instance's id — a live/foreign owner's lock is
   *  never deleted. */
  releaseStoreOwnership(): void {
    if (!this.ownsStore) return;
    const { rec } = this.readOwner();
    if (rec && rec.instanceId !== this.instanceId) {
      this.diag('store ownership not released: lock no longer ours (foreign instance)');
      this.ownsStore = false;
      return;
    }
    try { unlinkSync(this.ownershipLockPath); } catch { /* already gone */ }
    this.ownsStore = false;
    this.diag(`store ownership released: pid=${process.pid} instance=${this.instanceId.slice(0, 8)}`);
  }

  /** Observable ownership state (verification/audit). */
  get storeOwnershipHeld(): boolean {
    return this.ownsStore;
  }

  /** Resolved worker path (verification: the pack-bundled worker). */
  get workerPath(): string {
    return this.opts.workerPath;
  }

  get ready(): Promise<Record<string, unknown>> {
    return this.ensureReady();
  }

  private spawnChild(): void {
    const args: string[] = [this.opts.workerPath];
    for (const ns of this.opts.namespaces) args.push('--allow-ns', ns);
    args.push('--store-root', this.opts.storeRoot);
    this.child = spawn(this.opts.pythonPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.stats.spawns += 1;
    const rl = createInterface({ input: this.child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      if (line.length > MAX_LINE) {
        this.diag(`FATAL: stdout line exceeds ${MAX_LINE} bytes — aborting`);
        this.child?.kill('SIGKILL');
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        // cognee internals can leak non-protocol lines to stdout (observed:
        // alembic migration prints on a fresh store's first connect). Demote
        // to diagnostics and count — never parse, never fatal. The 1 MiB line
        // bound above stays fatal (memory discipline).
        this.stats.stdoutViolations += 1;
        this.diag(`stdout violation (non-JSON, demoted): ${line.slice(0, 120)}`);
        return;
      }
      if (msg.type === 'ready') {
        this.readyInfo = msg;
        this.stats.lastRssBytes = Number(msg.rss_bytes ?? 0);
        if (this.readyResolve) {
          if (this.readyTimer) clearTimeout(this.readyTimer);
          this.readyResolve(msg);
          this.readyResolve = null;
          this.readyReject = null;
        }
        return;
      }
      const id = String(msg.id);
      const p = this.pending.get(id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (msg.ok) p.resolve(msg.result);
        else {
          const err = msg.error as { code: string; message: string; detail?: unknown };
          p.reject(new WorkerError(err.code, err.message, err.detail));
        }
      } else {
        this.diag(`unexpected stdout message: ${JSON.stringify(msg).slice(0, 120)}`);
      }
    });
    this.child.stderr!.on('data', (d: Buffer) => {
      this.stats.stderrLines += 1;
      this.diag(`[worker] ${String(d).trimEnd().slice(0, 200)}`);
    });
    this.child.on('exit', (code, signal) => {
      this.child = null;
      if (this.readyReject) {
        if (this.readyTimer) clearTimeout(this.readyTimer);
        this.readyReject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
          `worker exited (code=${code} signal=${signal}) before ready`));
        this.readyResolve = null;
        this.readyReject = null;
      }
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        if (p.mutating) {
          // §7.2: ANY worker exit with a pending mutation is an unknown outcome.
          this.poisoned = true;
          p.reject(new WorkerError('COGNEE_WRITE_UNKNOWN',
            `worker exited (code=${code} signal=${signal}) while mutating op '${p.op}' was in flight; outcome unknown`,
            { op: p.op, idempotencyKey: p.idempotencyKey, datasetName: p.datasetName,
              workerExit: { code, signal } }));
        } else {
          p.reject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
            `worker exited (code=${code} signal=${signal}) while op '${p.op}' was pending`));
        }
      }
      this.pending.clear();
    });
    this.readyPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject as (e: WorkerError) => void;
      this.readyTimer = setTimeout(() => {
        this.readyResolve = null;
        this.readyReject = null;
        reject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
          `worker not ready within ${this.opts.readyBudgetMs ?? 180_000}ms`));
      }, this.opts.readyBudgetMs ?? 180_000);
    });
  }

  /** Lifecycle (spawn/kill/respawn + wait ready). Queue-free; re-entrant safe. */
  async _lifecycle(): Promise<Record<string, unknown>> {
    if (this.child && !this.poisoned) return this.readyPromise!;
    if (this.child) {
      this.stats.kills += 1;
      this.child.kill('SIGKILL');
      await delay(300);
      this.child = null;
      this.poisoned = false;
      this.stats.respawns += 1;
    }
    this.spawnChild();
    return this.readyPromise!;
  }

  /** One serialized op with deadline; mutating timeout => unknown outcome. */
  request(op: string, params: Record<string, unknown> = {},
    { deadlineMs = 180_000, mutating = false, ctx = null }:
      { deadlineMs?: number; mutating?: boolean; ctx?: { idempotencyKey?: string; attemptNumber?: number } | null } = {}):
    Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      this.refreshOwnershipHeartbeat();
      await this._lifecycle();
      const id = String(this.nextId++);
      const message = { id, op, ...params, ...(ctx ? { ctx } : {}) };
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          if (mutating) {
            this.poisoned = true; // §7.2: kill + respawn before next request
            reject(new WorkerError('COGNEE_WRITE_UNKNOWN',
              `mutating op '${op}' exceeded ${deadlineMs}ms deadline; outcome unknown`,
              { op, idempotencyKey: ctx?.idempotencyKey ?? null,
                datasetName: params.datasetName ?? null }));
          } else {
            reject(new WorkerError('CLIENT_DEADLINE',
              `op '${op}' exceeded ${deadlineMs}ms deadline`));
          }
        }, deadlineMs);
        this.pending.set(id, { resolve, reject, timer, mutating, op,
          idempotencyKey: ctx?.idempotencyKey ?? null,
          datasetName: (params.datasetName as string) ?? null });
        this.diag(`send op=${op} id=${id} bytes=${JSON.stringify(message).length}`);
        this.child!.stdin!.write(JSON.stringify(message) + '\n');
      });
    };
    this.stats.opsServed += 1;
    return this.queue = this.queue.then(run, run) as Promise<Record<string, unknown>>;
  }

  async shutdown(): Promise<void> {
    try {
      await this.request('shutdown', {}, { deadlineMs: 25_000 });
    } catch { /* fall through to kill */ }
    if (this.child) {
      this.child.kill();
      await delay(500);
      if (this.child) this.child.kill('SIGKILL');
      this.child = null;
    }
    // Orderly shutdown releases the exclusive store ownership (C4 exit).
    this.releaseStoreOwnership();
  }
}
