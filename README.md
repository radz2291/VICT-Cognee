# VICT-Cognee — C0/C1 discovery workspace

Disposable workspace for the **C0 capability inventory** and **C1 pinned-release
proof** of a proposed standalone `@victframework/cognee` capability pack.

Status: **discovery only — no pack design, no pack implementation.** Stop for review.

## Layout

| Path | Purpose |
| --- | --- |
| `upstream/cognee/` | Read-only clone of https://github.com/topoteretes/cognee (pinned tag; never edited; gitignored) |
| `proof/` | Pinned-release proof scripts, committed synthetic fixtures (`proof/data/`), observed-run records |
| `ts-sdk/` | `@cognee/cognee-ts` checkout used for the TypeScript SDK comparison (runtime state gitignored) |
| `docs/` | Deliverables: capability map, proof report, integration-route recommendation |

## Running the proof from a fresh clone (tested on Windows 11, Git for Windows/MINGW64, Python 3.12)

```bash
git clone https://github.com/radz2291/VICT-Cognee.git
cd VICT-Cognee/proof
bash run_proof.sh              # creates .venv, installs cognee[gliner]==1.6.1, runs all batteries
```

`run_proof.sh` generates `proof/.env` from the committed, credential-free
`proof/.env.example` (absolute paths substituted automatically), runs every battery
**sequentially**, and leaves JSON records in `proof/results/`. No LLM API key is
required (keyless local route: fastembed + GLiNER). First run downloads ~817 MB of
models into user caches outside the repo. Reuse an existing venv with
`bash run_proof.sh --skip-install`.

## Provenance

- VICT reference truth read: `docs/VICT-SYSTEM-REFERENCE.md` v0.4.32
  (SHA-256 `dc43c1672c3f75da886325f236945a40fe0b6c79a373b8da6a0763612c4baa42`)
  from radz2291/vict-02 @ `a746c34173838eb583d85a909207b6a0a7c7c832` (read-only).
- Consumer examples inspected read-only: Quellight @ `5f709a536ab1f4d5fea0407db1b9537e0aa7c0f6`,
  Trading OS @ `38f654e2ceffa0455fd5e7c2f1b4da24d73aea25`. These inspections are
  observations of how the products integrate @victframework today; **they are not pack
  adoption commitments** by either product.
- Cognee upstream pinned: tag `v1.6.1` @ `eb90d03740755f5252b8b12cce91fd09970f2d81`.

## Constraints honored

- VICT, Quellight, and Trading OS repositories are read-only here.
- Stage 8 (ecosystem gate) and Stage 9 are separate tracks; this is not that work.
- No final pack API design and no pack implementation in this task.
