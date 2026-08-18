#!/usr/bin/env bash
#
# Apalache (symbolic, SMT-backed) checks of the saga spec:
#   1. type check
#   2. inductive base case:  Init => IndInv
#   3. inductive step:       IndInv /\ Next => IndInv'   (proves I1, I2 unbounded)
#   4. bounded symbolic check of all safety invariants to a fixed length
#
# Requires a JDK (11+) and Apalache at tools/apalache/bin/apalache-mc.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APALACHE="$ROOT/tools/apalache/bin/apalache-mc"
SPEC_DIR="$ROOT/spec"
LENGTH="${1:-6}"

if [ ! -x "$APALACHE" ]; then
  echo "Apalache not found at $APALACHE"
  echo "Download: https://github.com/apalache-mc/apalache/releases (v0.47.2), extract into tools/"
  exit 2
fi

cd "$SPEC_DIR"
rc=0

echo "== type check =="
"$APALACHE" typecheck OrderSaga.tla || rc=1

echo "== inductive base case: Init => IndInv =="
"$APALACHE" check --config=apalache-corrected.cfg --init=Init --inv=IndInv --length=0 OrderSaga.tla || rc=1

echo "== inductive step: IndInv /\\ Next => IndInv' (proves I1, I2 unbounded) =="
"$APALACHE" check --config=apalache-inductive.cfg --inv=IndInv --length=1 MCInductive.tla || rc=1

echo "== bounded symbolic check: AllSafety, length $LENGTH =="
"$APALACHE" check --config=apalache-corrected.cfg --inv=AllSafety --length="$LENGTH" OrderSaga.tla || rc=1

exit "$rc"
