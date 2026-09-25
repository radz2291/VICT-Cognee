/**
 * Bindings for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Executable handlers + test/simulate doubles, supplied separately from the
 * serializable manifest (handlers are never serialized). All cognee work goes
 * through ONE CogneeWorkerSupervision per pack instance = one live worker per
 * store per trust domain (contract §3/§7.2).
 *
 * Invocation rules implemented here:
 *  - the retry key comes EXCLUSIVELY from CapabilityContext.idempotencyKey —
 *    never from input params (worker re-checks and rejects smuggled keys);
 *  - a mutating invocation with NO context key is REFUSED (it can never be
 *    safely replayed): this happens when a graph invokes a write through the
 *    sequential engine or without a node retry policy (contract §1/§7.3);
 *  - attempt deadlines map from CapabilityContext.deadlineAt when present;
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

function deadlineFrom(ctx: InvocationContext, fallback: number): number {
  if (typeof ctx.deadlineAt === 'number' && Number.isFinite(ctx.deadlineAt)) {
    const remaining = ctx.deadlineAt - Date.now();
    if (remaining > 250) return remaining;
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
    const input = rawInput as AddInput;
    const key = requireKey(ctx, 'cognee.add');
    return await sup.request('add',
      { datasetName: input.datasetName, content: input.content },
      { mutating: true, deadlineMs: deadlineFrom(ctx, DEFAULT_MUTATING_DEADLINE_MS),
        ctx: { idempotencyKey: key, ...(ctx.attemptNumber !== undefined
          ? { attemptNumber: ctx.attemptNumber } : {}) } }) as Promise<MutatingReceipt>;
  };

  const cognify: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as DatasetRef;
    const key = requireKey(ctx, 'cognee.cognify');
    return await sup.request('cognify', { datasetName: input.datasetName },
      { mutating: true, deadlineMs: deadlineFrom(ctx, DEFAULT_MUTATING_DEADLINE_MS),
        ctx: { idempotencyKey: key, ...(ctx.attemptNumber !== undefined
          ? { attemptNumber: ctx.attemptNumber } : {}) } }) as Promise<MutatingReceipt>;
  };

  const searchChunks: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as SearchInput;
    return await sup.request('search_chunks',
      { datasets: [...input.datasets], query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}) },
      { mutating: false, deadlineMs: deadlineFrom(ctx, DEFAULT_READ_DEADLINE_MS) }) as Promise<SearchOutput>;
  };

  const searchSummaries: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as SearchInput;
    return await sup.request('search_summaries',
      { datasets: [...input.datasets], query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}) },
      { mutating: false, deadlineMs: deadlineFrom(ctx, DEFAULT_READ_DEADLINE_MS) }) as Promise<SearchOutput>;
  };

  const datasetsStatus: Invoke = async (_input: unknown, ctx: InvocationContext) => {
    return await sup.request('datasets_status', {},
      { mutating: false, deadlineMs: deadlineFrom(ctx, DEFAULT_READ_DEADLINE_MS) }) as Promise<StatusOutput>;
  };

  const forgetDataset: Invoke = async (rawInput: unknown, ctx: InvocationContext) => {
    const input = rawInput as DatasetRef;
    // Irreversible: NEVER journaled, NEVER auto-retried (§7.2/§7.5). VICT
    // denies irreversible capabilities in normal mode unless the run policy
    // sets allowIrreversible — the real handler is unreachable otherwise.
    return await sup.request('forget_dataset', { datasetName: input.datasetName },
      { mutating: true, deadlineMs: deadlineFrom(ctx, DEFAULT_MUTATING_DEADLINE_MS) }) as Promise<ForgetReceipt>;
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

export { WorkerError };
