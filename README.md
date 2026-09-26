# VICT-Cognee

Private, unpublished VICT capability pack for keyless local Cognee memory. The
package is `@victframework/cognee` in `pack/`; the separate Python worker is
bundled into its installable tarball. Cognee itself remains an upstream dependency.

**Current stage: C7 private release readiness.** The C5 package candidate was
independently reviewed, and the C6 browser pilot was exercised by the owner.
This is a candidate for a bounded, private real-app trial; no registry package,
production deployment, or Quellight/Trading OS adoption is claimed.

## Start here

| Path | Purpose |
| --- | --- |
| [`pack/`](pack/README.md) | Six-capability pack, build, private tarball, provisioning |
| [`examples/c6-browser-pilot/`](examples/c6-browser-pilot/README.md) | Disposable installed-consumer browser example and checks |
| [`docs/c7-private-readiness.md`](docs/c7-private-readiness.md) | C7 decision, deployment steps, known limits, handoff to a future app |
| [`docs/c3-pack-contract.md`](docs/c3-pack-contract.md) | Normative scope, effect, retry, storage and worker contract |
| [`docs/c5-readiness-report.md`](docs/c5-readiness-report.md) | Packaging and runtime evidence |
| [`proof/`](proof/) and [`worker/`](worker/) | Historical pinned proof, fault and equivalence batteries |
| [`ts-sdk/`](ts-sdk/) | Historical upstream TypeScript SDK comparison, not this pack |

The six supported capabilities are `add`, `cognify`, `searchChunks`,
`searchSummaries`, `datasetsStatus`, and `forgetDataset`. Retrieval produces
**candidates**, not answers or a universal relevance threshold. One VICT runtime,
one worker and one physical Cognee store form one trust domain; namespace grants
are a store safety rail, not end-user authorization. Deletion is irreversible
and denied by default.

## Private artifact and demo

From a fresh checkout with Node 22 or newer:

```bash
cd pack
npm install
npm pack
```

The resulting `victframework-cognee-0.1.0.tgz` can be installed locally with
VICT 0.3.1 packages. Python 3.12 with `cognee[gliner]==1.6.1`, downloaded
models and an absolute, pack-owned store root are separate runtime requirements.
Use the [pack guide](pack/README.md) for provisioning and the
[browser pilot](examples/c6-browser-pilot/README.md) for an interactive trial.
The package is marked `private: true` and is not on npm.

## Development record

C0–C2 established the upstream capability and behavior evidence; C3 specified
the contract; C4 implemented the pack; C5 closed the independent audit and
built an installable artifact; C6 exercised that artifact in a browser
consumer. Earlier reports in `docs/` are dated evidence, not the current
setup guide. C7 records the private readiness decision and operating limits.
The first real-app integration (C8) is intentionally separate.

VICT, Quellight and Trading OS were read-only references throughout this pack
work. See the dated reports for the exact repository and upstream pins.
