#!/usr/bin/env bash
# Fresh-clone proof runner for the pinned cognee==1.6.1 C1 battery.
# Tested environment: Windows 11 + Git for Windows (MINGW64 bash), Python 3.12.
#
# Usage (from a fresh clone):
#   cd proof && bash run_proof.sh            # full flow: venv, install, all batteries
#   bash run_proof.sh --skip-install         # reuse existing .venv
#
# What it does:
#   1. creates proof/.venv (if missing) and installs cognee[gliner]==1.6.1 (pinned)
#   2. generates proof/.env from .env.example with absolute paths (git-ignored)
#   3. runs smoke_01 and every battery SEQUENTIALLY (never concurrently — see report §3.8)
#   4. leaves JSON records in proof/results/ and console logs in *.output.txt
set -euo pipefail

cd "$(dirname "$0")"
PROOF_DIR="$(pwd -W 2>/dev/null || pwd)"   # Windows absolute path for .env

if [ ! -d .venv ]; then
  echo "== creating venv =="
  python -m venv .venv
fi
PY=.venv/Scripts/python

if [ "${1:-}" != "--skip-install" ]; then
  echo "== installing pinned cognee (this caches models on first cognify) =="
  "$PY" -m pip install --quiet "cognee[gliner]==1.6.1"
  "$PY" -m pip freeze > requirements-frozen.txt
fi

echo "== generating .env from .env.example (PROOF_DIR=$PROOF_DIR) =="
sed "s|@PROOF_DIR@|$PROOF_DIR|g" .env.example > .env

# Single-thread native limits: on low-RAM Windows machines the multi-thread gliner
# encoder load has segfaulted intermittently (agent observation; see report §3.8).
export OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 KUZU_BUFFER_POOL_SIZE=268435456

run() {  # sequential runner: never two cognee processes on one system root
  local script="$1"
  echo "== running $script =="
  if "$PY" "$script" > "${script%.py}.output.txt" 2>&1; then
    echo "   OK  -> ${script%.py}.output.txt"
  else
    local rc=$?
    echo "   FAILED (rc=$rc) -> ${script%.py}.output.txt"
    tail -5 "${script%.py}.output.txt" || true
    exit "$rc"
  fi
}

run smoke_01.py
run battery_02_retrieval.py
run battery_03_scope.py
run battery_03b_scope.py
run battery_03c_userb.py
run battery_04_conflict.py
run battery_04b_conflict_full.py
run battery_05_repeat_delete.py
run battery_05b_residue.py
run battery_06_failures.py
run battery_07_malay.py

echo "== done; JSON records: $(ls results/*.json | wc -l) =="
