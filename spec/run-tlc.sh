#!/usr/bin/env bash
#
# Model-check the saga with TLC.
#   - The corrected design must satisfy every invariant and the liveness
#     property (exit 0).
#   - The uncorrected design must produce a counterexample (a non-zero TLC
#     exit), which this script treats as the expected outcome.
#
# Requires a JDK (11+) and tools/tla2tools.jar (downloaded by this script if
# absent).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$ROOT/tools/tla2tools.jar"
SPEC_DIR="$ROOT/spec"
TLA_VERSION="v1.8.0"

if [ ! -f "$JAR" ]; then
  echo "tla2tools.jar not found; downloading $TLA_VERSION ..."
  mkdir -p "$ROOT/tools"
  curl -sL -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar"
fi

run_tlc() {
  # $1 = cfg file
  # -deadlock: the saga legitimately terminates (quiescent terminal states have
  # no successors); genuine non-termination is caught by the L1 liveness check,
  # not by deadlock detection.
  java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
    -config "$1" -workers auto -deadlock -cleanup OrderSaga.tla
}

cd "$SPEC_DIR"

echo "=================================================================="
echo "TLC: corrected design (expect: no violations)"
echo "=================================================================="
run_tlc OrderSaga.cfg
corrected_rc=$?

echo
echo "=================================================================="
echo "TLC: uncorrected design (expect: counterexample)"
echo "=================================================================="
run_tlc OrderSagaUncorrected.cfg
uncorrected_rc=$?

echo
echo "=================================================================="
echo "Summary"
echo "=================================================================="
fail=0
if [ "$corrected_rc" -eq 0 ]; then
  echo "corrected:   PASS (all invariants and L1 hold)"
else
  echo "corrected:   FAIL (rc=$corrected_rc) -- unexpected violation"
  fail=1
fi
if [ "$uncorrected_rc" -ne 0 ]; then
  echo "uncorrected: PASS (counterexample found, as expected; TLC rc=$uncorrected_rc)"
else
  echo "uncorrected: FAIL -- expected a counterexample but none was found"
  fail=1
fi

exit "$fail"
