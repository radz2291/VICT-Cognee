/**
 * Bindings for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Executable handlers + test/simulate doubles, supplied separately from the
 * serializable manifest (handlers are never serialized). All cognee work goes
 * through ONE CogneeWorkerSupervision per pack instance = one live worker per
 * store per trust domain (contract §3/§7.2).
 *
 * Invocation rules implemented here:
 *  - FAIL-CLOSED MODE GUARD (C4 exit correction; upstream VICT issue UV-1):
 *    the durable orchestration engine ignores the effect policy's useDouble
 *    decision and invokes the pinned REAL binding in test/simulate. Every
 *    real binding below therefore refuses any ctx.mode !== 'normal' BEFORE
 *    any worker request or effect — the documented effect-policy table is
 *    restored at the pack boundary.
 *  - FAIL-CLOSED DEADLINES (C4 exit correction): an invocation whose
 *    CapabilityContext.deadlineAt is already expired (or has insufficient
 *    remaining time) fails immediately — it NEVER reaches the worker and is
 *    NEVER granted a fresh full timeout. Only invocations with no deadlineAt
 *    at all get the per-op fallback budget.
 *  - the retry key comes EXCLUSIVELY from CapabilityContext.idempotencyKey —
 *    never from input params (worker re-checks and rejects smuggled keys);
 *  - a mutating invocation with NO context key is REFUSED (it can never be
 *    safely replayed): this happens when a graph invokes a write through the
 *    sequential engine or without a node retry policy (contract §1/§7.3);
 *  - typed worker failures throw at the binding boundary; VICT reduces thrown
 *    messages to a safe type name + code (untrusted content), so typed codes
 *    are authoritative only inside worker responses/receipts.
 */

import { CogneeWorkerSupervision, WorkerError } from './supervision.js';
import {
  AddInput, MutatingReceipt, DatasetRef, SearchInput, SearchOutput,
  StatusInput, StatusOutput, ForgetReceipt,
  AddInputContract, MutatingReceiptContract, DatasetRefContract,
  SearchInputContract, SearchOutputContract, StatusInputContract,
  StatusOutputContract, ForgetReceiptContract,
} from './contracts.js';

/** Minimal structural mirror of the VICT CapabilityContext (type-only use). */
export interface InvocationContext {
  readonly mode?: string;
  readonly idempotencyKey?: string;
  readonly attemptNumber?: number;
  readonly deadlineAt?: number;
  readonly [k: string]: unknown;
}

export type Invoke = (input: unknown, context: InvocationContext) => Promise<unknown>;

const DEFAULT_MUTATING_DEADLINE_MS = 240_000;
const DEFAULT_READ_DEADLINE_MS = 120_000;
/** Minimum usable remainder for a context deadline (scheduling/transport
 *  margin). Below this the deadline is treated as insufficient and the
 *  invocation fails BEFORE the worker request — it is never re-armed with a
 *  fresh full timeout (C4 exit correction). */
const MIN_USABLE_DEADLINE_REMAINING_MS = 250;

/** Typed pre-invocation refusal (thrown before any worker request/effect;
 *  VICT reduces thrown messages to a safe type name + code). */
export class BindingRefusedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BindingRefusedError';
  }
}

/** UV-1 fail-closed mode guard: ONLY 'normal' may reach the real worker.
 *  The durable orchestration engine invokes real bindings in test/simulate
 *  (upstream vict-02@5ea0afe2, orchestration-driver.ts ~702); the pack
 *  refuses them here, before any worker request or store effect. */
function requireNormalMode(ctx: InvocationContext, op: string): void {
  if (ctx.mode !== 'normal') {
    throw new BindingRefusedError('COGNEE_MODE_REFUSED',
      `${op}: real binding refuses mode '${String(ctx.mode)}' — the durable engine ` +
      'runs real bindings in test/simulate (upstream issue UV-1); only ctx.mode ' +
      "'normal' may reach the worker. Declare a test double or run in normal mode.");
  }
}

/** Fail-closed deadline mapping. Returns the per-op fallback ONLY when the
 *  context carries NO deadline at all. An expired or insufficient
 *  ctx.deadlineAt throws BEFORE any worker request (the operation never
 *  starts, so no unknown-outcome window is created). */
function deadlineFrom(ctx: InvocationContext, op: string, fallback: number): number {
  if (typeof ctx.deadlineAt === 'number' && Number.isFinite(ctx.deadlineAt)) {
    const remaining = ctx.deadlineAt - Date.now();
    if (remaining <= MIN_USABLE_DEADLINE_REMAINING_MS) {
      throw new BindingRefusedError('COGNEE_DEADLINE_EXCEEDED',
        `${op}: CapabilityContext.deadlineAt ${remaining <= 0 ? 'has expired' +
          ` ${Math.abs(Math.round(remaining))}ms ago` : 'leaves insufficient time ' +
          `(${Math.round(remaining)}ms < ${MIN_USABLE_DEADLINE_REMAINING_MS}ms)`}; ` +
          'refusing before the worker request (the deadline is never replaced ' +
          'with a fresh timeout)');
    }
    return remaining;
  }
  return fallback;
}

function requireKey(ctx: InvocationContext, op: string): string {
  // The retry key comes EXCLUSIVELY from CapabilityContext. The durable
  // orchestration driver derives it only when the graph node declares a
  // retry policy; the sequential engine never supplies one. Without a key a
  // write can never be safely replayed — refuse instead of running unkeyed.
  if (typeof ctx.idempotencyKey !== 'string' || !ctx.idempotencyKey) {
    throw new Error(
      `${op}: no CapabilityContext.idempotencyKey — declare a retry policy on the graph node ` +
      '(the runtime derives the key only for nodes with a retry policy; unkeyed writes are never replayed)');
  }
  return ctx.idempotencyKey;
}

export interface PackBindings {
  readonly capabilities: readonly {
    readonly id: string;
    readonly revision: string;
    /** Executable input contract (registered with the capability). */
    readonly input?: unknown;
    /** Executable output contract (registered with the capability). */
    readonly output?: unknown;
    readonly invoke: Invoke;
  }[];
  readonly doubles: readonly {
    readonly capabilityId: string;
    readonly revision: string;
    readonly invoke: Invoke;
  }[];
}

export function createCogneeBindings(sup: CogneeWorkerSupervision): PackBindings {
  const add: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.add');
    const input = rawInput as AddInput;
    const key = requireKey(ctx, 'cognee.add');
    return await sup.request('add',
      { datasetName: input.datasetName, content: input.content },
      { mutating: true, deadlineMs: deadlineFrom(ctx, 'cognee.add', DEFAULT_MUTATING_DEADLINE_MS),
        ctx: { idempotencyKey: key, ...(ctx.attemptNumber !== undefined
          ? { attemptNumber: ctx.attemptNumber } : {}) } }) as Promise<MutatingReceipt>;
  };

  const cognify: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.cognify');
    const input = rawInput as DatasetRef;
    const key = requireKey(ctx, 'cognee.cognify');
    return await sup.request('cognify', { datasetName: input.datasetName },
      { mutating: true, deadlineMs: deadlineFrom(ctx, 'cognee.cognify', DEFAULT_MUTATING_DEADLINE_MS),
        ctx: { idempotencyKey: key, ...(ctx.attemptNumber !== undefined
          ? { attemptNumber: ctx.attemptNumber } : {}) } }) as Promise<MutatingReceipt>;
  };

  const searchChunks: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.searchChunks');
    const input = rawInput as SearchInput;
    return await sup.request('search_chunks',
      { datasets: [...input.datasets], query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}) },
      { mutating: false, deadlineMs: deadlineFrom(ctx, 'cognee.searchChunks', DEFAULT_READ_DEADLINE_MS) }) as Promise<SearchOutput>;
  };

  const searchSummaries: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.searchSummaries');
    const input = rawInput as SearchInput;
    return await sup.request('search_summaries',
      { datasets: [...input.datasets], query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}) },
      { mutating: false, deadlineMs: deadlineFrom(ctx, 'cognee.searchSummaries', DEFAULT_READ_DEADLINE_MS) }) as Promise<SearchOutput>;
  };

  const datasetsStatus: Invoke = async (_input: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.datasetsStatus');
    return await sup.request('datasets_status', {},
      { mutating: false, deadlineMs: deadlineFrom(ctx, 'cognee.datasetsStatus', DEFAULT_READ_DEADLINE_MS) }) as Promise<StatusOutput>;
  };

  const forgetDataset: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    requireNormalMode(ctx, 'cognee.forgetDataset');
    const input = rawInput as DatasetRef;
    // Irreversible: NEVER journaled, NEVER auto-retried (§7.2/§7.5). VICT
    // denies irreversible capabilities in normal mode unless the run policy
    // sets allowIrreversible — the real handler is unreachable otherwise.
    return await sup.request('forget_dataset', { datasetName: input.datasetName },
      { mutating: true, deadlineMs: deadlineFrom(ctx, 'cognee.forgetDataset', DEFAULT_MUTATING_DEADLINE_MS) }) as Promise<ForgetReceipt>;
  };

  // ---- test/simulate doubles (mutating capabilities only; reads fail closed)
  // Contract-valid outputs, deterministic, ZERO cognee/store touch. The add
  // double models a successful fresh write of exactly one data item.

  const addDouble: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as AddInput;
    return {
      datasetName: input.datasetName,
      idempotencyKey: typeof ctx.idempotencyKey === 'string'
        ? ctx.idempotencyKey : 'double-no-key',
      reconciled: 'fresh-execution',
      itemsBefore: 0,
      itemsAfter: 1,
      deduplicated: false,
    };
  };

  const cognifyDouble: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as DatasetRef;
    return {
      datasetName: input.datasetName,
      idempotencyKey: typeof ctx.idempotencyKey === 'string'
        ? ctx.idempotencyKey : 'double-no-key',
      reconciled: 'fresh-execution',
      itemsBefore: 1,
      itemsAfter: 1,
      deduplicated: true,
    };
  };

  const forgetDouble: Invoke = async (rawInput: unknown) => {
    const input = rawInput as DatasetRef;
    return {
      datasetName: input.datasetName,
      datasetId: 'double-dataset-id',
      purged: 'not-observed',
      storeFilesBefore: 0,
      storeFilesAfter: 0,
    };
  };

  return {
    capabilities: [
      { id: 'cognee.add', revision: '1', invoke: add,
        input: AddInputContract, output: MutatingReceiptContract },
      { id: 'cognee.cognify', revision: '1', invoke: cognify,
        input: DatasetRefContract, output: MutatingReceiptContract },
      { id: 'cognee.searchChunks', revision: '1', invoke: searchChunks,
        input: SearchInputContract, output: SearchOutputContract },
      { id: 'cognee.searchSummaries', revision: '1', invoke: searchSummaries,
        input: SearchInputContract, output: SearchOutputContract },
      { id: 'cognee.datasetsStatus', revision: '1', invoke: datasetsStatus,
        input: StatusInputContract, output: StatusOutputContract },
      { id: 'cognee.forgetDataset', revision: '1', invoke: forgetDataset,
        input: DatasetRefContract, output: ForgetReceiptContract },
    ],
    doubles: [
      { capabilityId: 'cognee.add', revision: '1', invoke: addDouble },
      { capabilityId: 'cognee.cognify', revision: '1', invoke: cognifyDouble },
      { capabilityId: 'cognee.forgetDataset', revision: '1', invoke: forgetDouble },
    ],
  };
}
