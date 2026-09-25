"""C3 seed: create PRE-EXISTING datasets OUTSIDE the worker's permitted
domain, in a fresh disposable store, BEFORE the scoped worker starts.

These simulate datasets that pre-date the runtime (or belong to another
domain) but live in the same cognee store/principal. The C3 proof asserts
that a scoped worker (allow-ns qa,zeta) NEVER reveals them via
datasetsStatus, and that addressing them is rejected at the interface.

The script itself is destructive-capable, so the store guard runs first with
the fresh store as the containment boundary. cwd must be the fresh store dir
(its own .env redirects all roots into that dir).
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "proof"))

import argparse

ap = argparse.ArgumentParser(description="Seed foreign datasets in a fresh C3 store")
_ap = ap.parse_args()
# cwd must be the fresh store dir: its .env redirects all roots into that dir.

# C1 finding #9: neutralize cognee's dotenv walk-up (site-packages -> parent
# dirs) and load the cwd .env explicitly, else the OLD proof store is adopted.
import dotenv

_orig_load = dotenv.load_dotenv
dotenv.load_dotenv = lambda *a, **k: False  # neutralize cognee's walk-up load
_orig_load(str(pathlib.Path.cwd() / ".env"), override=True)  # cwd-anchored

from guard_store_roots import enforce_or_die

import contextlib
import io

_out = io.StringIO()
try:
    with contextlib.redirect_stdout(_out):
        enforce_or_die(label="c3-seed", allow_root=pathlib.Path.cwd())
except SystemExit:
    print(_out.getvalue(), file=__import__("sys").stderr, end="")
    raise

import asyncio

import cognee

FOREIGN = [
    # (cognee storage name, marker content)
    ("legacy_unscoped", "C3FOREIGN legacy dataset created before the scoped "
                        "runtime existed. Marker C3FOREIGN-LEGACY-MARKER."),
    ("outside__vault", "C3FOREIGN dataset of a namespace not granted to the "
                       "runtime. Marker C3FOREIGN-VAULT-MARKER."),
]


async def main() -> None:
    for name, content in FOREIGN:
        await cognee.add(content, dataset_name=name)
        print(f"seeded: {name}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())