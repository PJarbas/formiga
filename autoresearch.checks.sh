#!/bin/bash
# Correctness checks: ensure all tests pass.
set -euo pipefail

cd "$(dirname "$0")"

# Build first (tests import from dist/)
./build 2>&1 | tail -5

# Run tests — capture output, show failures on non-zero exit
TEST_OUTPUT=$(node --test tests/*.test.ts src/**/*.test.ts 2>&1) || {
  echo "$TEST_OUTPUT" | grep -E '(✖|fail|Error|AssertionError)' || true
  exit 1
}
