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
- (baseline established at 46.61%)
