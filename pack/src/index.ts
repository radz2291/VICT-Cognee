/**
 * Proposed @victframework/cognee pack — capability factory (v0.1.0).
 *
 * NOT PUBLISHED. Proof artifact for radz2291/VICT-Cognee C4; the manifest is
 * a design deliverable validated against VICT ABI @ vict-02 5ea0afe2
 * (read-only reference). No adoption claims.
 *
 * createCogneePack() assembles { manifest, bindings } for ONE VICT runtime /
 * trust domain: one supervision instance => one live cognee worker per store
 * (contract §3/§7.2). Installing the SAME pack object into a second runtime
 * sharing a store is forbidden by contract §8 — the binding host must create
 * a fresh pack per runtime with its own store root.
 *
 * C4 exit corrections:
 *  - the worker is the PACK-BUNDLED src/worker/cognee_worker.py (resolved
 *    against this module by default — no disposable proof path) and ships
 *    its guard asset alongside; it contains NO fault injection (crash
 *    injection lives only in the proof harness worker/worker_proof.py);
 *  - the supervision claims EXCLUSIVE store ownership at construction and
 *    fails closed (COGNEE_STORE_OWNED) if another live pack instance or
 *    process already owns the store root (§3/§8).
 */

import { PACK_MANIFEST } from './manifest.js';
import { createCogneeBindings, type PackBindings } from './bindings.js';
import { CogneeWorkerSupervision, type SupervisionOptions } from './supervision.js';

export interface CogneePackOptions extends SupervisionOptions {
  /** Fail fast if the store root is not an absolute path (§8 pack-owned root). */
  validateStoreRoot?: boolean;
}

export interface CogneePack {
  readonly manifest: typeof PACK_MANIFEST;
  readonly bindings: PackBindings;
  /** Supervision handle: lifecycle stats + graceful shutdown for the host. */
  readonly supervision: CogneeWorkerSupervision;
}

export function createCogneePack(opts: CogneePackOptions): CogneePack {
  if (opts.validateStoreRoot !== false) {
    if (!opts.storeRoot || !/^([A-Za-z]:[\\/]|\/)/.test(opts.storeRoot)) {
      throw new Error('cognee.systemRoot must be an absolute pack-owned store path (§8)');
    }
    if (!opts.namespaces || opts.namespaces.length === 0) {
      throw new Error('cognee.allowedNamespaces must grant at least one namespace (§4)');
    }
  }
  const supervision = new CogneeWorkerSupervision(opts);
  const bindings = createCogneeBindings(supervision);
  return { manifest: PACK_MANIFEST, bindings, supervision };
}

export { PACK_MANIFEST };
export { CogneeWorkerSupervision, WorkerError } from './supervision.js';
export { BindingRefusedError } from './bindings.js';
export * from './contracts.js';
