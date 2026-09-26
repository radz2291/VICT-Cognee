# @victframework/cognee — C5 package candidate (UNPUBLISHED)

Keyless Cognee memory capability pack for VICT: six capabilities (add,
cognify, searchChunks, searchSummaries, datasetsStatus, forgetDataset) with
keyed durable writes, a scope safety rail, exclusive store ownership, and a
fail-closed worker boundary. **Private proof artifact — `private: true`; npm
refuses to publish it. No consumer adoption is claimed.**

## Install (local tarball only — there is no registry)

```powershell
npm install ./victframework-cognee-0.1.0.tgz   # plus the VICT packages below
```

Supported VICT packages (same versions this candidate was smoke-tested
against): `@victframework/sdk@0.3.1`, `@victframework/runtime@0.3.1` and
their local dependencies (`@victframework/contracts`, `@victframework/kernel`)
— installed from their build directories via `file:` paths. The npm peer
ranges declared by this package (`^0.3.1`) describe exactly these tested npm
packages and nothing broader. They are conceptually SEPARATE from the
manifest's `victCompatibility: ^0.1.0`, which is the capability-pack ABI
contract version (manifest schema generation), not an npm package version.

## Runtime requirements (tested platform)

| Requirement | Value |
| --- | --- |
| Node (binding host) | **>= 22** (tested: v22.13.1, Windows 11 x64) |
| Python (worker) | **3.12.x** with `cognee==1.6.1` importable (tested in a dedicated venv) |
| OS | Windows 10/11 x64 (supported host; the ownership protocol is fail-closed and not reliant on POSIX rename semantics) |
| RAM | peak ~2.0 GB during cognify; earlier batteries saw native crashes when free RAM dropped near 1.9 GB — provision accordingly |
| Disk | store root with room for sqlite + lancedb + ladybug files (plan ≥ 1 GB per active dataset) |
| Network | one-time model downloads on a fresh host (see below); otherwise offline |

## Python / model provisioning

1. Create a Python 3.12 venv and install the pinned cognee:
   `py -3.12 -m venv venv && venv\Scripts\pip install cognee==1.6.1`
   (the pack passes `pythonPath` — the venv's `python.exe` — to
   `createCogneePack`; nothing else is imported from it).
2. The worker's **store `.env`** pins the local, keyless models:
   `EMBEDDING_PROVIDER=fastembed`, `EMBEDDING_MODEL=BAAI/bge-small-en-v1.5`,
   `EMBEDDING_DIMENSIONS=384`, `GRAPH_EXTRACTOR=gliner_demo`,
   `AUTO_FEEDBACK=false` — no LLM key in this release. On a fresh host the
   first worker start downloads the fastembed embedding model and the gliner
   ONNX model once (hundreds of MB); pre-warm by running one `add`, or
   provision the caches (`%USERPROFILE%\AppData\Local\fastembed`,
   `~/.cache/gliner*)`) from a warmed host.

## Store provisioning (one store per trust domain — contract §3)

Provision ONE absolute pack-owned directory per runtime with its own `.env`
(the worker resolves all seven destructive roots strictly inside it or
refuses to serve; §8). Roots must be disjoint — a store nested inside another
pack store is refused. See `docs/c3-pack-contract.md` §3/§8/§8.1 in the
source repository for the full rules and the stale-lock operator recovery
procedure.

```js
import { createCogneePack } from '@victframework/cognee';

const pack = createCogneePack({
  pythonPath: 'C:/path/to/venv/Scripts/python.exe',
  cwd: 'C:/pack-stores/runtime-a',          // store dir holding its own .env
  storeRoot: 'C:/pack-stores/runtime-a',    // absolute pack-owned boundary
  namespaces: ['teamA'],                    // granted dataset namespace(s)
  readyBudgetMs: 180_000,
});
// pack.manifest / pack.bindings / pack.supervision
```

The pack resolves its OWN bundled worker (`dist/worker/cognee_worker.py`)
and guard (`dist/worker/guard_store_roots.py`) from the installed package —
no repository paths, no TypeScript/tsx runtime, no test fault hooks.

A tarball consumer runs NOTHING from the package `scripts`: the installed
package is prebuilt (`dist/` ships in the tarball). The `scripts` entries in
`package.json` (`build` / `prepack` / `pack:check`) exist for building this
SOURCE repository; run inside `node_modules` they fail loudly (no `src/`, no
toolchain). `npm pack` runs the build first via `prepack` — or fails if the
toolchain is absent. With lifecycle scripts disabled (`npm pack
--ignore-scripts`) the completeness guarantee is void: whatever is on disk is
packed (an unbuilt tree packs a tarball WITHOUT `dist/`) — verify `dist/`
presence when scripts are disabled.

## Build from source (fresh clone — no sibling clone or C5_TSC needed)

```powershell
cd pack
npm install     # build-only devDependencies (typescript, @types/node); nothing at runtime
npm run build   # compiles dist/ + ships the Python worker/guard; tsc strict
```

`npm pack` then produces the installable tarball (the `prepack` lifecycle
script runs the same build first, so packing an unbuilt tree fails instead of
shipping an empty package). Optional development overrides — NEVER required:
`C5_TSC=<path to typescript/bin/tsc>` pins a different compiler;
`C5_VICT_HOME=<vict clone>` adds a fallback compiler source;
`C5_TYPES_ROOTS=<dir>` overrides type discovery.

Repository-only verification commands (NOT part of the package; they need the
source tree, the VICT clone and the proof venv):

```powershell
node ../260831-VCT-02/node_modules/tsx/dist/cli.mjs pack/verify/ownership-verify.ts
node ../260831-VCT-02/node_modules/tsx/dist/cli.mjs pack/verify/verify.ts
node worker/proof_c4.mjs
node worker/graph_equiv_c4.mjs
```

## Ownership limits (accurate as of the C5 closure pass)

- There is NO automatic stale-lock recovery. Recovery is the §8.1 operator
  procedure in `docs/c3-pack-contract.md`, and its safety depends on the
  operator actually verifying BOTH the old owner process (step 2) AND its
  worker (step 3) are stopped before deleting the lock.
- The ownership heartbeat is a liveness signal ONLY: the owner refreshes its
  OWN lock per operation and every `staleMs/3` (floor 1 s) while an operation
  is in flight. It never drives recovery, and a stale heartbeat is an
  indication, never a proof, of a dead owner.
- An instance releasing ownership (orderly shutdown) deletes the lock ONLY
  when a readable owner record matches the instance. A missing, corrupt, or
  foreign lock is left untouched for §8.1 recovery — releasing never deletes
  a lock it cannot attribute.
- A store root nested INSIDE another pack-owned store root that holds a lock
  is refused at construction; provisioning an OUTER store root over an active
  INNER root is deliberately NOT auto-detected and surfaces as typed
  ladybug/sqlite contention at op time (§3: roots must be disjoint).

## What is deliberately NOT in the shipped package

`pack/verify/` (protocol stub worker, verification suites), `worker/`
(C4 proof drivers, proof-only crash harness), and every test fault hook
(`C4_PROOF_FAULT`, `C5_FORCED_FAIL`, `STUB_*` env knobs) stay out of the
tarball — the shipped worker contains no fault injection.
