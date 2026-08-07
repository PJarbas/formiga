---
name: formiga-agents
description: Formiga is a local CLI/workflow orchestrator for coordinating multi-agent coding runs on top of pi. Use this skill when the user mentions the word formiga or when a task involves Formiga workflows, runs, steps, agents, worktrees, dashboard/control-plane services, logs, pause/resume, or Formiga-specific output contracts and documentation.
---

# Formiga Agents

## Instructions

Use this skill when operating as a Formiga workflow agent.

### 1) Confirm CLI access

Use the `formiga` CLI if available on PATH.

```bash
formiga version
formiga source-path
formiga skill-path
```

If the binary is not on PATH, use the Node entrypoint directly:

```bash
node /path/to/formiga/dist/cli/cli.js <command>
```

If neither the `formiga` binary nor the Node entrypoint can be found,
clone and install Formiga from its GitHub repository:

```bash
git clone https://github.com/Pjarbas/formiga ~/my-formiga
cd ~/my-formiga
./build
./install
```

This places a `formiga` symlink at `~/.local/bin/formiga`. Verify the
install worked by running `formiga version`.

### 2) Know the workflow-level commands

Use these when managing workflow runs (outside individual step execution):

```bash
formiga workflow list [--json]
formiga workflow install <workflow-id|--all>
formiga workflow uninstall <workflow-id|--all> [--force]
formiga workflow run <workflow-id> "<task>" [--working-directory-for-harness <dir>] [--worktree-origin-repository <dir>] [--worktree-origin-ref <ref>] [--pi-as-harness | --hermes-as-harness] [--no-hurry-please-save-tokens-mode] [--no-relaunch-upon-rugpull]
formiga workflow status <query>
formiga workflow runs
formiga workflow pause <run-id>
formiga workflow pause-all [--drain]
formiga workflow resume <run-id>
formiga workflow resume-all
formiga workflow stop <run-id>
formiga workflow autoresearch <run-id>
formiga autoresearch "<dataset_path=... target_column=...>"
formiga workflow delete <run-id> [--force]
formiga nudge
```

`formiga autoresearch "<...>"` is an alias for `formiga workflow run ml-autoresearch "<...>"`.
It starts an automated ML competition with the given key=value parameters:
`dataset_path`, `target_column`, plus optional `max_rounds`, `metric`, and `direction`.
Examples:

```bash
formiga autoresearch "dataset_path=data/classification.csv target_column=species"
formiga autoresearch "dataset_path=data.csv target_column=price max_rounds=8 metric=rmse direction=lower"
```

Formiga ships with **two bundled workflows:**

- `ml-autoresearch` — Competitive arena: Data Analyst → Feature Engineer →
  Arena (classic vs advanced modelers + creative on MEDIUM/LARGE datasets) →
  Reporter. Use `formiga autoresearch "..."` as a shortcut.
- `ml-pipeline` — Parallel pipeline: Data Analyst → Feature Engineer →
  Modeler Classic ∥ Modeler Advanced (parallel group) → ML Critic (audit).
  Run with `formiga workflow run ml-pipeline "..."`.

Both workflows use the same agent tools (`save_artifact`, `read_artifact`,
`query_leaderboard`) and the `STATUS: done` completion contract.

`formiga nudge` wakes all scheduled agents for all currently running runs,
causing them to poll once immediately without waiting for their normal
timers. Does not resume paused runs or interrupt in-flight agents.

`resume` works for both paused runs (restarted via the daemon) and failed
runs (resumed directly). `pause-all --drain` lets in-progress steps finish
before pausing.

`delete` permanently removes a workflow run and associated steps, stories,
and managed worktree data. Active runs are refused by default; use `--force`
to cancel and delete a running or paused run in one step.

`install` fetches workflow files, provisions agent workspaces, and registers
agents in `~/.formiga/agents.json`. Use `--all` (or `all`) to install every
bundled workflow in one command. `uninstall` removes the workflow and its
agent configuration. Use `--force` to skip the active-runs safety check.
`uninstall --all` removes every installed workflow.

Harness working directory guidance:

- CLI run: `--working-directory-for-harness` is optional; if omitted it defaults to the shell's current working directory.
- Prefer passing an explicit absolute path when the task depends on a specific repo checkout.

Worktree guidance:

- Use `--worktree-origin-repository <dir>` to clone a repo into an isolated
  git worktree for the run. Defaults to the current repository.
- Use `--worktree-origin-ref <ref>` to check out a specific branch, tag, or
  SHA in the worktree. Defaults to the current branch.
- Worktree runs never modify the origin repository — all changes stay in
  the isolated worktree.

Use `--no-hurry-please-save-tokens-mode` to lower agent polling frequency
for the run. When enabled, the scheduler floor becomes 15 minutes (default
15 minutes) instead of the normal 1 minute (default 5 minutes), reducing
token consumption. Use this for low-priority or long-running background
runs where responsiveness is less important than cost savings.

Use `--no-relaunch-upon-rugpull` to disable automatic replacement-run
creation after a rugpull (base branch move) is detected on a failed
merge or merge-worktree run. By default, Formiga creates a replacement
run when a rugpull is detected, so the merge can target the updated base.

`formiga workflow autoresearch <run-id>` shows AutoResearch progress
for a workflow run. It queries the arena session from the database and
prints the current metric summary, round timeline, and convergence status.

### 2.6) System status with formiga status

Use `formiga status` for a comprehensive overview of the Formiga system:

```bash
formiga status
```

`status` reports:

- **Services** — Dashboard, MCP, and control-plane status (up/down, PID, port)
- **Formiga Info** — Source path, skill path, version, and source tree SHA256
- **Workflow Runs** — Summary of all runs (running, paused, done, failed)
- **Running Processes** — Active pi/hermes harness processes spawned by Formiga

### 2.7) Control plane management

The control plane provides run-scoped scheduling that the dashboard daemon
uses to manage agent polling and work dispatch.

```bash
formiga control-plane start [--port N]
formiga control-plane stop
formiga control-plane status
```

Default port: 3339.

`status` reports whether the control plane is running (PID, port, endpoint).

Start will refuse if the control plane is already running, printing its
current status instead. Stop is safe to run even when no control plane
is active.

### 2.8) Daemon management

List and clean up daemon processes:

```bash
formiga daemon list                  # List all daemon processes (active + orphans)
formiga daemon cleanup               # Kill orphan daemons to free memory
```

`list` shows all daemon processes, marking which are active and which are
orphaned (no longer running but still holding a PID file). `cleanup` kills
all orphan daemons — useful when a daemon was terminated without proper
shutdown.

### 2.9) Full uninstall with formiga uninstall

`formiga uninstall [--force]` stops all Formiga services and removes every
installed workflow, including agent workspaces, agent registrations, and cron
jobs.

```bash
formiga uninstall [--force]
```

By default, uninstall checks for active runs (running or paused) and refuses
if any exist. Use `--force` to skip this check.

Compare with `formiga workflow uninstall <name> [--force]` which removes a
single workflow without stopping services, and `formiga workflow uninstall
--all [--force]` which removes all workflows (also no service stops).

### 3) Follow the step lifecycle exactly

Always execute step commands in this order:

1. `formiga step peek <agent-id> --run-id <run-id>`
2. If result is `HAS_WORK`, run `formiga step claim <agent-id> --run-id <run-id>`
3. Parse claim JSON: `{"stepId":"...","runId":"...","input":"..."}`
4. **SAVE `stepId` immediately** and execute the `input` task
5. Report with the saved step id:
   - Success: `formiga step complete <stepId>` (send status output through stdin)
   - Failure: `formiga step fail <stepId> "<reason>"`

Use the run ID supplied by your scheduler prompt or workflow context. `step peek` and `step claim` require `--run-id` so agents serving concurrent runs cannot claim each other's work.

Never call `step complete` or `step fail` with an agent ID. They require the claimed step UUID.

For diagnostics, use `formiga step stories <run-id>` to list all stories
for a run and their statuses. This is useful when diagnosing blocked
pipelines or understanding story progress.

### 4) Completion contract

On success, provide structured output that includes:

- `STATUS: done`
- `CHANGES: ...`
- `TESTS: ...`

Then pipe that output into `formiga step complete <stepId>`.

On failure, call `formiga step fail <stepId> "<clear reason>"` with actionable detail.

**CRITICAL — STATUS markers are parsed by the scheduler.** Output is
classified by exact markers: `STATUS: done` (success) or `STATUS: failed` /
`STATUS: error` (failure). The last line of successful output must be exactly
`STATUS: done` — not "done", not "Step completed successfully", not a summary.
On failure, end output with `STATUS: failed` and a `REASON:` line. If neither
marker is present, the scheduler treats the step as lost/abandoned and retries
it — wasting a retry slot even when the work was completed.

### 4.1) Arena modeler output contract

Arena modelers (classic, advanced, creative) have a **workflow-specific**
contract that extends the generic completion contract above:

**Final response must end with these five lines:**
```
HIPOTESE: <one-line summary of approach>
SCRIPT_PATH: artifacts/models/<agent>_round{N}.py
APRENDIZADO: <what was learned this round>
PROXIMO_FOCO: <focus for next round>
STATUS: done
```

**Benchmark stdout:** The training script must print exactly `{metric}: {value}`
(e.g. `roc_auc: 0.9563`) to stdout. This is parsed by the arena engine.

**Results file:** Every round must produce an `_results.json` containing:
- `fold_scores` — per-fold CV scores (list, not mean; used for Nadeau-Bengio)
- `train_score` — training score (used for overfit gate G1)
- `oof_path` — path to calibrated OOF predictions (`.npy`)
- `prod_path` — path to production model (`.pkl`; `null` for blends)
- `brier_score`, `ece_calibrated` — calibration metrics
- `category` — model category tag

Missing `fold_scores` triggers `[no_folds]` rejection (G3). Large train/val
gap triggers `[overfit]` rejection (G1).

### 4.2) Arena agent tools

All ml-autoresearch and ml-pipeline agents have access to these
**formiga-agent-tools** MCP extension tools:

```bash
save_artifact <key>    # Persist artifact to database (NEVER use curl)
read_artifact <key>    # Read artifact from database
query_leaderboard       # Query arena leaderboard (current standings)
```

`save_artifact` is the **only supported way** to persist artifacts. Do not
use curl, write files without tracking, or call HTTP endpoints directly.
The database is the source of truth for all pipeline artifacts.

### 2.1) MCP run start (remote)

When using MCP, `formiga.run.start` requires a harness working directory.
`workingDirectoryForHarness` is mandatory (not optional) for MCP runs.

Required MCP args:

- `workflowId`
- `taskTitle`
- `workingDirectoryForHarness` (mandatory)

Optional MCP args:

- `noHurrySaveTokensMode` (boolean) — lowers agent polling frequency to
  save tokens, same as the CLI `--no-hurry-please-save-tokens-mode` flag.
  When `true`, the scheduler uses a 15-minute floor and 15-minute default
  instead of the normal 1-minute floor and 5-minute default.

Additional MCP tools:

- `formiga.run.delete` — permanently delete a run. Requires `runId`. Optional
  `force` (boolean) to cancel and delete active runs.

Recovery pattern for tool-calling models:

- If MCP returns: `Argument "workingDirectoryForHarness" must be a non-empty string`
- Retry the same tool call with an explicit absolute path (for example `/home/user/repo`).

### 2.2) Inspect activity with logs and logs-tail

Use logs to inspect recent run activity or follow events as they happen.

The selector can be:
- A number — shows that many most recent entries globally
- A run ID prefix — shows entries for that run
- `#<run-number>` — shows entries for the Nth run

```bash
# Show recent entries
formiga logs                        # default: last 20 entries
formiga logs 50                     # last 50 entries
formiga logs <run-id>               # entries for a specific run
formiga logs #3                     # entries for run number 3

# Follow activity as new events arrive
formiga logs-tail                   # tail recent activity (live)
formiga logs-tail 50                # tail, starting with last 50 entries
formiga logs-tail <run-id>          # tail events for a specific run
formiga logs-tail #3                # tail events for run number 3
```

Example: after starting a workflow, follow its progress:

```bash
formiga workflow run feature-dev "Add login page"
# -> Run started: 8a3b2c1d-...
formiga logs-tail 8a3b2c1d          # follow events as they arrive
```

### 2.3) Dashboard lifecycle and source path

Start, stop, and check the web dashboard:

```bash
formiga dashboard start [--port N]    # Start dashboard (default: 3334)
formiga dashboard stop                # Stop dashboard
formiga dashboard status              # Check dashboard + MCP status
```

`dashboard status` reports both dashboard and MCP server status in a single
output.

`formiga source-path` prints the source checkout path that `formiga update`
uses to pull, rebuild, and reinstall.

### 2.4) First-time setup with get-ready

Use `formiga get-ready` to prepare a fresh Formiga checkout.

```bash
formiga get-ready
```

`get-ready` performs these setup steps in order:

1. Installs all bundled workflows into your Formiga state directory
2. Ensures the CLI launcher symlink exists at `~/.local/bin/formiga`
3. Starts the dashboard daemon if it is not already running
   (the daemon co-manages the dashboard HTTP server and the in-process control plane)
4. Reports dashboard and MCP server status

Run `get-ready` after pulling a new Formiga checkout or after
`formiga update` if workflows or services need reinstallation.
It is safe to run multiple times — already-installed workflows are
skipped and a running daemon is left untouched.

Example session:

```bash
cd /path/to/formiga
./build && ./install
formiga get-ready
# -> Installs bundled workflows
# -> Ensures CLI symlink exists
# -> Dashboard is running on port 3334
# -> MCP server is not running (start it with: formiga mcp start)
```

### 2.5) Hermes harness support (Alpha)

The `--hermes-as-harness` flag runs agents with the Hermes harness instead of
the default pi harness.

```bash
formiga workflow run <workflow-id> "<task>" --hermes-as-harness
```

> ⚠️ **Hermes support is in alpha.** It is **very slow** compared to pi, and
> **token accounting is broken** — token counts reported by Hermes runs are
> inaccurate. Pi is the default and recommended harness for production use.

The `--pi-as-harness` flag explicitly selects the pi harness (this is the
default, so the flag is rarely needed unless a previous run used
`--hermes-as-harness`).

These flags are mutually exclusive — you cannot specify both in the same run.

To use a custom Hermes binary, set the `FORMIGA_HERMES_BINARY` environment
variable:

```bash
export FORMIGA_HERMES_BINARY=/path/to/hermes
formiga workflow run <workflow-id> "<task>" --hermes-as-harness
```

If `FORMIGA_HERMES_BINARY` is not set, Formiga searches for `hermes` on
`PATH`. The binary is validated at scheduling time — if it is not found or
not executable, the run fails at startup.

### 5) Inter-agent messaging

Agents can send structured messages to each other during a run. Messages are
stored in SQLite and can be read by the recipient agent.

```bash
# Send a message to another agent
formiga message send <to-agent> '<json>' --run-id <run-id>

# List messages for an agent (optionally filter by sender)
formiga message list --run-id <run-id> [--from <agent>]

# Read a specific message
formiga message read <message-key> --run-id <run-id>
```

Example:

```bash
# Data analyst sends findings to feature engineer
formiga message send feature-engineer '{"type":"eda_complete","findings":["high_cardinality_cols","missing_values"]}' --run-id abc123

# Feature engineer reads messages
formiga message list --run-id abc123
formiga message read eda_complete --run-id abc123
```

### 5.1) Stale run management

Identify and clean up runs that have been idle for too long.

```bash
# List runs idle for more than N minutes (default: 60)
formiga runs list-stale [--min-minutes N] [--json]

# Cancel stale runs in bulk (requires --force)
formiga runs cancel-stale [--min-minutes N] --force
```

Examples:

```bash
# Find runs idle for over 2 hours
formiga runs list-stale --min-minutes 120

# Cancel all runs idle for over 3 hours
formiga runs cancel-stale --min-minutes 180 --force
```

### 6) Review artifacts on changes

When making code changes, review whether these artifacts need updating:

- `docs/ARCHITECTURE.md` — architecture and workflow documentation
- `src/mcp/server.ts` — MCP tools registered for agent use
- `src/cli/cli.ts` — CLI commands that agents invoke
- `src/dashboard/` — dashboard UI (React app)
- `README.md` — project overview

Changes that typically cascade to multiple artifacts:

- **Step lifecycle** changes → update CLI, MCP, docs
- **CLI command** additions or changes → update skill, MCP, docs
- **Agent provisioning** changes → update skill, workspace files
- **Output format contract** changes → update docs, MCP

If you update this skill file, verify that bundled workflow persona AGENTS.md
files reflect the change.

## Examples

### Polling loop example

```bash
# Phase 1: Peek
formiga step peek feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> NO_WORK (stop) OR HAS_WORK (continue)

# Phase 2: Claim
formiga step claim feature-dev_developer --run-id 7aeb4da9-1111-4222-8333-abcdefabcdef
# -> {"stepId":"87409f73-...","runId":"7aeb4da9-...","input":"Implement ..."}
# Save stepId=87409f73-...

# Execute the input task...

# Success report (uses saved stepId)
echo 'STATUS: done
CHANGES: Added skill docs and tests
TESTS: node --test tests/*.test.ts' | formiga step complete 87409f73-4ba6-492a-be44-30b2b6ffbadb

# Failure alternative
# formiga step fail 87409f73-4ba6-492a-be44-30b2b6ffbadb "Missing repository path"
```

### Manual step inspection

```bash
formiga step stories <run-id>
```

Use `step stories` to inspect current story status for a run when diagnosing blocked pipelines.
