# C7 — private release readiness and repository closeout

Date: 2026-09-26. Package repository: `radz2291/VICT-Cognee`.
Base: C6 pilot `c6/consumer-pilot` @
`e50684007d6624c3a8731ea9f0b80b776d19d5c6`, itself one commit
above the reviewed C5 candidate `c5/package-readiness` @
`35095331b23098f3c0287e43235b831cbf1c85e8`. The independent C5
closure review is `audit/c5-closure-review` @
`7efedde497970e1e39ad74b2a16ad6a2e43c0800`.

## Decision

**GO for a bounded, private, single-app integration trial (future C8).**
The installed artifact, VICT runtime boundary, candidate retrieval, deletion
policy and restart behavior have been exercised in C5/C6. The owner tried the
C6 browser pilot and judged it sufficient for that pilot. This is **not**
acceptance of retrieval quality, latency or resource use in a real product.

**HOLD** public npm publication, unattended production deployment and any
claim of adoption by Quellight or Trading OS. This C7 closeout performs no
C8 integration. The package remains `private: true`; `0.1.0` is the
candidate's local package version, not a published release.

## What ships and what stays in the repository

- `pack/` builds an installable tarball whose allowlist is `dist/` and
  `README.md`. The Node binding, contracts and bundled Python worker/guard
  are the pack. The package needs a separate Python 3.12 environment with
  `cognee[gliner]==1.6.1` and the pinned local models.
- `examples/c6-browser-pilot/` is a disposable **consumer example**, not
  part of that tarball. It runs from a clean workspace after installing
  ordinary tarballs of the pack and VICT 0.3.1.
- `proof/`, `worker/`, `ts-sdk/` and older `docs/` reports preserve
  discovery, protocol, audit and equivalence evidence. They are not
  runtime installation requirements. The root README is the current map.
- The six pack capabilities remain `add`, `cognify`, `searchChunks`,
  `searchSummaries`, `datasetsStatus`, `forgetDataset`. Do not expand
  this boundary merely to serve one future application.

## Operator handoff for a private consumer

1. In a fresh checkout, run `npm install && npm pack` inside `pack/`.
   Keep `private: true`. Verify the tarball contains `dist/index.js`,
   declarations, `dist/worker/cognee_worker.py`, and its guard. Do not
   use `npm pack --ignore-scripts` on an unbuilt tree.
2. Install the tarball with the tested VICT 0.3.1 set as ordinary package
   dependencies. The C5 clean-install smoke and C6 pilot exercised this
   path. `victCompatibility: ^0.1.0` is the pack ABI, while npm peers
   `^0.3.1` name the tested VICT package line.
3. Provision the Python 3.12 venv and models before serving requests.
   Put all seven Cognee storage roots under an **absolute**, pack-owned
   persistent `storeRoot` with its store `.env`. The root guard refuses
   out-of-bound paths. Budget memory for model loading and cognify; C6
   observed a second worker fail to load GLiNER with less than ~1 GB free.
   Two trust domains require separate runtime/worker/store/lock instances
   and adequate capacity for both.
4. Stop gracefully so the pack releases its attributable ownership lock.
   After an unclean stop it intentionally refuses to auto-recover an old
   lock. Use the verified operator procedure in
   [contract §8.1](c3-pack-contract.md): stop the owner, verify the pid
   and store-serving worker are gone, then remove the lock and restart.
   A stale heartbeat alone does not authorize deletion.
5. Keep authority grants server-side. A namespace is a store safety rail,
   not actor authorization; a multi-user app must provide its own trusted
   user boundary. `forgetDataset` stays denied unless the app explicitly
   enables irreversible effects for its intended store. File-level purge
   was demonstrated; backups, OS-level recovery and concurrent readers
   are outside that proof.
6. Display search hits as candidates with raw scores. Both semantic and
   lexical paths can return irrelevant top-k hits, and C6 off-corpus
   queries did. Do not turn any score into a global truth threshold or
   an answer without application-level evaluation.

## C6 observations that a real app must resolve

| Observation | Current C7 treatment | Real-app decision |
| --- | --- | --- |
| Cognify retry timer can leave a VICT 0.3.1 run `running` without automatic resume | Surface incomplete status; no automatic fresh run or success claim | Choose a supported resume/recovery policy with the VICT runtime, then test a forced failure and restart |
| Second worker's GLiNER load failed under low free RAM on the pilot host | Provision adequate RAM; avoid overlapping model-heavy work on a constrained host | Measure intended deployment with actual concurrent domains and workload |
| Off-corpus search still returned candidates | Preserve raw candidates and dataset scope | Decide how the app judges relevance and communicates uncertainty |
| Namespace isolation does not identify an end user | One runtime/store per trust domain; no actor-isolation claim | Add real app authorization before exposing multi-user data |

The C6 isolation checks established separate status/search surfaces across
two stores. They did **not** prove successful concurrent model loading or
cognify in both domains on the low-memory pilot host. The retry observation
is an app-visible VICT runtime behavior; changing the pack alone would not
supply a scheduler. Record any upstream runtime fix separately.

## Closeout checks and scope

C5 independent closure verified the fresh source build, normal npm install,
19-file tarball, 7/7 clean-install smoke, 9/9 installed-artifact probe and
17/17 ownership suite. C6 checked 17/17 focused consumer assertions and
the owner used the browser pilot. This C7 cleanup updates documentation and package description metadata,
and makes the pilot's setup paths explicit; it does not alter the pack's
capabilities or worker. Source-level checks for the pilot scripts and the
exact final repository ref should accompany consolidation.

The next stage, C8, is one real-app vertical slice, chosen later. Its
acceptance is based on actual data, user flow and host resources. No
Quellight, Trading OS or VICT source changes are part of C7.
