"""Deterministic protocol stub worker — VERIFICATION ONLY (never shipped).

Speaks the vict-cognee-worker protocol shape that CogneeWorkerSupervision
speaks (NDJSON on stdin/stdout; a single `ready` message; per-request
{id, ok, result} responses) WITHOUT importing cognee, so tests can exercise
supervision timing (deadline through startup/queue, in-flight ownership
heartbeat) deterministically.

Env knobs:
  STUB_READY_DELAY_MS   delay before the `ready` message (default 0)
  STUB_DELAY_OPS        comma list of op names that get the artificial delay
  STUB_DELAY_MS         delay applied to those ops (default 0)
  STUB_OP_DELAY_MS      legacy global per-op delay (default 0; only used
                        when STUB_DELAY_OPS is not set)

Every op response echoes the request params and includes `servedOps`, the
count of requests this stub has RECEIVED so far — assertions use it to prove
that a refused/queued request was never dispatched.
"""

from __future__ import annotations

import json
import os
import sys
import time


def main() -> int:
    ready_delay = float(os.environ.get("STUB_READY_DELAY_MS", "0") or 0)
    slow_ops = {s.strip() for s in os.environ.get("STUB_DELAY_OPS", "").split(",") if s.strip()}
    if slow_ops:
        op_delay = float(os.environ.get("STUB_DELAY_MS", "0") or 0)
    else:
        op_delay = float(os.environ.get("STUB_OP_DELAY_MS", "0") or 0)
    if ready_delay > 0:
        time.sleep(ready_delay / 1000.0)
    sys.stdout.write(
        str(json.dumps({"type": "ready", "protocol": "stub/1", "rss_bytes": 1})) + "\n")
    sys.stdout.flush()
    served = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        served += 1
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        rid = str(msg.get("id"))
        if msg.get("op") == "shutdown":
            sys.stdout.write(str(json.dumps({"id": rid, "ok": True, "result": {"servedOps": served}})) + "\n")
            sys.stdout.flush()
            return 0
        if op_delay > 0 and (not slow_ops or msg.get("op") in slow_ops):
            time.sleep(op_delay / 1000.0)
        result = {k: v for k, v in msg.items() if k not in ("id",)}
        result["servedOps"] = served
        sys.stdout.write(str(json.dumps({"id": rid, "ok": True, "result": result})) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())