#!/bin/bash
# Autoresearch benchmark wrapper for test coverage.
# Runs the coverage measurement script and outputs a METRIC line.
set -euo pipefail

cd "$(dirname "$0")"

# Run coverage measurement (it already produces a 0-1 float)
COVERAGE=$(./measure-test-coverage.sh)

# Output structured metric for the autoresearch loop
printf "METRIC coverage=%.6f\n" "$COVERAGE"
