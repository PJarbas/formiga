#!/bin/bash
# Formiga ML Pipeline Test Runner
# Executes a full ML pipeline run against the sample dataset in data/train.csv
#
# Usage:
#   scripts/run-ml-pipeline-test.sh [target_column]
#
# Defaults:
#   target_column = price

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATASET_PATH="$PROJECT_ROOT/data/train.csv"
TARGET_COLUMN="${1:-price}"

# ── Verify dataset exists ──
if [[ ! -f "$DATASET_PATH" ]]; then
  echo "Error: Dataset not found at $DATASET_PATH"
  exit 1
fi

# ── Verify formiga is ready ──
if ! command -v formiga &>/dev/null && [[ ! -x "$PROJECT_ROOT/bin/formiga" ]]; then
  echo "Error: formiga CLI not found. Run './install' first."
  exit 1
fi

FORMIGA_BIN="${FORMIGA:-$PROJECT_ROOT/bin/formiga}"

# Ensure dashboard is up so the scheduler can claim steps
DASHBOARD_UP=false
for _ in {1..5}; do
  if curl -s http://localhost:3334/api/status &>/dev/null; then
    DASHBOARD_UP=true
    break
  fi
  sleep 1
done

if [[ "$DASHBOARD_UP" != true ]]; then
  echo "Warning: Dashboard not responding on localhost:3334. Starting 'formiga get-ready'..."
  "$FORMIGA_BIN" get-ready &
  sleep 3
fi

echo "========================================"
echo "  Formiga ML Pipeline Test Run"
echo "========================================"
echo "Dataset : $DATASET_PATH"
echo "Target  : $TARGET_COLUMN"
echo "Task    : train model predicting $TARGET_COLUMN"
echo ""

# Run the workflow
RUN_OUTPUT=$("$FORMIGA_BIN" workflow run ml-pipeline "dataset_path=$DATASET_PATH target_column=$TARGET_COLUMN" 2>&1)
RUN_ID=$(echo "$RUN_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)

echo "$RUN_OUTPUT"
echo ""

if [[ -z "$RUN_ID" ]]; then
  echo "Error: Could not extract run_id from output."
  exit 1
fi

echo "========================================"
echo "  Run ID  : $RUN_ID"
echo "  Artifacts will appear in: runs/$RUN_ID/"
echo "========================================"
echo ""

# Simple status poll — useful in CI or quick smoke tests
poll_run_status() {
  local run_id="$1"
  local max_wait="${2:-120}"
  local waited=0

  echo "Polling run status every 5s (max ${max_wait}s)..."
  while (( waited < max_wait )); do
    STATUS_JSON=$(curl -s "http://localhost:3334/api/runs" 2>/dev/null || true)
    if [[ -n "$STATUS_JSON" ]]; then
      # Try to find our run and its status
      RUN_STATUS=$(echo "$STATUS_JSON" | grep -oE '"status":"[^"]+"' | head -1 | cut -d'"' -f4)
      echo "  [$waited s] status: ${RUN_STATUS:-unknown}"
      if [[ "$RUN_STATUS" == "completed" || "$RUN_STATUS" == "failed" ]]; then
        echo ""
        echo "Run finished with status: $RUN_STATUS"
        return 0
      fi
    fi
    sleep 5
    ((waited += 5))
  done

  echo "Timeout after ${max_wait}s. Run may still be in progress."
  return 1
}

# Run the poll if --wait is passed or FORMIGA_WAIT=true
if [[ "${FORMIGA_WAIT:-}" == "true" || "${2:-}" == "--wait" ]]; then
  poll_run_status "$RUN_ID"
fi

echo ""
echo "Next steps:"
echo "  1. Watch live dashboard   -> http://localhost:3334"
echo "  2. View logs               -> formiga logs $RUN_ID"
echo "  3. Artifact dir            -> $PROJECT_ROOT/runs/$RUN_ID/"
echo "  4. Leaderboard             -> http://localhost:3334/leaderboard"
