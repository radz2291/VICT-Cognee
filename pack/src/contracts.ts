/**
 * Executable contracts for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Contract shapes mirror docs/c3-pack-contract.md §6 — verified against the
 * worker's actual output in the C3/C4 batteries. Parses are fail-closed
 * parse promises: { ok: true, value } | { ok: false, issues[] }.
 *
 * Output contracts accept BOTH the exact worker receipt fields and (for
 * doubles) the same shapes produced by the registered test/simulate doubles —
 * a double's output must satisfy the original capability's contracts
 * (VICT effect policy), so these parses are shared.
 */

export interface ContractIssue {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

type ParseFn<T> = (input: unknown) => ParseResult<T>;

function obj(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function bool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

export interface Contract<T = unknown> {
  readonly id: string;
  readonly revision: string;
  readonly expected?: string;
  readonly parse: ParseFn<T>;
}

function makeContract<T>(id: string, expected: string, parse: ParseFn<T>): Contract<T> {
  return Object.freeze({ id, revision: '1', expected, parse });
}

const bad = (path: string, message: string): ParseResult<never> => ({
  ok: false,
  issues: [{ code: 'invalid_type', path, message }],
});

// ---- add --------------------------------------------------------------------

export interface AddInput {
  readonly datasetName: string;
  readonly content: string;
}

export const AddInputContract = makeContract<AddInput>(
  'cognee.add-input',
  '{ datasetName: string, content: string }',
  (input) => {
    if (!obj(input) || !str(input.datasetName) || !str(input.content) || !input.content) {
      return bad('(root)', 'add input requires datasetName: string and non-empty content: string');
    }
    return { ok: true, value: { datasetName: input.datasetName, content: input.content } };
  },
);

// ---- mutating receipt (add / cognify) ----------------------------------------

export interface MutatingReceipt {
  readonly datasetName: string;
  readonly idempotencyKey: string;
  readonly reconciled: string;
  readonly itemsBefore: number;
  readonly itemsAfter: number;
  readonly deduplicated: boolean;
}

function parseReceipt(input: unknown): ParseResult<MutatingReceipt> {
  if (!obj(input) || !str(input.datasetName) || !str(input.idempotencyKey) ||
      !str(input.reconciled) || !num(input.itemsBefore) || !num(input.itemsAfter) ||
      !bool(input.deduplicated)) {
    return bad('(root)',
      'mutating receipt requires { datasetName, idempotencyKey, reconciled, itemsBefore, itemsAfter, deduplicated }');
  }
  return {
    ok: true,
    value: {
      datasetName: input.datasetName,
      idempotencyKey: input.idempotencyKey,
      reconciled: input.reconciled,
      itemsBefore: input.itemsBefore,
      itemsAfter: input.itemsAfter,
      deduplicated: input.deduplicated,
    },
  };
}

export const MutatingReceiptContract = makeContract<MutatingReceipt>(
  'cognee.mutating-receipt',
  '{ datasetName: string, idempotencyKey: string, reconciled: string, itemsBefore: number, itemsAfter: number, deduplicated: boolean }',
  parseReceipt,
);

// ---- cognify ----------------------------------------------------------------

export interface DatasetRef {
  readonly datasetName: string;
}

function parseDatasetRef(input: unknown): ParseResult<DatasetRef> {
  // Accepts a bare dataset ref OR a prior mutating receipt (graph composition:
  // cognify consumes the add receipt's datasetName).
  if (obj(input) && str(input.datasetName)) {
    return { ok: true, value: { datasetName: input.datasetName } };
  }
  return bad('(root)', 'cognify input requires datasetName: string (directly or via an add receipt)');
}

export const DatasetRefContract = makeContract<DatasetRef>(
  'cognee.dataset-ref',
  '{ datasetName: string }',
  parseDatasetRef,
);

// ---- search -----------------------------------------------------------------

export interface SearchInput {
  readonly datasets: readonly string[];
  readonly query: string;
  readonly topK?: number;
}

export const SearchInputContract = makeContract<SearchInput>(
  'cognee.search-input',
  '{ datasets: string[1..8], query: string, topK?: number }',
  (input) => {
    if (!obj(input) || !Array.isArray(input.datasets) || input.datasets.length < 1 ||
        input.datasets.length > 8 || !input.datasets.every(str) ||
        !str(input.query) || !input.query ||
        (input.topK !== undefined && !num(input.topK))) {
      return bad('(root)', 'search input requires datasets: string[1..8], query: string, optional topK: number');
    }
    return {
      ok: true,
      value: { datasets: [...input.datasets], query: input.query,
        ...(input.topK !== undefined ? { topK: input.topK } : {}) },
    };
  },
);

export interface SearchHit {
  readonly text: string;
  readonly score?: number;
  readonly datasetName?: string;
}

export interface SearchOutput {
  readonly hits: readonly SearchHit[];
  readonly datasets: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
}

export const SearchOutputContract = makeContract<SearchOutput>(
  'cognee.search-output',
  '{ hits: [{ text, score?, datasetName? }], datasets: string[], total: number, truncated: boolean }',
  (input) => {
    if (!obj(input) || !Array.isArray(input.hits) || !Array.isArray(input.datasets) ||
        !num(input.total) || !bool(input.truncated)) {
      return bad('(root)', 'search output requires { hits[], datasets[], total, truncated }');
    }
    const hits: SearchHit[] = [];
    for (const h of input.hits) {
      if (!obj(h) || !str(h.text)) return bad('hits', 'each hit requires text: string');
      hits.push({
        text: h.text,
        ...(num(h.score) ? { score: h.score } : {}),
        ...(str(h.datasetName) ? { datasetName: h.datasetName } : {}),
      });
    }
    return {
      ok: true,
      value: { hits, datasets: input.datasets.filter(str), total: input.total,
        truncated: input.truncated },
    };
  },
);

// ---- datasetsStatus ----------------------------------------------------------

export interface StatusInput {
  readonly storeScoped: true;
}

/** datasetsStatus takes NO parameters (store-scoped, §3/§4): input is
 *  intentionally empty; non-object payloads are rejected (CONT-001 requires
 *  the contract to exist, not to carry fields). */
export const StatusInputContract = makeContract<StatusInput>(
  'cognee.status-input',
  '{} (store-scoped: no parameters; the dataset scope is the runtime grant)',
  (input) => {
    if (input === undefined || input === null ||
        (typeof input === 'object' && !Array.isArray(input))) {
      return { ok: true, value: { storeScoped: true } };
    }
    return bad('(root)', 'datasetsStatus takes no parameters (store-scoped capability)');
  },
);

export interface StatusOutput {
  readonly datasets: readonly { readonly name: string }[];
  readonly hiddenDatasets: number;
  readonly namespaces: readonly string[];
}

export const StatusOutputContract = makeContract<StatusOutput>(
  'cognee.status-output',
  '{ datasets: [{ name }], hiddenDatasets: number, namespaces: string[] }',
  (input) => {
    if (!obj(input) || !Array.isArray(input.datasets) || !num(input.hiddenDatasets) ||
        !Array.isArray(input.namespaces) || !input.namespaces.every(str)) {
      return bad('(root)', 'status output requires { datasets: [{name}], hiddenDatasets, namespaces }');
    }
    for (const d of input.datasets) {
      if (!obj(d) || !str(d.name)) return bad('datasets', 'each entry requires name: string');
    }
    return {
      ok: true,
      value: { datasets: input.datasets.map((d) => ({ name: (d as Record<string, unknown>).name as string })),
        hiddenDatasets: input.hiddenDatasets, namespaces: [...input.namespaces] },
    };
  },
);

// ---- forgetDataset receipt ----------------------------------------------------

export interface ForgetReceipt {
  readonly datasetName: string;
  readonly datasetId: string;
  readonly purged: string;
  readonly storeFilesBefore: number;
  readonly storeFilesAfter: number;
}

export const ForgetReceiptContract = makeContract<ForgetReceipt>(
  'cognee.forget-receipt',
  '{ datasetName, datasetId, purged, storeFilesBefore, storeFilesAfter }',
  (input) => {
    if (!obj(input) || !str(input.datasetName) || !str(input.datasetId) ||
        !str(input.purged) || !num(input.storeFilesBefore) || !num(input.storeFilesAfter)) {
      return bad('(root)',
        'forget receipt requires { datasetName, datasetId, purged, storeFilesBefore, storeFilesAfter }');
    }
    return {
      ok: true,
      value: { datasetName: input.datasetName, datasetId: input.datasetId,
        purged: input.purged, storeFilesBefore: input.storeFilesBefore,
        storeFilesAfter: input.storeFilesAfter },
    };
  },
);

export const ALL_CONTRACTS: readonly Contract<unknown>[] = [
  AddInputContract, MutatingReceiptContract, DatasetRefContract,
  SearchInputContract, SearchOutputContract, StatusInputContract,
  StatusOutputContract, ForgetReceiptContract,
];
