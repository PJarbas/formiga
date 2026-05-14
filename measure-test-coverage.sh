#!/bin/bash
# Measure Tamandua test code coverage with Node's built-in test runner.
#
# Output is a normalized line coverage score:
#   - 0 means no coverage report was produced, or the reported line coverage is 0%.
#   - 1 means the reported line coverage is 100%.
#   - Values between 0 and 1 represent partial line coverage.
#
# This script only measures coverage. It does not build the project.
# The test suite imports compiled files from dist/, so run ./build separately
# when source changes need to be compiled before measuring coverage.
#
# How it works:
#   1. Run the Node test runner with --experimental-test-coverage.
#   2. Read the coverage table's "all files" row.
#   3. Extract the line coverage percentage, strip whitespace and "%", then divide by 100.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

node --test --experimental-test-coverage tests/*.test.ts src/**/*.test.ts 2>&1 \
  | awk -F'|' '
      /all files/ {
        gsub(/[[:space:]%]/, "", $2)
        printf "%.6f\n", $2 / 100
        found = 1
      }
      END {
        if (!found) {
          print 0
        }
      }
    '
