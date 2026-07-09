# Known Issues & Troubleshooting

## 1. Daemon Stuck at 99% CPU (Zombie Daemon)

### Symptoms
- `formiga status` shows "Control-plane: DOWN" but "Running Processes" lists the daemon PID
- Steps remain in `pending` state indefinitely with no agent claiming them
- `formiga nudge` has no effect (agents are not launched)
- The daemon process consumes 99%+ CPU

### Root Cause
The daemon's event loop gets blocked, usually due to:
- A synchronous operation that never completes
- An unhandled infinite loop in the reconciler or scheduler
- A database operation that deadlocks

When the event loop is blocked, the control plane HTTP server cannot respond to health checks, nudge requests, or register new runs. The daemon PID still exists (so `isRunning()` returns true) but it's functionally dead.

### Diagnosis
```bash
# Check if control plane is responding
formiga status
# Look for: "Control-plane: DOWN" with a daemon process listed

# Verify the daemon process CPU usage
ps aux | grep "daemon.js" | grep -v grep

# Check if pi processes are running (they won't be if daemon is stuck)
ps aux | grep "[p]i "
```

### Resolution (Manual Workaround)
```bash
# Kill the stuck daemon
kill -9 <daemon-pid>

# Restart the dashboard (which also restarts the control plane)
formiga dashboard start

# Force-launch agents for pending runs
formiga nudge
```

### Fix Applied
Three mechanisms now prevent this issue:
1. **Event Loop Watchdog** (`src/server/daemon.ts`): Monitors event loop lag every 10s. If blocked for >30s, the daemon self-terminates with exit code 2.
2. **Zombie Auto-Kill** (`src/server/daemonctl.ts`): When starting a new daemon, if an existing PID is unresponsive to health checks, it is automatically killed before spawning a new one.
3. **Orphan Step Recovery** (`src/server/control-server.ts`): The reconciler checks every 30s for steps marked "running" whose `claim_pid` is dead, and resets them to "pending".

---

## 2. Steps Stuck in "Pending" Without Agent Claiming

### Symptoms
- `formiga workflow status <run-id>` shows steps as `[pending]`
- No agent processes (pi) are visible in `ps aux`
- Logs show "Step pending" but no "Claimed step" follows

### Root Cause
The agent scheduler (cron system) may not be running. This happens when:
- The daemon started but the control plane failed to bind its port
- A previous daemon zombie prevented the new daemon from fully initializing
- The reconciler hasn't yet re-admitted the run into the scheduling queue

### Diagnosis
```bash
# Check if cron jobs are active
formiga status
# Look for "[unknown] PID xxxxx pi" entries under Running Processes

# Check run scheduling status
formiga workflow status <run-id>
# If all steps are "pending" or "waiting", agents are not being dispatched
```

### Resolution
```bash
# Force immediate agent launch
formiga nudge

# If nudge doesn't work, restart everything
formiga dashboard stop
formiga dashboard start
formiga nudge
```

---

## 3. Harness (pi) Not Found

### Symptoms
- `formiga dashboard start` fails immediately with: "Daemon cannot function without a harness (pi). Exiting."
- Or: agents are nudged but immediately fail with "pi binary not found in PATH"

### Resolution
```bash
# Verify pi is installed
which pi
pi --version

# If not installed, install from GitHub
# See: https://github.com/anthropics/pi

# Or set explicit path
export FORMIGA_PI_BINARY=/path/to/pi
```

---

## 4. Multiple Stale Runs Consuming Resources

### Symptoms
- `formiga status` shows many runs in "running" state
- Token spend accumulates across multiple runs
- System is slow or unresponsive

### Resolution
```bash
# List all running runs
formiga workflow runs

# Cancel runs you don't need
formiga workflow delete <run-id>

# Keep only the run you're working with
```

---

## Architecture Notes

### Critical Path: Daemon -> Control Plane -> Scheduler -> Pi

```
formiga dashboard start
  -> spawns daemon.ts
    -> validates pi binary availability (FAILS FAST if missing)
    -> starts dashboard HTTP server (port 3334)
    -> starts control plane (port 3339)
    -> starts reconciler (every 30s)
      -> re-admits runs into scheduler
      -> detects orphaned steps (dead claim_pid)
    -> starts event loop watchdog (every 10s)

formiga workflow run <workflow> <task>
  -> registers run in DB
  -> POST /control/register-run
    -> setupAgentCrons() (one job per agent)
    -> first poll fires after stagger offset (60s per agent)

Poll tick (or formiga nudge):
  -> executePollingRound()
    -> peekStep() — is there work?
    -> claimStep() — atomically claim it
    -> runPi() — spawn pi process with agent persona
    -> parse output -> complete/fail/retry step
```

## 5. Event Explosion — Duplicate `agent_events` Rows

### Symptoms
- `agent_events` table grows by ~330 rows/min for a single stuck run
- All `tool_call` events have `tool_status = "running"`, none `"completed"` or `"failed"`
- Same timestamp has 10-20 duplicate events
- Dashboard Activity Stream shows duplicated entries

### Root Cause
`activity-recorder.ts:68-71` treats `toolcall_delta` the same as `toolcall_start`. The delta is an incremental streaming chunk that arrives multiple times per tool call, each creating a new `"running"` event. The matching `toolcall_result` that should create a `"completed"` event is never matched.

Additionally, `handleThinking` threshold of 20 chars is too low — even heartbeat responses generate thinking events.

### Fix
See `docs/RUN-6599978A-AUDIT.md` FIX-1.1.

---

## 6. Arena Step Stuck / Never Executes

### Symptoms
- Step `arena` is marked `running` but `arena_sessions.current_round = 0`
- `artifacts/models/` directory is empty
- No experiments in `experiments` table for the run
- Modeler agents remain `idle` indefinitely
- Scheduler keeps heartbeat-polling the feature-engineer

### Root Cause
`launchArenaFromStep()` marks the step as `running` then calls `runArena()`. If `buildArenaConfig()` returns `null` or `runArena()` throws silently, the step stays `running` forever. The reconciler only checks for dead `claim_pid`, which arena steps don't use.

### Fix
See `docs/RUN-6599978A-AUDIT.md` FIX-1.2.

---

## 7. Metric Direction Wrong for RMSE

### Symptoms
- `arena_sessions.metric_direction = "higher"` when `metric_name = "rmse"`
- Arena engine will select the **worst** model as winner

### Root Cause
`benchmark_config.json` doesn't include `metric.direction`. The fallback in `arena-workflow.ts` defaults to `"higher"`, which is wrong for error metrics (RMSE, MSE, MAE).

### Fix
See `docs/RUN-6599978A-AUDIT.md` FIX-1.3.

---

### Key Configuration
- `FORMIGA_CONTROL_PORT`: Control plane port (default 3339)
- `FORMIGA_PI_BINARY`: Explicit path to pi binary
- `FORMIGA_MAX_ACTIVE_TIMERS`: Max concurrent agent jobs (default: unlimited)
