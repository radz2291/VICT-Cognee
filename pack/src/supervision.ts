/**
 * Worker supervision for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Implements the docs/c3-pack-contract.md §7/§8/§9 Node-facing rules:
 *  - ONE live worker per store per trust domain (§3/§7.2): all capability
 *    bindings of a pack instance share one supervision instance; a second
 *    live worker on the same store would collide on the ladybug lock (C4
 *    observation) and is made impossible here.
 *  - EXCLUSIVE STORE OWNERSHIP (C4 exit correction; C5 fail-closed design):
 *    pack-level supervision covers one process, but separate pack instances
 *    or separate PROCESSES could still point at the same Cognee root. An
 *    owner lock (atomic `O_EXCL` create inside the store root) is claimed at
 *    construction and FAILS CLOSED on ANY existing lock — live or stale
 *    (COGNEE_STORE_OWNED) — and is RELEASED on orderly shutdown. There is
 *    NO automatic stale-lock recovery: any scheme that moves a lock out of
 *    its path (rename-aside/restore) provably opens a window in which the
 *    store path has no lock while the previous owner may still be operating,
 *    letting another instance acquire AND dispatch concurrently (demonstrated
 *    deterministically in the C4 exit audit, finding L1). A stale lock is
 *    recovered by an OPERATOR, after verifying the old owner process and its
 *    worker are stopped (contract §8.1); the refusal error carries the owner
 *    record and those exact steps. A live owner's lock is never deleted.
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
import { closeSync, existsSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
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

/** In-flight ownership heartbeat interval floor: interval = staleMs/3,
 *  floored at 1 s. The staleness budget itself is NO LONGER a recovery
 *  trigger (C5: no automatic recovery) — it only sizes how often a long
 *  in-flight operation refreshes the owner heartbeat. */
const DEFAULT_OWNERSHIP_STALE_MS = 15 * 60_000;
const OWNERSHIP_SCHEMA = 'vict.cognee.store-ownership@1';
const LOCK_FILE_NAME = 'cognee-store-owner.lock';

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

/** Windows-tolerant path comparison (case-insensitive, both separators).
 *  Used ONLY for the ready store_root cross-check, where the worker reports
 *  the resolved boundary path. */
function pathsMatch(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
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
  /** Fail-closed containment boundary passed to the worker guard. Resolved
   *  to its real filesystem path at construction (symlinks/subst/case
   *  resolved) so every spelling of one physical store maps to ONE lock
   *  file (audit L3). */
  storeRoot: string;
  readyBudgetMs?: number;
  /** Sizes the in-flight ownership heartbeat interval (staleMs/3, floor
   *  1 s). NOT a recovery trigger — there is no automatic stale recovery
   *  (C5 fail-closed design). */
  ownershipStaleMs?: number;
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
    // C5 (audit L3): cover the PHYSICAL store, not a spelling of it — resolve
    // symlinks/junctions/subst and case so all spellings of one store root
    // map to ONE lock file (the lock lives inside the store).
    let storeRoot = opts.storeRoot;
    if (storeRoot && existsSync(storeRoot)) {
      try { storeRoot = realpathSync(storeRoot); } catch { /* keep spelling */ }
    }
    this.opts = { ...opts, storeRoot, workerPath: opts.workerPath ?? bundledWorkerPath() };
    this.diag = opts.diag ?? (() => {});
    this.ownershipLockPath = path.join(storeRoot, LOCK_FILE_NAME);
    this.staleMs = opts.ownershipStaleMs ?? DEFAULT_OWNERSHIP_STALE_MS;
    this.acquireStoreOwnership();
  }

  // ---- exclusive store ownership (C4 exit + C5 fail-closed; §3/§8) -------
  // Pack-level supervision covers one process, but separate pack instances
  // or separate PROCESSES could still point at the same Cognee root (the
  // ladybug lock only fails at op time — after a worker spawn, possibly
  // mid-write). Ownership is claimed atomically at construction ('wx'),
  // never moved/renamed/overwritten/deleted by any other code path,
  // verified against THIS instance's id at three points (heartbeat refresh,
  // pre-dispatch, in-flight interval), released on orderly shutdown, and
  // NEVER deleted while a live owner holds it. There is NO automatic stale
  // recovery — see acquireStoreOwnership().

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
      return { rec: null, mtimeAgeMs: Infinity };
    }
    let mtimeAgeMs = Infinity;
    try { mtimeAgeMs = Date.now() - statSync(this.ownershipLockPath).mtimeMs; } catch { /* gone */ }
    try {
      return { rec: JSON.parse(raw) as OwnerRecord, mtimeAgeMs };
    } catch {
      return { rec: null, mtimeAgeMs }; // torn/corrupt lock: describe by age
    }
  }

  /** Human-readable owner/liveness description for refusal diagnostics
   *  (informational only — the refusal happens regardless of liveness). */
  private describeOwner(snap: OwnerSnapshot): string {
    if (!snap.rec) {
      return snap.mtimeAgeMs === Infinity
        ? 'the lock file is unreadable'
        : `the lock file is unreadable/corrupt (age ${Math.round(snap.mtimeAgeMs / 1000)}s)`;
    }
    const r = snap.rec;
    let liveness: string;
    if (r.host === hostname()) {
      liveness = pidAlive(r.pid)
        ? 'the owner process IS STILL RUNNING on this host'
        : 'the owner process is NOT running on this host (stale lock)';
    } else {
      const hb = Date.parse(r.heartbeatAt);
      liveness = Number.isFinite(hb)
        ? `foreign host '${r.host}' (last heartbeat ${Math.round((Date.now() - hb) / 1000)}s ago — cannot be verified from here)`
        : `foreign host '${r.host}' (no parseable heartbeat)`;
    }
    return `owner instance=${r.instanceId.slice(0, 8)} pid=${r.pid} host=${r.host}` +
      (r.user ? ` user=${r.user}` : '') + ` startedAt=${r.startedAt} — ${liveness}`;
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

  /** Claim the store or fail closed (COGNEE_STORE_OWNED).
   *
   *  C5 DESIGN DECISION (closes audit finding L1/Medium): there is NO
   *  automatic stale-lock recovery. The audited implementation moved the
   *  existing lock out of the path (rename-aside) and restored it on
   *  mismatch; that provably opens a window in which the store path has no
   *  lock while the previous owner may still be operating, so another
   *  instance could acquire AND dispatch a concurrent operation (the
   *  auditor's deterministic three-process interleaving). An `openSync('wx')`
   *  restore alone does not close the window — the overlap already exists
   *  while the moved lock sits outside the path, before any restore. Rename-
   *  replace schemes cannot be proven atomic on the supported Windows host
   *  (AV/filter drivers) and can still displace a fresh owner whose operation
   *  is in flight. The protocol is therefore trivially provable: the lock is
   *  created ONLY via atomic `O_EXCL` ('wx'), replaced ONLY by its owner's
   *  heartbeat (atomic tmp→rename of its own lock), and deleted ONLY by its
   *  owner's orderly release or an explicit OPERATOR action after verifying
   *  the old owner process and its worker are stopped (contract §8.1). */
  private acquireStoreOwnership(): void {
    if (this.ownsStore) return;
    if (!existsSync(this.opts.storeRoot)) {
      throw new WorkerError('COGNEE_STORE_ROOT_MISSING',
        `store root ${this.opts.storeRoot} does not exist — the binding host must ` +
        'provision the pack-owned store directory (with its own .env) first (§8)');
    }
    this.refuseNestedStoreRoot();
    if (existsSync(this.ownershipLockPath) || !this.createLockAtomically()) {
      throw this.storeOwnedError();
    }
    this.ownsStore = true;
    this.diag(`store ownership acquired: pid=${process.pid} host=${hostname()} ` +
      `instance=${this.instanceId.slice(0, 8)} -> ${this.ownershipLockPath}`);
  }

  /** Audit L3: a store root nested INSIDE another pack-owned store root that
   *  holds a lock is refused — the two roots would be distinct lock files
   *  over one overlapping directory tree (two live workers on one physical
   *  store is forbidden, §3). Only ANCESTORS are scanned (cheap, no tree
   *  walk); provisioning an OUTER root over an active INNER root is a
   *  documented operator rule (roots must be disjoint), not an automatic
   *  detection. */
  private refuseNestedStoreRoot(): void {
    let dir = path.dirname(this.opts.storeRoot);
    for (;;) {
      const candidate = path.join(dir, LOCK_FILE_NAME);
      if (existsSync(candidate)) {
        let who = '';
        try {
          const r = JSON.parse(readFileSync(candidate, 'utf8')) as OwnerRecord;
          if (r && typeof r.instanceId === 'string') {
            who = ` (owner instance=${r.instanceId.slice(0, 8)} pid=${r.pid} host=${r.host})`;
          }
        } catch { /* diagnostic only */ }
        throw new WorkerError('COGNEE_STORE_OWNED',
          `store root ${this.opts.storeRoot} is nested INSIDE another pack-owned ` +
          `store root that holds a lock: ${candidate}${who} — nested store roots ` +
          'share physical disks/caches and are forbidden (§3: roots must be ' +
          'disjoint per trust domain). Provision a store root outside the ' +
          'other store\'s directory tree.');
      }
      const parent = path.dirname(dir);
      if (parent === dir) return; // filesystem root reached
      dir = parent;
    }
  }

  /** The single fail-closed refusal for an existing lock, with the owner
   *  record and the exact operator recovery steps (contract §8.1). */
  private storeOwnedError(): WorkerError {
    const snap = this.readOwner();
    const r = snap.rec;
    return new WorkerError('COGNEE_STORE_OWNED',
      `store ${this.opts.storeRoot} has a store-owner lock — a second pack ` +
      'instance/process must not attach to the same Cognee root (§3/§8). ' +
      `Owner: ${this.describeOwner(snap)}. There is NO automatic stale-lock ` +
      'recovery (C5 fail-closed design). To recover manually, FIRST verify the ' +
      (r ? `old owner process (pid ${r.pid}${r.host !== hostname() ? ` on host '${r.host}'` : ''}) ` : 'old owner process ') +
      'and its worker are STOPPED, then delete the lock file — full procedure ' +
      'in contract §8.1 (docs/c3-pack-contract.md §8.1). The lock was NOT ' +
      'modified or removed by this instance.');
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
      // Audit L1 secondary facet: if no operation is in flight (strict
      // serialization ⇒ pending is empty at the pre-dispatch/refresh call
      // sites), kill the idle worker NOW so a lost owner never leaves an
      // orphaned live worker holding store handles. An IN-FLIGHT op is left
      // alone — its outcome is already real; it is killed at settlement
      // (§7.2 lostMidOp policy below).
      if (this.pending.size === 0 && this.child) {
        this.stats.kills += 1;
        this.child.kill('SIGKILL');
        this.child = null;
      }
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
    const proc = spawn(this.opts.pythonPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1', ...(this.opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = proc;
    this.stats.spawns += 1;
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      // C5: this handler is scoped to `proc` — a STALE child's late output is
      // ignored (it must never resolve the CURRENT child's readiness or
      // settle ops that belong to the newer lifecycle).
      if (this.child !== proc) return;
      if (line.length > MAX_LINE) {
        this.diag(`FATAL: stdout line exceeds ${MAX_LINE} bytes — aborting`);
        proc.kill('SIGKILL');
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
        // C5 (audit L3): cross-check the worker's REPORTED store boundary
        // against the configured one — a worker serving a different root is
        // killed before it can resolve anything. The stub worker sends no
        // store_root (absent ⇒ no check); the real worker always does.
        const reportedRoot = typeof msg.store_root === 'string' ? msg.store_root : null;
        if (reportedRoot && !pathsMatch(reportedRoot, this.opts.storeRoot)) {
          this.diag(`FATAL: worker ready store_root mismatch: reported=${reportedRoot} ` +
            `configured=${this.opts.storeRoot} — killing worker (§8 boundary)`);
          proc.kill('SIGKILL');
          return; // never resolve readiness for a mis-bounded worker
        }
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
    proc.stderr.on('data', (d: Buffer) => {
      this.stats.stderrLines += 1;
      this.diag(`[worker] ${String(d).trimEnd().slice(0, 200)}`);
    });
    proc.on('exit', (code, signal) => {
      // C5 lifecycle scoping: only the CURRENT child's exit may clear the
      // lifecycle state. A stale child's exit (already replaced by a newer
      // spawn, or already settled by the ready timer) is ignored — otherwise
      // the killed child's late exit event would null the NEW child reference
      // and reject the NEW ready promise (race found by the V10g test).
      if (this.child !== proc) {
        this.diag(`stale worker exit ignored (code=${code} signal=${signal})`);
        return;
      }
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
        // C5 (audit L2): a ready-budget expiry must not strand a live child.
        // Nothing was dispatched (the request never reached pending), so
        // killing is clean — no unknown-outcome window — and the next
        // request respawns a fresh worker (proven by verify.ts V10g).
        this.stats.kills += 1;
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
        if (this.child === proc) this.child = null;
        reject(new WorkerError('COGNEE_WORKER_UNAVAILABLE',
          `worker not ready within ${this.opts.readyBudgetMs ?? 180_000}ms — ` +
          'worker killed; the next request respawns a fresh worker'));
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
