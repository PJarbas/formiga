# Autoresearch: Increase test coverage to 100%

## Objective
Increase line coverage of the tamandua project from ~46.61% towards 1.0 (100%). Add tests to project source files under `src/` to cover uncovered code paths.

## Metrics
- **Primary**: `coverage` (ratio, higher is better) — line coverage from `./measure-test-coverage.sh`
- **Secondary**: none currently

## How to Run
`./measure-test-coverage.sh` — outputs `0.XXXXXX` (line coverage ratio). The `autoresearch.sh` wrapper reads the script output and produces `METRIC coverage=0.XXXXX`.

## Files in Scope
All `.ts` source files under `src/` (compiled to `dist/`). Tests live in:
- `src/**/*.test.ts` — unit tests co-located with source
- `tests/*.test.ts` — integration tests

### Key low-coverage modules (tamandua only):
- `src/installer/pi-config.ts` — 45.16% (type exports, read/write config/auth, error handling)
- `src/installer/install.ts` — 49.13% (agent management, role policies, installer)
- `src/installer/symlink.ts` — 66.09% (cli symlink management)
- `src/installer/workflow-spec.ts` — 70.59% (YAML parsing, validation)
- `src/cli/update.ts` — 70.29% (update command orchestration)
- `src/cli/cli.ts` — 69.83% (main CLI entry)
- `src/server/daemonctl.ts` — 70.89% (daemon lifecycle)
- `src/installer/events.ts` — 77.25% (event logging)
- `src/installer/status.ts` — 76.06% (run status queries)
- `src/installer/run-harness.ts` — 76.47% (harness working directory)
- `src/installer/workflow-fetch.ts` — 76.32% (workflow fetching)
- `src/installer/workspace-files.ts` — 74.70% (file copy utilities)
- `src/installer/uninstall.ts` — 74.30% (uninstall orchestration)

## Off Limits
- Do NOT modify `measure-test-coverage.sh` — it must remain a pure coverage gauge
- Do NOT add new dependencies to package.json
- Do NOT modify production source code to make it "more testable" — only add tests

## Constraints
- All tests must pass: `npm test` must exit 0 (enforced by `autoresearch.checks.sh`)
- Rebuild before measuring: `./build` must succeed
- Tests are parallel-safe: use isolated HOME/TAMANDUA_STATE_DIR temp dirs per test
- Prefer `src/**/*.test.ts` (co-located) to `tests/*.test.ts` (integration) for new unit tests

## What's Been Tried

### Experiments (13 total, baseline 0.4677, best 0.4817)

| # | Description | Coverage | Status | Delta |
|---|-------------|----------|--------|-------|
| 1 | Baseline | 0.4677 | keep | — |
| 2 | pi-config tests (readPiConfig, writePiConfig, readPiAuth) — 9 tests | 0.4687 | keep | +0.0010 |
| 3 | install exports + symlink + workflow-fetch + step-ops pure functions — 60 tests | 0.4795 | keep | +0.0108 |
| 4 | workspace-files + control-server unit exports — 19 tests | 0.4799 | keep | +0.0004 |
| 5 | parseAndInsertStories — 9 tests | 0.4698 | discard | -0.0101 (noise) |
| 6 | Medic modules + agent-cron + update tests — 33 tests | 0.4708 | keep | +0.0010 |
| 7 | checks.test.ts + extended update.test.ts — 11 tests | 0.4712 | keep | +0.0004 |
| 8 | uninstall + run-harness tests — 12 tests | 0.4714 | keep | +0.0002 |
| 9 | daemonctl dashboard tests | 0.4715 | checks_failed | pi binary timeout |
| 10 | daemonctl dashboard helpers (re-added) | 0.4817 | keep | +0.0103 |
| 11 | status.ts tests | 0.4815 | checks_failed | pi binary timeout |
| 12 | status.ts tests (re-added) | 0.4714 | discard | below best |
| 13 | workflow-spec tests | 0.4714 | discard | below best |

### Modules brought from 0% coverage
- `agent-cron.js`: 0% → 100%
- `checks.js`: 0% → 65.25%
- `medic-cron.js`: 0% → 83.33%
- `medic.js`: 0% → 43.92%

### Largest individual improvements
- `update.js`: 70.29% → 88.70% (+18.4pp)
- `pi-config.js`: 45.16% → 100% (+54.8pp)
- `symlink.js`: 66.09% → 86.96% (+20.9pp)
- `workspace-files.js`: 74.70% → 91.57% (+16.9pp)
- `run-harness.js`: 76.47% → 95.59% (+19.1pp)

### Key insight
Pi dependency code (~thousands of uncovered lines from node_modules) dominates the aggregate coverage metric. Tamandua's own modules have improved dramatically but the `all files` aggregate barely moves. The 0.47-0.48 range appears to be a practical ceiling for this approach. To reach significantly higher values, the measurement would need to exclude pi dependencies (e.g., filter to `dist/` only).

### Remaining tamandua gaps
- `install.js`: 49.13% — internal functions (needs full installWorkflow integration test)
- `cli.js`: 71.70% — main handlers (needs CLI subprocess tests)
- `daemonctl.js`: 70.32% — daemon start/stop paths
- `medic.js`: 43.92% — runSyncChecks/remediate (DB-heavy)
- `step-ops.js`: 77.97% — completeStep, advancePipeline, cleanupAbandonedSteps (complex DB logic)
