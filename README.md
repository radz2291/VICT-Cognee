# VICT-Cognee — C0/C1 discovery workspace

Disposable workspace for the **C0 capability inventory** and **C1 pinned-release
proof** of a proposed standalone `@vict/cognee` capability pack.

Status: **discovery only — no pack design, no pack implementation.** Stop for review.

## Layout

| Path | Purpose |
| --- | --- |
| `upstream/cognee/` | Read-only clone of https://github.com/topoteretes/cognee (pinned tag; never edited) |
| `proof/` | Pinned-release proof scripts, synthetic data, and observed-run records (Python venv in `proof/.venv`, gitignored) |
| `ts-sdk/` | `@cognee/cognee-ts` checkout used for TypeScript SDK comparison |
| `docs/` | Deliverables: capability map, proof report, integration-route recommendation |

## Provenance

- VICT reference truth read: `docs/VICT-SYSTEM-REFERENCE.md` v0.4.32
  (SHA-256 `dc43c1672c3f75da886325f236945a40fe0b6c79a373b8da6a0763612c4baa42`)
  from radz2291/vict-02 @ `a746c34173838eb583d85a909207b6a0a7c7c832` (read-only).
- Consumer examples inspected read-only: Quellight @ `5f709a536ab1f4d5fea0407db1b9537e0aa7c0f6`,
  Trading OS @ `38f654e2ceffa0455fd5e7c2f1b4da24d73aea25`.
- Cognee upstream pinned: tag `v1.6.1` @ `eb90d03740755f5252b8b12cce91fd09970f2d81`.

## Constraints honored

- VICT, Quellight, and Trading OS repositories are read-only here.
- Stage 9 is not open; this is not Stage 9 work.
- No final pack API design and no pack implementation in this task.
