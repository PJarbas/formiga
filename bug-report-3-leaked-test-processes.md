# Bug Report 3 — Tests in `tests/mcp-lifecycle.test.ts` and `tests/dashboard-status-mcp.test.ts` leak detached child processes when interrupted

**Severity:** Medium (no immediate functional break, but each `npm test` run on a flaky/timed-out worker leaks one or more long-lived node processes that hold ports and ~80–120MB RSS each; eventually exhausts ports/memory)
**Status:** Present in current `main`. Reproduced organically during the bug-fix workflow run that addressed `bug-report.md`.
**Discovered:** 2026-05-06.

## Symptom

After `tamandua workflow run bug-fix` finished, `ps -ef | grep node` showed five leaked node processes that no `tamandua` command knew about:

```
root  2645  1  0 01:26  node /root/idm/tamandua/dist/server/daemon.js 37931
root  4176  1  0 01:33  node /root/idm/tamandua/dist/server/mcp-standalone.js 36885
root  7193  1  0 01:41  node /root/idm/tamandua/dist/server/mcp-standalone.js 36463
root  8475  1  0 01:44  node /root/idm/tamandua/dist/server/mcp-standalone.js 32797
root  9755  1  0 01:48  node /root/idm/tamandua/dist/server/mcp-standalone.js 35403
```

All have `PPid=1` (orphaned/reparented to init) and bind random high ports.

`tamandua mcp status` reports "MCP server is not running" because `~/.tamandua/mcp.pid` is absent — these processes wrote their PID files into per-test temp HOMEs and the dirs (and PID files) have already been removed.

## Root cause

`tests/mcp-lifecycle.test.ts` and `tests/dashboard-status-mcp.test.ts` exercise the standalone-process lifecycle (`startMcp` / `startDaemon`) end-to-end. Each test:

1. Creates an isolated temp env: `fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-mcp-lifecycle-"))` (or `tamandua-dashboard-status-…`) with a private `home/` and `state/` subdir.
2. Spawns a fresh CLI subprocess (`spawn(node, [cliPath, "mcp", "start", "--port", String(port)])`) with `env: { HOME: tempEnv.homeDir }`.
3. The CLI invokes `daemonctl.startMcp()`, which `spawn(node, [mcp-standalone.js, port], { detached: true, stdio: ["ignore", out, err] })` and `child.unref()`s. The child inherits the test's temp `HOME`, writes its PID file there, and binds a random port.
4. Cleanup is in a `try { … } finally { await runCli(["mcp", "stop"], cliEnv); fs.rmSync(tempEnv.root, { recursive: true, force: true }); }` block.

The grandchild (mcp-standalone.js / daemon.js) process is detached and re-parented to PID 1. **The test's only handle on it is the PID written to the temp HOME's `mcp.pid`.**

Failure modes that leak:

- **The test process is SIGKILL'd before the `finally` runs.** This is exactly what happens during a `tamandua workflow run`: the agent's pi round has a wall-clock budget (`getRoleTimeoutSeconds`, e.g. 30 min for coding role); when it expires, `runPi` (`src/installer/agent-scheduler.ts:205`) `child.kill("SIGKILL")`s pi. Pi's Bash tool's `npm test` subprocess dies with it. The Node test runner inside `npm test` dies too. The detached MCP/daemon — re-parented to init — does not.
- **`runCli(["mcp", "stop"], cliEnv)` itself fails.** It is a fresh CLI subprocess that depends on `MCP_PID_FILE` still existing in the temp HOME. If anything has deleted that file (e.g. an unrelated SIGCHLD handler, a previous failed test) `stopMcp()` reports "not running" and returns 0 — and the actual standalone child stays alive.
- **`fs.rmSync(tempEnv.root, ...)` runs *after* `runCli(["mcp", "stop"])` but is best-effort (`force: true`).** Once the temp dir is gone, the standalone process's `cleanupPidFile()` on its own SIGTERM is harmless — but if SIGTERM never arrived (case 1 or 2), the standalone keeps running with no on-disk handle anywhere.

The tests were validated by the verifier in this very run (output: "Full suite — 267 passed, 0 failed, 5 skipped"). The 5 *skipped* are the smoking gun: `canBind(port)` returns false because some leaked process from a prior run is still occupying the port — so the test silently skips and the leak compounds across runs.

## Evidence linking each leaked process to a specific test

`/proc/<pid>/environ` for each leaked process carries:

| PID  | `HOME`                                              | Source test file                              |
|------|-----------------------------------------------------|-----------------------------------------------|
| 2645 | `/tmp/tamandua-dashboard-status-yfmrdJ/home`        | `tests/dashboard-status-mcp.test.ts`          |
| 4176 | `/tmp/tamandua-mcp-lifecycle-s428EC/home`           | `tests/mcp-lifecycle.test.ts`                  |
| 7193 | `/tmp/tamandua-mcp-lifecycle-jYCrbJ/home`           | `tests/mcp-lifecycle.test.ts`                  |
| 8475 | `/tmp/tamandua-mcp-lifecycle-dPh610/home`           | `tests/mcp-lifecycle.test.ts`                  |
| 9755 | `/tmp/tamandua-mcp-lifecycle-Pq3igQ/home`           | `tests/mcp-lifecycle.test.ts`                  |

The temp-prefix-only paths uniquely match the `mkdtempSync` calls at `mcp-lifecycle.test.ts:47` and (greppable) `dashboard-status-mcp.test.ts`. None of the temp roots still exist on disk — the `fs.rmSync` ran fine; only the orphaned processes survived.

## Why this is shaped like a "tamandua" bug rather than a "test runner" bug

Both `daemonctl.startMcp` (`src/server/daemonctl.ts:308`) and `daemonctl.startDaemon` (`:142`) are the production code paths for spawning detached lifecycle processes. The integration tests faithfully exercise them — that's the right thing to test. The leak isn't because the tests are wrong, it's because the production helpers offer no escape hatch for tests:

- `startMcp` always uses `detached: true; child.unref()`. There is no mode where the caller gets the `ChildProcess` back to register cleanup with `t.after(() => child.kill("SIGKILL"))`.
- The PID-file based `stopMcp` / `stopDaemon` is the *only* way to kill the spawned process. If the PID file is missing/stale (very common in tests) the process becomes unkillable through the supported API.

So: the production helpers are designed for a long-lived CLI, and tests pay the bill.

## Suggested fix (not applied — report only)

Two complementary changes:

1. **Give `startMcp` / `startDaemon` an opt-in to return the `ChildProcess` handle** (e.g. an overload `startMcp(port, { keepHandle: true })` that returns `{ pid, port, child }` and skips `child.unref()`). Tests use the handle for direct `child.kill("SIGKILL")` cleanup, production uses the existing detached path.

2. **Add a global `after()` hook in both test files** that kills any process whose command line matches `mcp-standalone.js` or `daemon.js` and whose `HOME` env points into the test's temp prefix. This is a belt-and-suspenders cleanup that handles cases where the new option above can't be used (e.g. tests that intentionally exercise the detached path).

While there, two related smells worth filing as separate work but not separate bugs:

- `tests/mcp-lifecycle.test.ts` skip-on-port-in-use (`canBind(port)` returns false → `t.skip(...)`) silently masks the leak. A noisier behavior — fail with "leaked test process bound port X; kill it" — would surface the regression on the next CI run instead of letting it fester.
- `npm test` invoked under pi's per-call wall-clock budget should probably either (a) get its own larger budget or (b) skip the lifecycle integration tests by default and run them only in `npm run test:integration`. Right now the entire 270+ test suite has to fit into pi's coding-role 30-minute window.
