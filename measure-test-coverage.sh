#!/bin/bash
# Measure Tamandua test code coverage with Node's built-in test runner.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

set +e
node --test --experimental-test-coverage tests/*.test.ts src/**/*.test.ts > /tmp/tamandua-coverage-output.txt 2>&1
NODE_EXIT=$?
set -e

LC_ALL=C awk -F'|' '
    /all files/ {
      gsub(/[[:space:]%]/, "", $2)
      gsub(/,/, ".", $2)
      printf "%.6f\n", $2 / 100
      found = 1
    }
    END {
      if (!found) print 0
    }
  ' /tmp/tamandua-coverage-output.txt
