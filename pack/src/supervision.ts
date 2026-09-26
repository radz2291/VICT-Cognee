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
 *  - per-op deadline mapped from the invocation context as an ABSOLUTE
 *    timestamp (deadlineAt): honored through queue wait and worker startup,
 *    re-checked immediately before dispatch, and NEVER replaced with a fresh
 *    full timeout; expiry after a mutation was sent reports an UNKNOWN
 *    outcome (§7.2);
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

/** Minimum usable remainder at DISPATCH time (after queue wait + worker
 *  readiness). Below this the absolute deadline is treated as expired and the
 *  request fails with NO effect — nothing is sent to the worker. Must stay in
 *  sync with the binding-side entry margin (bindings.ts
 *  MIN_USABLE_DEADLINE_REMAINING_MS). */
const MIN_DISPATCH_REMAINING_MS = 250;

/** Default staleness budget for a foreign-host owner's heartbeat. A same-host
 *  owner is verified exactly by pid liveness; only cross-host owners rely on
 *  the heartbeat, so the budget is deliberately generous (§8 residual risk).
 *  The heartbeat is refreshed per op AND continuously while an op is in
 *  flight (interval = staleMs/3, floored at 1 s), so a foreign-host owner is
 *  NOT stealable while it runs arbitrarily long operations; the budget is
 *  only the maximum time a crashed foreign host's lock lingers. */
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
   *  Same-host owners are verified exactly by pid liveness; the heartbeat is
   *  also refreshed continuously while an op is in flight, so long-running
   *  operations do not erode the budget. */
  ownershipStaleMs?: number;
  /** VERIFICATION-ONLY (default 0): artificial pause between judging a lock
   *  stale and executing the atomic claim. Widens the recovery race window
   *  deterministically so the two-contender and stale-contender tests can
   *  exercise it. Must stay 0 in production. */
  ownershipRecoveryDelayMs?: number;
  /** Extra environment for the worker process (verification knobs for the
   *  stub worker; the real worker needs none). */
  env?: Record<string, string>;
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

interface OwnerSnapshot {
  rec: OwnerRecord | null;
  mtimeAgeMs: number;
  /** Raw lock bytes as read (exact-comparison anchor for recovery). */
  raw: string | null;
}

/** Synchronous sleep (verification-only recovery-delay hook; blocks the
 *  thread so the race window is deterministic). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    return;
  } catch { /* fall back to a spin */ }
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
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

  private readOwner(): OwnerSnapshot {
    let raw: string | null = null;
    try {
      raw = readFileSync(this.ownershipLockPath, 'utf8');
    } catch {
      return { rec: null, mtimeAgeMs: Infinity, raw: null };
    }
    let mtimeAgeMs = Infinity;
    try { mtimeAgeMs = Date.now() - statSync(this.ownershipLockPath).mtimeMs; } catch { /* gone */ }
    try {
      return { rec: JSON.parse(raw) as OwnerRecord, mtimeAgeMs, raw };
    } catch {
      return { rec: null, mtimeAgeMs, raw }; // torn/corrupt lock: judged by mtime
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

  private acquireStoreOwnershipContended(depth = 0): void {
    if (depth > 8) {
      throw new WorkerError('COGNEE_STORE_OWNED',
        `store ${this.opts.storeRoot}: ownership could not be settled ` +
        `deterministically after ${depth} contention rounds — failing closed (§8)`);
    }
    const snap = this.readOwner();
    if (this.ownerIsLive(snap.rec, snap.mtimeAgeMs)) {
      const who = snap.rec
        ? `instance=${snap.rec.instanceId.slice(0, 8)} pid=${snap.rec.pid} host=${snap.rec.host}`
        : 'unreadable lock';
      throw new WorkerError('COGNEE_STORE_OWNED',
        `store ${this.opts.storeRoot} is owned by a LIVE owner (${who}); a second ` +
        'pack instance/process must not attach to the same Cognee root (§3/§8). ' +
        'Provision a separate store root for this runtime/trust domain.');
    }
    const why = snap.rec
      ? (snap.rec.host === hostname()
        ? `owner pid ${snap.rec.pid} is dead on this host`
        : `foreign-host owner heartbeat older than ${this.staleMs}ms`)
      : `unreadable lock older than ${this.staleMs}ms`;
    if (this.opts.ownershipRecoveryDelayMs) {
      // VERIFICATION-ONLY: widen the judgment→claim window deterministically.
      sleepSync(this.opts.ownershipRecoveryDelayMs);
    }
    // ATOMIC claim: rename the judged-stale lock out of the way. rename() is
    // atomic and fails for every OTHER contender (ENOENT) once one contender
    // has moved the file — exactly one contender can win the claim. The old
    // unlink-then-create path had a read/unlink/create TOCTOU window in which
    // two contenders could BOTH acquire; that window is closed here.
    const trash = `${this.ownershipLockPath}.recovering-${process.pid}-${randomUUID()}`;
    try {
      renameSync(this.ownershipLockPath, trash);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // The stale lock vanished while we acted: a concurrent contender
        // claimed it (or the owner removed it). Re-evaluate current state.
        this.diag(`stale ownership claim raced (lock moved by a contender); re-evaluating`);
        return this.acquireStoreOwnershipContended(depth + 1);
      }
      // Unexpected rename failure — never unlink blindly; fail closed.
      throw new WorkerError('COGNEE_STORE_OWNED',
        `store ${this.opts.storeRoot}: stale-owner recovery could not be performed ` +
        `safely (${(e as NodeJS.ErrnoException).code}) — failing closed (§8)`);
    }
    // We now hold the ONLY reference to the moved lock. Prove it is STILL the
    // exact lock we judged stale — a fresh owner may have replaced the stale
    // lock between our read and the rename.
    let movedRaw: string | null = null;
    try { movedRaw = readFileSync(trash, 'utf8'); } catch { movedRaw = null; }
    if (movedRaw !== snap.raw) {
      // We displaced a DIFFERENT (possibly fresh/live) lock. Never acquire on
      // an unprovable claim: restore the displaced lock if the path is free
      // (its owner keeps working — the bytes are exactly what it wrote),
      // otherwise the displaced owner will detect the loss at its next
      // operation and fail closed. Either way NO second owner can exist.
      if (!existsSync(this.ownershipLockPath)) {
        try { renameSync(trash, this.ownershipLockPath); } catch { /* raced */ }
      }
      try { unlinkSync(trash); } catch { /* best effort */ }
      throw new WorkerError('COGNEE_STORE_OWNED',
        `store ${this.opts.storeRoot}: stale-owner recovery raced with a fresh ` +
        'owner (the lock changed between judgment and claim) — failing closed; ' +
        'the displaced lock was restored or its owner will detect the loss on ' +
        'its next operation (§8)');
    }
    // The moved lock is proven stale — discard the evidence copy.
    try { unlinkSync(trash); } catch { /* best effort */ }
    if (!this.createLockAtomically()) {
      // A contender created a lock between our rename and create — it wins;
      // re-evaluate against its (live) record.
      return this.acquireStoreOwnershipContended(depth + 1);
    }
    this.diag(`stale store ownership recovered (${why})`);
  }

  /** Verify the ownership lock still exists and still belongs to THIS
   *  instance; fail closed otherwise (ownsStore cleared so every subsequent
   *  request refuses before spawn/dispatch). Called before spawn AND again
   *  immediately before dispatch (after queue wait + worker readiness). */
  private verifyOwnershipIntact(op: string): void {
    if (!this.ownsStore) {
      throw new WorkerError('COGNEE_STORE_OWNED',
        `${op}: store ownership was LOST earlier — refusing before any worker ` +
        'request or effect (§8 fail-closed; re-create the pack instance to re-attach)');
    }
    const { rec } = this.readOwner();
    if (!rec || rec.instanceId !== this.instanceId) {
      this.ownsStore = false; // permanently fail closed from this point on
      throw new WorkerError('COGNEE_STORE_OWNED',
        `${op}: store ownership LOST (lock missing or now held by another ` +
        'instance) — refusing before any worker request or effect (§8)');
    }
  }

  /** Refresh the ownership heartbeat (called per serialized op AND on an
   *  interval while an op is in flight, so long-running operations never
   *  erode the foreign-host staleness budget). Throws (fail closed) when the
   *  lock is missing or no longer ours; NEVER overwrites a lock this
   *  instance does not own. */
  private refreshOwnershipHeartbeat(op: string): void {
    this.verifyOwnershipIntact(op);
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
    // `ensureReady` never existed — the original getter was dead/broken code
    // (never invoked by the pack or the proofs). Anchor it to the real
    // lifecycle: returns the current ready promise, or spawns/wait one.
    return this.readyPromise ?? this._lifecycle();
  }

  private spawnChild(): void {
    const args: string[] = [this.opts.workerPath];
    for (const ns of this.opts.namespaces) args.push('--allow-ns', ns);
    args.push('--store-root', this.opts.storeRoot);
    this.child = spawn(this.opts.pythonPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(this.opts.env ?? {}) },
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

  /** One serialized op with an ABSOLUTE deadline; mutating timeout => unknown
   *  outcome. The context deadline travels as an ABSOLUTE timestamp
   *  (deadlineAt) and is honored through queue wait AND worker startup:
   *  - re-checked immediately before dispatch — an expired deadline fails
   *    with NO effect (nothing is ever sent);
   *  - the response timer is anchored to the absolute deadline, never a
   *    fresh full timeout;
   *  - if the deadline expires AFTER a mutation was sent, the outcome is
   *    reported as UNKNOWN (COGNEE_WRITE_UNKNOWN, §7.2), not as a clean
   *    refusal — the write may already have landed.
   *  Store ownership is verified before spawn, immediately before dispatch,
   *  and refreshed on an interval while the op is in flight; a lost lock
   *  fails the request closed and stops all further operations. */
  request(op: string, params: Record<string, unknown> = {},
    { deadlineMs = 180_000, deadlineAt = null, mutating = false, ctx = null }:
      { deadlineMs?: number; deadlineAt?: number | null; mutating?: boolean;
        ctx?: { idempotencyKey?: string; attemptNumber?: number } | null } = {}):
    Promise<Record<string, unknown>> {
    const run = async (): Promise<Record<string, unknown>> => {
      // (1) ownership refresh + loss detection BEFORE queue wait / spawn.
      this.refreshOwnershipHeartbeat(op);
      // (2) the ABSOLUTE deadline survives the queue and startup unchanged.
      const deadlineAtMs = deadlineAt ?? (Date.now() + deadlineMs);
      if (deadlineAtMs - Date.now() <= MIN_DISPATCH_REMAINING_MS) {
        throw new WorkerError('COGNEE_DEADLINE_EXCEEDED',
          `${op}: ctx deadline expires before the worker request could be ` +
          `dispatched (remaining ${deadlineAtMs - Date.now()}ms) — failing with ` +
          'no effect (the deadline is never replaced with a fresh timeout, §7.2)');
      }
      await this._lifecycle();
      // (3) re-verify ownership + deadline IMMEDIATELY before dispatch (the
      // queue wait and worker startup may have consumed the deadline, and the
      // ownership lock may have been lost meanwhile).
      this.verifyOwnershipIntact(op);
      const remaining = deadlineAtMs - Date.now();
      if (remaining <= MIN_DISPATCH_REMAINING_MS) {
        throw new WorkerError('COGNEE_DEADLINE_EXCEEDED',
          `${op}: deadline expired while waiting for queue/worker readiness ` +
          `(remaining ${remaining}ms) — failing with NO effect, nothing was sent (§7.2)`);
      }
      this.stats.opsServed += 1; // served = actually dispatched to the worker
      const id = String(this.nextId++);
      const message = { id, op, ...params, ...(ctx ? { ctx } : {}) };
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        // In-flight ownership heartbeat: keeps the foreign-host staleness
        // budget valid for arbitrarily long operations. If the lock is lost
        // mid-op, the in-flight op's outcome is already real (the request was
        // sent) — the op completes normally, and on settlement the worker is
        // killed + poisoned so this instance never touches the store again;
        // every subsequent request fails closed before spawn/dispatch.
        let lostMidOp = false;
        const hb = setInterval(() => {
          try { this.refreshOwnershipHeartbeat(op); }
          catch { lostMidOp = true; /* detected; handled at settlement */ }
        }, Math.max(1_000, Math.floor(this.staleMs / 3)));
        const finish = (fail: boolean) => (v: unknown) => {
          clearInterval(hb);
          if (lostMidOp) {
            // Stop touching a store we no longer own.
            this.poisoned = true;
            if (this.child) { this.stats.kills += 1; this.child.kill('SIGKILL'); }
          }
          if (fail) reject(v as WorkerError); else resolve(v as Record<string, unknown>);
        };
        const timer = setTimeout(() => {
          this.pending.delete(id);
          if (mutating) {
            this.poisoned = true; // §7.2: kill + respawn before next request
            finish(true)(new WorkerError('COGNEE_WRITE_UNKNOWN',
              `mutating op '${op}' exceeded its deadline (context deadlineAt ` +
              `expired ${Math.round(remaining)}ms after dispatch); outcome ` +
              'UNKNOWN — the write may already have landed',
              { op, idempotencyKey: ctx?.idempotencyKey ?? null,
                datasetName: params.datasetName ?? null,
                deadlineHonored: true }));
          } else {
            finish(true)(new WorkerError('CLIENT_DEADLINE',
              `op '${op}' exceeded its deadline (context deadlineAt honored ` +
              `${Math.round(remaining)}ms after readiness)`));
          }
        }, remaining);
        this.pending.set(id, {
          resolve: finish(false),
          reject: finish(true),
          timer, mutating, op,
          idempotencyKey: ctx?.idempotencyKey ?? null,
          datasetName: (params.datasetName as string) ?? null,
        });
        this.diag(`send op=${op} id=${id} remainingMs=${Math.round(remaining)} bytes=${JSON.stringify(message).length}`);
        this.child!.stdin!.write(JSON.stringify(message) + '\n');
      });
    };
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
