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
#   3. Extract the line coverage percentage, strip whitespace and "%", normalize
#      any locale decimal comma to ".", then divide by 100.
#   4. Run awk with LC_ALL=C so printf always emits "." as the decimal separator.
#
# Handles test failures gracefully — coverage report is produced even if some
# tests fail (e.g. port conflicts in parallel integration tests).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Run tests with coverage, ignoring test exit code.
# Coverage report is printed regardless of test pass/fail.
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
      if (!found) {
        print 0
      }
    }
  ' /tmp/tamandua-coverage-output.txt
