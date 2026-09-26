"""PROOF-ONLY crash-injection wrapper around the PACK-BUNDLED cognee worker.

This module is NOT part of the distributable worker surface. The pack-bundled
worker (pack/src/worker/cognee_worker.py) ships with NO fault injection (C4
exit correction). The C4 crash-window proofs still need the exact window
"after Cognee's write returns, BEFORE the durable journal commit" — this
wrapper recreates it by patching the shipped worker's IdempotencyJournal.commit
in-process, then running the shipped worker's main() unmodified.

Arming (explicit, default OFF — inert unless the env var is set):
    C4_PROOF_FAULT=add.after-write-before-commit        -> os._exit(2) at that point
    C4_PROOF_FAULT=cognify.after-write-before-commit    -> same

Semantics match the C4 fault hook this replaces: the exit fires AFTER the
external Cognee mutation has landed and BEFORE the journal's `completed`
record is appended, so the journal durably holds only `begun` for the key —
the exact worst-case reconciliation window (contract §7.3).

The patch fires ONLY on a journal commit whose op matches the armed fault
point; reads, forget (never journaled), and all other paths are untouched.
"""

from __future__ import annotations

import os
import sys
import pathlib

# Make the bundled worker importable regardless of how this wrapper is launched.
# This wrapper lives in <repo>/worker/; the bundled worker is <repo>/pack/src/worker/.
_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "pack" / "src" / "worker"))

import cognee_worker as shipped  # noqa: E402  (pack-bundled worker module)

_FAULT = os.environ.get("C4_PROOF_FAULT", "")


def _dlog(msg: str) -> None:
    print(f"[worker-proof] {msg}", file=sys.stderr, flush=True)


if _FAULT:
    _orig_commit = shipped.IdempotencyJournal.commit

    def _crashing_commit(self, key, op, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        if _FAULT == f"{op}.after-write-before-commit":
            _dlog(f"PROOF-FAULT-INJECTION: {op}.after-write-before-commit "
                  f"-> os._exit(2) (forced crash; journal holds 'begun' only)")
            os._exit(2)
        return _orig_commit(self, key, op, *args, **kwargs)

    shipped.IdempotencyJournal.commit = _crashing_commit
    _dlog(f"crash-injection ARMED at {_FAULT} (proof-only)")
else:
    _dlog("crash-injection NOT armed (C4_PROOF_FAULT unset) — plain shipped worker")


if __name__ == "__main__":
    sys.exit(shipped.main())