/**
 * Serializable manifest for the proposed @victframework/cognee pack (v0.1.0).
 *
 * Schema vict.capability-pack@1, validated by @victframework/sdk
 * validateCapabilityPack (closed fields; see pack.ts CAPABILITY_DECL_FIELDS).
 * Manifest carries declarations and references ONLY — never handlers.
 *
 * Effect/permission/ambiguity matrix (docs/c3-pack-contract.md §5):
 *   cognee.add            write,  keyed, keyedRetry, cognee.write
 *   cognee.cognify        write,  keyed, keyedRetry, cognee.write
 *   cognee.searchChunks   read,                          cognee.search
 *   cognee.searchSummaries read,                         cognee.search
 *   cognee.datasetsStatus read,                          cognee.search
 *   cognee.forgetDataset  irreversible,                  cognee.delete
 *
 * Secrets: none (keyless first release). Configuration is required but is
 * consumed by the SUPERVISION layer of the binding host, not declared as
 * capability-level configuration reads — capabilities take no configuration
 * names because the worker/store ownership is pack-host-wide (§3/§8).
 */

export const PACK_MANIFEST = Object.freeze({
  schema: 'vict.capability-pack@1',
  id: 'vict.cognee.memory',
  version: '0.1.0',
  victCompatibility: '^0.1.0',
  capabilities: [
    {
      id: 'cognee.add',
      revision: '1',
      effect: 'write',
      idempotency: 'keyed',
      ambiguity: 'keyedRetry',
      permissions: ['cognee.write'],
      input: { contractId: 'cognee.add-input', revision: '1' },
      output: { contractId: 'cognee.mutating-receipt', revision: '1' },
    },
    {
      id: 'cognee.cognify',
      revision: '1',
      effect: 'write',
      idempotency: 'keyed',
      ambiguity: 'keyedRetry',
      permissions: ['cognee.write'],
      input: { contractId: 'cognee.dataset-ref', revision: '1' },
      output: { contractId: 'cognee.mutating-receipt', revision: '1' },
    },
    {
      id: 'cognee.searchChunks',
      revision: '1',
      effect: 'read',
      permissions: ['cognee.search'],
      input: { contractId: 'cognee.search-input', revision: '1' },
      output: { contractId: 'cognee.search-output', revision: '1' },
    },
    {
      id: 'cognee.searchSummaries',
      revision: '1',
      effect: 'read',
      permissions: ['cognee.search'],
      input: { contractId: 'cognee.search-input', revision: '1' },
      output: { contractId: 'cognee.search-output', revision: '1' },
    },
    {
      id: 'cognee.datasetsStatus',
      revision: '1',
      effect: 'read',
      permissions: ['cognee.search'],
      input: { contractId: 'cognee.status-input', revision: '1' },
      output: { contractId: 'cognee.status-output', revision: '1' },
    },
    {
      id: 'cognee.forgetDataset',
      revision: '1',
      effect: 'irreversible',
      permissions: ['cognee.delete'],
      input: { contractId: 'cognee.dataset-ref', revision: '1' },
      output: { contractId: 'cognee.forget-receipt', revision: '1' },
    },
  ],
  contracts: [
    { id: 'cognee.add-input', revision: '1' },
    { id: 'cognee.mutating-receipt', revision: '1' },
    { id: 'cognee.dataset-ref', revision: '1' },
    { id: 'cognee.search-input', revision: '1' },
    { id: 'cognee.search-output', revision: '1' },
    { id: 'cognee.status-input', revision: '1' },
    { id: 'cognee.status-output', revision: '1' },
    { id: 'cognee.forget-receipt', revision: '1' },
  ],
  permissions: [
    { id: 'cognee.write', description: 'Write datasets in the granted namespaces (keyed writes only; replay per contract §7.3).' },
    { id: 'cognee.search', description: 'Read scoped search candidates and the namespace-filtered dataset status.' },
    { id: 'cognee.delete', description: 'Irreversible dataset-level forget (denied by default; requires runtime allowIrreversible).' },
  ],
  configuration: [
    { name: 'cognee.systemRoot', required: true, sensitive: false,
      description: 'Absolute path of the pack-owned Cognee system root for THIS runtime/trust domain (§3/§8; never shared).' },
    { name: 'cognee.allowedNamespaces', required: true, sensitive: false,
      description: 'Comma-separated dataset namespace prefixes granted to this runtime (store-safety rail, not per-actor authorization).' },
  ],
  secrets: [],
  doubles: [
    { capabilityId: 'cognee.add', revision: '1', modes: ['test', 'simulate'] },
    { capabilityId: 'cognee.cognify', revision: '1', modes: ['test', 'simulate'] },
    { capabilityId: 'cognee.forgetDataset', revision: '1', modes: ['test', 'simulate'] },
  ],
  evaluations: [
    { id: 'eval.cognee.add.convergent', capabilityId: 'cognee.add',
      description: 'Re-issuing an add with the same key never grows the dataset beyond one item per logical document (C4 c5).' },
    { id: 'eval.cognee.cognify.searchable', capabilityId: 'cognee.cognify',
      description: 'After cognify (including interrupted-then-reissued), the dataset is searchable in-scope (C4 c6).' },
    { id: 'eval.cognee.search.scoped', capabilityId: 'cognee.searchChunks',
      description: 'Searches resolve only granted-namespace datasets and return declared hit fields (C3 s2/s3).' },
    { id: 'eval.cognee.status.hides-foreign', capabilityId: 'cognee.datasetsStatus',
      description: 'datasetsStatus never names datasets outside the granted namespaces, including pre-existing ones (C3/C4 c7).' },
    { id: 'eval.cognee.forget.purges', capabilityId: 'cognee.forgetDataset',
      description: 'forget purges the dataset file-level and post-delete searches fail typed (C3/C4 c9).' },
  ],
  documentation: {
    summary: 'Keyless Cognee memory pack (six capabilities) for one VICT runtime per trust domain; keyed durable writes with a scope safety rail.',
  },
  provenance: {
    author: 'radz2291/VICT-Cognee (C4, unpublished)',
    license: 'UNLICENSED — proof artifact, do not distribute',
    source: 'https://github.com/radz2291/VICT-Cognee',
  },
});
