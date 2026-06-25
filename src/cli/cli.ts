#!/usr/bin/env node

// Runtime check: node:sqlite requires Node.js >= 22
try {
  await import("node:sqlite");
} catch {
  console.error("Error: node:sqlite is not available.\n\nFormiga requires Node.js >= 22 with native SQLite support.");
  process.exit(1);
}

import { installWorkflow } from "../installer/install.js";
import { uninstallAllWorkflows, uninstallWorkflow, checkActiveRuns } from "../installer/uninstall.js";
import { getWorkflowStatus, listRuns, stopWorkflow, deleteWorkflow, type RunInfo, type RunDetail } from "../installer/status.js";
import { runWorkflow, resumeWorkflow, type RunWorkflowResult } from "../installer/run.js";
import { listBundledWorkflows, getWorkflowShortDescription } from "../installer/workflow-fetch.js";
import { loadWorkflowSpec } from "../installer/workflow-spec.js";
import { resolveBundledWorkflowDir } from "../installer/paths.js";
import { getRecentEvents, getRunEvents, readEventsFromCursor, type EventCursorSource, type FormigaEvent } from "../installer/events.js";
import { formatLogsTailLines } from "../installer/logs-tail-format.js";
import { parseLogsSelector, lookupRunIdByNumber } from "./logs-selector.js";
import { startDaemon, stopDaemon, getDaemonStatus, isRunning, startControlPlane, stopControlPlane, getControlPlaneStatus, isControlPlaneRunning } from "../server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../server/control-server.js";
import { pauseRunWithDaemon, resumeRunWithDaemon, nudgeWithDaemon } from "../server/control-client.js";
import { claimStep, completeStep, failStep, getStories, peekStep } from "../installer/step-ops.js";
import { resolveSourcePath, resolveSkillPath } from "../installer/paths.js";
import { formatServiceStatus, formatFormigaInfo, formatRunsSummary, formatProcessList } from "./status-format.js";
import { getWorkflowStatus as getWorkflowStatusFn } from "../installer/status.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getBuildVersion } from "../lib/version.js";
import { parseWorkflowRunArgs } from "./workflow-run-args.js";
import type { HarnessType } from "../installer/types.js";
import {
  findAutoresearchSessionCwd,
  initExperiment,
  runExperiment,
  logExperiment,
  loopAutoresearch,
  runLoopIteration,
  readAutoresearchLog,
  summarizeAutoresearch,
  type AutoresearchDecision,
  type AutoresearchDirection,
  type AutoresearchRunEntry,
  type AutoresearchSummary,
  type RunLoopIterationOptions,
  type RunLoopIterationResult,
} from "../autoresearch/autoresearch.js";
import { getDb, upsertAutoresearchSession } from "../db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkgPath = join(__dirname, "..", "..", "package.json");

const BUILT_VERSION = "__VERSION__";

function getVersion(): string {
  const buildVersion = getBuildVersion();
  if (buildVersion !== "unknown") return buildVersion;
  if (BUILT_VERSION !== "__VERSION__") return BUILT_VERSION;
  try { const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")); return pkg.version ?? "unknown"; }
  catch { return "unknown"; }
}

function printEvents(events: FormigaEvent[]): void {
  if (events.length === 0) { console.log("No events yet."); return; }
  for (const line of formatLogsTailLines(events)) {
    console.log(line);
  }
}

function parseDuration(input: string): number {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${input}". Use <number><unit> where unit is s, m, h, or d (e.g. 300s, 5m, 1h, 7d).`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

function getLogsTailPollIntervalMs(): number {
  const raw = parseInt(process.env.FORMIGA_LOGS_TAIL_POLL_MS ?? "1000", 10);
  if (Number.isNaN(raw)) return 1000;
  return Math.max(10, raw);
}

async function streamEventSource(source: EventCursorSource, initialLimit: number): Promise<void> {
  const initial = readEventsFromCursor(source, 0);
  const firstBatch = initial.events.slice(-Math.max(1, initialLimit));
  if (firstBatch.length === 0) console.log("No events yet.");
  else printEvents(firstBatch);

  let cursor = initial.nextOffset;
  const abort = new AbortController();
  const pollIntervalMs = getLogsTailPollIntervalMs();
  const onSigint = () => abort.abort();

  process.on("SIGINT", onSigint);
  try {
    while (!abort.signal.aborted) {
      try {
        await delay(pollIntervalMs, undefined, { signal: abort.signal });
      } catch (err) {
        if ((err as Error).name === "AbortError") break;
        throw err;
      }
      if (abort.signal.aborted) break;

      const next = readEventsFromCursor(source, cursor);
      cursor = next.nextOffset;
      if (next.events.length > 0) printEvents(next.events);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function printHelp(text: string): void {
  process.stdout.write(text + "\n");
  process.exit(0);
}

function printHelpSubcommand(subcommands: Record<string, string>): void {
  const maxLen = Math.max(...Object.keys(subcommands).map((k) => k.length));
  const lines: string[] = [];
  for (const [name, desc] of Object.entries(subcommands)) {
    lines.push(`  ${name.padEnd(maxLen + 2)}${desc}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function readOption(args: string[], name: string): string | undefined {
  const inline = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === name) return args[i + 1];
    if (token.startsWith(inline)) return token.slice(inline.length);
  }
  return undefined;
}

function requireOption(args: string[], name: string, usage: string): string {
  const value = readOption(args, name)?.trim();
  if (!value) {
    process.stderr.write(`Missing ${name}.\nUsage: ${usage}\n`);
    process.exit(1);
  }
  return value;
}

function parseDirection(value: string): AutoresearchDirection {
  if (value === "lower" || value === "higher") return value;
  process.stderr.write(`Invalid --direction "${value}". Use "lower" or "higher".\n`);
  process.exit(1);
}

function parseAutoresearchDecision(value: string | undefined): AutoresearchDecision | "auto" | undefined {
  if (!value) return undefined;
  if (value === "auto" || value === "baseline" || value === "keep" || value === "discard" || value === "crash" || value === "checks_failed") return value;
  process.stderr.write(`Invalid --status "${value}". Use auto, baseline, keep, discard, crash, or checks_failed.\n`);
  process.exit(1);
}

function formatAutoresearchConfidence(value: Pick<AutoresearchSummary, "confidence_score" | "confidence_band" | "noise_floor_mad" | "confidence_sample_count">): string {
  if (value.confidence_score === null) {
    return `unknown (${value.confidence_sample_count} sample${value.confidence_sample_count === 1 ? "" : "s"})`;
  }
  const score = value.confidence_score === Infinity ? "Infinity" : value.confidence_score.toFixed(2);
  const mad = value.noise_floor_mad === null ? "unknown" : String(value.noise_floor_mad);
  return `${value.confidence_band} (score=${score}, MAD=${mad}, n=${value.confidence_sample_count})`;
}

function printAutoresearchSummary(cwd?: string): void {
  const summary = summarizeAutoresearch(cwd);
  if (!summary.exists) {
    console.log(summary.nextPrompt);
    return;
  }
  console.log("AutoResearch");
  console.log(`Goal:        ${summary.goal}`);
  console.log(`Metric:      ${summary.metricName}${summary.metricUnit ? ` (${summary.metricUnit})` : ""}`);
  console.log(`Direction:   ${summary.direction}`);
  console.log(`Runs:        ${summary.totalRuns} logged (${summary.keptRuns} kept, ${summary.discardedRuns} discarded)`);
  console.log(`Failures:    ${summary.crashedRuns} crash, ${summary.checksFailedRuns} checks_failed`);
  console.log(`Baseline:    ${summary.baselineMetric ?? "(none)"}`);
  console.log(`Best:        ${summary.bestMetric ?? "(none)"}${summary.bestRun ? ` at run ${summary.bestRun}` : ""}`);
  console.log(`Confidence:  ${formatAutoresearchConfidence(summary)}`);
  console.log("");
  console.log(summary.nextPrompt);
}

function resolveAutoresearchCwdForRun(runIdOrPrefix: string): { runId: string; cwd?: string } {
  const detail = getWorkflowStatus(runIdOrPrefix);
  const db = getDb();
  const row = db.prepare("SELECT context FROM runs WHERE id = ?").get(detail.id) as { context?: string | null } | undefined;
  if (!row?.context) return { runId: detail.id };

  let context: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.context) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      context = parsed as Record<string, unknown>;
    }
  } catch {
    return { runId: detail.id };
  }

  const readString = (key: string): string | undefined => {
    const value = context[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };

  return {
    runId: detail.id,
    cwd: readString("working_directory_for_harness") ?? readString("cwd"),
  };
}

function printAutoresearchTimeline(cwd: string): void {
  const entries = readAutoresearchLog(cwd);
  const runs = entries.filter((entry): entry is AutoresearchRunEntry => entry.type === "run");
  if (runs.length === 0) {
    console.log("Timeline:    No logged experiments yet.");
    return;
  }

  console.log("Timeline:");
  for (const run of runs.slice(-12)) {
    const metric = run.metric === null ? "-" : String(run.metric);
    const confidence = run.confidence_score === null || run.confidence_score === undefined ? "" : ` confidence=${run.confidence_band}`;
    const learned = run.asi?.learned ? ` — ${run.asi.learned}` : "";
    const next = run.asi?.next_focus ? ` | next: ${run.asi.next_focus}` : "";
    console.log(`  #${String(run.run).padStart(2, "0")} [${run.status.padEnd(13)}] ${metric.padEnd(8)} ${run.description}${confidence}${learned}${next}`);
  }
}

function printWorkflowAutoresearch(runIdOrPrefix: string): void {
  let resolved: { runId: string; cwd?: string };
  try {
    resolved = resolveAutoresearchCwdForRun(runIdOrPrefix);
  } catch (err) {
    const message = err instanceof Error ? err.message : `No run found matching "${runIdOrPrefix}".`;
    console.log(message.startsWith("No run found matching") ? `No run found matching "${runIdOrPrefix}".` : message);
    return;
  }

  if (!resolved.cwd) {
    console.log(`Run ${resolved.runId.slice(0, 8)} has no harness working directory in its context.`);
    return;
  }

  const autoresearchCwd = findAutoresearchSessionCwd(resolved.cwd) ?? resolved.cwd;
  console.log(`Run:         ${resolved.runId.slice(0, 8)}`);
  console.log(`Harness CWD: ${resolved.cwd}`);
  if (autoresearchCwd !== resolved.cwd) console.log(`Session CWD: ${autoresearchCwd}`);
  printAutoresearchSummary(autoresearchCwd);
  const summary = summarizeAutoresearch(autoresearchCwd);
  if (summary.exists) {
    console.log("");
    printAutoresearchTimeline(autoresearchCwd);
  }
}

function getVersionHelp(): string {
  return `formiga version — Display build version

Usage: formiga version
   or: formiga --version
   or: formiga -v

Prints the build version of Formiga in ISO8601_refhash format.
The version is composed of the UTC timestamp of the HEAD commit
and its full 40-character SHA1 hash, separated by an underscore.
This string is computed at build time and embedded in the dist
output.

Examples:
  formiga version           # Prints e.g. "20260526T140530Z_4ad4844ff86d37cd04eaf736e8cc43ad467b0338"
  formiga --version         # Same output
  formiga -v                # Same output`;
}

function getSkillPathHelp(): string {
  return `formiga skill-path — Print path to bundled formiga-agents skill

Usage: formiga skill-path

Prints the absolute filesystem path to the bundled formiga-agents skill
directory. This is the directory containing the AGENTS.md, IDENTITY.md,
and SOUL.md files that are provisioned to workflow agents.

Examples:
  formiga skill-path        # Prints the skill directory path`;
}

function getSourcePathHelp(): string {
  return `formiga source-path — Print Formiga source checkout path

Usage: formiga source-path

Prints the absolute filesystem path to the resolved Formiga source checkout.
This is the directory containing the built dist/, package.json, and
build-and-install script.

Examples:
  formiga source-path       # Prints the source checkout path`;
}

function getGetReadyHelp(): string {
  return `formiga get-ready — Install all bundled workflows from the source checkout

Usage: formiga get-ready

formiga get-ready sets up Formiga by installing every bundled workflow.

In order, it does this:

  1. Lists all bundled workflows available in the source checkout.
  2. Installs each workflow: fetches workflow files, loads the YAML spec,
     provisions agent workspaces (AGENTS.md, IDENTITY.md, SOUL.md), and
     registers agents in ~/.formiga/agents.json.
  3. Reports whether the dashboard daemon is already running.
  4. If the dashboard is not running, starts it on the default port
     (3334) so you can monitor workflow runs.

Examples:
  formiga get-ready            # Install all bundled workflows and start dashboard
  formiga workflow install <name>  # Install a single workflow by name`;
}

function getUninstallHelp(): string {
  return `formiga uninstall — Fully remove Formiga workflows, agents, and services

Usage: formiga uninstall [--force]

formiga uninstall stops all Formiga services and removes every installed
workflow, including agent workspaces, agent registrations, and cron jobs.

In order, it does this:

  1. Checks for active runs with status running or paused.
  2. If active runs exist and --force is not set, lists them and exits
     with code 1.
  3. Stops the dashboard daemon if it is running.
  4. Uninstalls every workflow: removes workflow directories, agent
     workspaces, agent entries from ~/.formiga/agents.json, and cron
     jobs.

Options:
  --force    Skip the active-runs check and uninstall anyway.

Examples:
  formiga uninstall          # Full uninstall (refuses if active runs exist)
  formiga uninstall --force  # Force uninstall despite active runs
  formiga workflow uninstall <name>  # Uninstall a single workflow by name
  formiga workflow uninstall --all   # Uninstall all workflows only (no service stops)`;
}

function getStatusHelp(): string {
  return `formiga status — Show detailed Formiga system status

Usage: formiga status

Displays a comprehensive status overview of the Formiga system, including:

  Services — Dashboard and control-plane status (up/down, PID, port)
  Formiga Info — Source path, skill path, version, and source tree SHA256
  Workflow Runs — Summary of all runs (running, paused, done, failed)
  Running Processes — Active pi/hermes harness processes spawned by formiga

Examples:
  formiga status             # Full system status overview
  formiga status --help      # This help text`;
}

function getStepPeekHelp(): string {
  return `formiga step peek — Check for pending work for an agent

Usage: formiga step peek <agent-id> --run-id <run-id>

step peek checks whether an agent has pending (waiting or pending) work in the
specified run. It is used by the agent scheduler polling loop to decide whether
to spawn a work session.

Output:
  HAS_WORK    — There is pending work; the scheduler will spawn a work session.
  NO_WORK     — No pending work; the scheduler will poll again later.

The --run-id flag is required so concurrent runs of the same workflow/agent
cannot cross-claim each other's steps.

Examples:
  formiga step peek feature-dev-merge_developer --run-id abc12345`;
}

function getStepClaimHelp(): string {
  return `formiga step claim — Atomically claim a pending step

Usage: formiga step claim <agent-id> --run-id <run-id>

step claim claims the next pending step for the given agent within a run.
The claim is atomic — if two agents claim simultaneously, only one will
receive the step.

Output (JSON):
  On success: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}
  No pending steps: NO_WORK

The --run-id flag is required so concurrent runs of the same workflow/agent
cannot cross-claim each other's steps.

Examples:
  formiga step claim feature-dev-merge_developer --run-id abc12345`;
}

function getStepCompleteHelp(): string {
  return `formiga step complete — Mark a step as done

Usage: formiga step complete <step-id>
   or: echo "STATUS: done
  CHANGES: what changed
  TESTS: what was tested" | formiga step complete <step-id>

step complete marks a claimed step as completed. It reads the agent's output
from either stdin or positional arguments.

Expected input format (newline-delimited key:value blocks):
  STATUS: done
  CHANGES: <what was implemented>
  TESTS: <what tests were run>
  REPO: <repo path>          (optional)
  BRANCH: <branch name>      (optional)
  COMMITS: <commit list>     (optional)

When using positional arguments, the entire output is passed as a single
string. When using stdin, the output is read until EOF.

Examples:
  formiga step complete 123e4567-e89b-12d3-a456-426614174000
  echo "STATUS: done\nCHANGES: Added feature X\nTESTS: Wrote unit tests" | \\
    formiga step complete 123e4567-e89b-12d3-a456-426614174000`;
}

function getStepFailHelp(): string {
  return `formiga step fail — Mark a step as failed

Usage: formiga step fail <step-id> [<error message>]

step fail marks a step as failed with a reason. When a step fails, Formiga
automatically triggers retry logic — the step is reset to pending and will
be re-claimed by the agent on the next polling cycle. The error message
is logged for diagnostics.

If no error message is provided, "Unknown error" is used.

Retry behavior: Steps that exceed the maximum retry count (configured in
the workflow spec) are escalated rather than retried.

Examples:
  formiga step fail 123e4567-e89b-12d3-a456-426614174000
  formiga step fail 123e4567-e89b-12d3-a456-426614174000 "Network timeout"`;
}

function getStepStoriesHelp(): string {
  return `formiga step stories — List all stories and their status for a run

Usage: formiga step stories <run-id>

step stories displays every story in the current story plan for a run,
showing their status (pending, running, done, failed), title, and any
retry counts.

Output format:
  US-001   [done   ] Story title here
  US-002   [running] Another story
  US-003   [pending] Upcoming story (retry 1)

Examples:
  formiga step stories abc12345`;
}

function getDashboardHelp(): string {
  return `formiga dashboard — Manage the web dashboard daemon

Usage: formiga dashboard <start|stop|status>

The dashboard daemon runs the Formiga web dashboard, a local HTTP server
for monitoring workflow runs, logs, and agent activity.

Default port: 3334

Subcommands:
  start  [--port N]   Start the dashboard daemon on the given port
  stop                Stop the dashboard daemon
  status              Show dashboard status

Start will refuse if the dashboard is already running.

Examples:
  formiga dashboard start             # Start on default port 3334
  formiga dashboard start --port 8080 # Start on port 8080
  formiga dashboard stop              # Stop the dashboard
  formiga dashboard status            # Check dashboard status`;
}

function getDashboardStartHelp(): string {
  return `formiga dashboard start — Start the web dashboard daemon

Usage: formiga dashboard start [--port N]

Starts the dashboard daemon on the specified port (default: 3334). The
dashboard provides an HTTP interface at http://localhost:<port> for
monitoring workflow runs, logs, and agent activity.

If the dashboard is already running, the command prints the current
status instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3334)

Examples:
  formiga dashboard start             # Start on default port 3334
  formiga dashboard start --port 8080 # Start on port 8080`;
}

function getDashboardStopHelp(): string {
  return `formiga dashboard stop — Stop the web dashboard daemon

Usage: formiga dashboard stop

Stops the dashboard daemon if it is running. If the daemon is not running,
the command prints a message and exits successfully.

Examples:
  formiga dashboard stop`;
}

function getDashboardStatusHelp(): string {
  return `formiga dashboard status — Show dashboard status

Usage: formiga dashboard status

Reports whether the dashboard daemon is running (PID, port, endpoint URL).
When not running, it prints the default endpoint that would be used on start.

Examples:
  formiga dashboard status`;
}

function getControlPlaneHelp(): string {
  return `formiga control-plane — Manage the control plane server

Usage: formiga control-plane <start|stop|status>

The control plane server provides a scheduling API for run-scoped agent
polling. The dashboard daemon communicates with the control plane to manage
which agents are actively polling and to dispatch work sessions.

Default port: 3339

Subcommands:
  start  [--port N]   Start the control plane server on the given port
  stop                Stop the control plane server
  status              Show whether the control plane is running (PID, port, endpoint)

Start will refuse if the control plane is already running, printing its
current status instead.

Examples:
  formiga control-plane start               # Start on default port 3339
  formiga control-plane start --port 4444   # Start on port 4444
  formiga control-plane stop                # Stop the control plane
  formiga control-plane status              # Check control plane status`;
}

function getControlPlaneStartHelp(): string {
  return `formiga control-plane start — Start the control plane server

Usage: formiga control-plane start [--port N]

Starts the control plane server on the specified port (default: 3339).
The control plane provides run-scoped scheduling endpoints that the
dashboard daemon uses to manage agent polling and work dispatch.

If the control plane is already running, the command prints the current
PID, port, and endpoint instead of starting a duplicate.

Options:
  --port N    Port to listen on (default: 3339)

Examples:
  formiga control-plane start              # Start on default port 3339
  formiga control-plane start --port 4444  # Start on port 4444`;
}

function getControlPlaneStopHelp(): string {
  return `formiga control-plane stop — Stop the control plane server

Usage: formiga control-plane stop

Stops the control plane server if it is running. If the server is not
running, the command prints a message and exits successfully.

Examples:
  formiga control-plane stop`;
}

function getLogsHelp(): string {
  return `formiga logs — Show recent activity events

Usage: formiga logs [<selector>]

Shows the most recent Formiga activity events (runs, steps, agent activity).
The optional selector determines which events to show.

Selector syntax:
  <run-id>      Show events for a specific run (prefix match supported)
  #<N>          Show events for run number N
  <N>           Show the last N events globally (e.g. 20 for last 20)
  (no arg)      Show the last 50 events globally

If a run-id prefix matches no run in the database but has an events file on
disk (events can be written before the run row is committed), the logs output
will still show those events.

Examples:
  formiga logs                   # Show last 50 global events
  formiga logs 20                # Show last 20 global events
  formiga logs abc123            # Show events for run starting with abc123
  formiga logs #3                # Show events for run #3`;
}

function getLogsTailHelp(): string {
  return `formiga logs-tail — Follow activity events in real-time

Usage: formiga logs-tail [<selector>]

Follows Formiga activity events in real-time, polling for new events and
printing them as they arrive. Press Ctrl-C (SIGINT) to stop following.

The selector uses the same syntax as formiga logs:
  <run-id>      Follow events for a specific run (prefix match supported)
  #<N>          Follow events for run number N
  <N>           Follow global events, showing the last N first
  (no arg)      Follow global events, showing the last 50 first

The polling interval defaults to 1000ms and can be configured via the
FORMIGA_LOGS_TAIL_POLL_MS environment variable (minimum 10ms).

Examples:
  formiga logs-tail              # Follow global events in real-time
  formiga logs-tail 20           # Follow global events, starting with last 20
  formiga logs-tail abc123       # Follow events for run starting with abc123
  formiga logs-tail #3           # Follow events for run #3`;
}

function getControlPlaneStatusHelp(): string {
  return `formiga control-plane status — Show control plane server status

Usage: formiga control-plane status

Reports whether the control plane server is running. When running, it
prints the PID, port, and full endpoint URL. When not running, it prints
the default endpoint that would be used on start.

Examples:
  formiga control-plane status`;
}

function getWorkflowListHelp(): string {
  return `formiga workflow list — List available bundled workflows with descriptions

Usage: formiga workflow list [--json]

Lists all bundled workflows that are available for installation from the
source checkout, showing a one-line description for each. These are the
workflows defined in the workflows/ directory of the Formiga source tree.

Options:
  --json    Output a JSON array of {id, name, description} for programmatic consumption

Examples:
  formiga workflow list
  formiga workflow list --json`;
}

function getWorkflowRunsHelp(): string {
  return `formiga workflow runs — List all workflow runs

Usage: formiga workflow runs

Lists every workflow run in the database with status, workflow ID, token
usage, and a preview of the task description.

Output columns:
  Status    Run status (running, paused, done, failed, canceled)
  Run ID    8-character run identifier prefix
  Workflow  The workflow ID (e.g. feature-dev-merge)
  Tokens    Total tokens spent so far
  Task      Task description preview (truncated at 50 characters)

Examples:
  formiga workflow runs`;
}

function getWorkflowInstallHelp(): string {
  return `formiga workflow install — Install a specific workflow by name

Usage: formiga workflow install <name>

Installs a single bundled workflow by its directory name. This fetches
the workflow YAML spec, provisions agent workspaces (AGENTS.md, IDENTITY.md,
SOUL.md, and any bundled skills), and registers agents in the agent config.

After installation, the workflow is ready to run with:
  formiga workflow run <name> "task description"

Examples:
  formiga workflow install feature-dev-merge`;
}

function getWorkflowUninstallHelp(): string {
  return `formiga workflow uninstall — Uninstall one or all workflows

Usage: formiga workflow uninstall <name> [--force]
       formiga workflow uninstall --all [--force]

Uninstalls a workflow by name, or all workflows when --all is used.

By default, uninstall checks for active runs (running or paused) belonging
to the workflow and refuses if any exist. Use --force to skip this check.

Options:
  --all      Uninstall every installed workflow
  --force    Skip the active-runs check and uninstall anyway

Examples:
  formiga workflow uninstall feature-dev-merge
  formiga workflow uninstall feature-dev-merge --force
  formiga workflow uninstall --all
  formiga workflow uninstall --all --force`;
}

function getWorkflowRunHelp(): string {
  return `formiga workflow run — Start a new workflow run

Usage: formiga workflow run <name> <task> [options]

Starts a new run of the given workflow with the specified task description.
The task is passed to the workflow's agents as their objective.

Options:
  --no-hurry-please-save-tokens-mode
      Run in a token-saving mode where agents poll less frequently.
      Reduces token consumption at the cost of slower progress.
  --working-directory-for-harness <dir>
      Set the working directory for the agent harness during this run.
      Agents will operate within this directory.
  --pi-as-harness
      Use pi as the agent harness (this is the default).
      Mutually exclusive with --hermes-as-harness.
  --hermes-as-harness
      Use hermes as the agent harness instead of pi.
      Mutually exclusive with --pi-as-harness.
  --no-relaunch-upon-rugpull
      Disable automatic replacement-run after a rugpull (base branch move)
      is detected on a failed merge run.

Examples:
  formiga workflow run feature-dev-merge "Add dark mode toggle"
  formiga workflow run feature-dev-merge "Refactor DB layer" \\
      --no-hurry-please-save-tokens-mode
  formiga workflow run feature-dev-merge "Build login page" \\
      --working-directory-for-harness /path/to/project`;
}

function getWorkflowStatusHelp(): string {
  return `formiga workflow status — Show detailed run status with step listing

Usage: formiga workflow status <query>

Shows detailed information about a workflow run, including status, token
usage, and a list of every step with its current status and assigned agent
role.

The query accepts a run-id prefix for matching.

Output includes:
  Run          Run ID (8-char prefix)
  Workflow     Workflow ID
  Task         Full task description
  Status       Current run status
  Tokens       Total tokens spent
  Steps        Per-step listing with step ID, status icon, and agent role

Step status indicators:
  [done   ]    Step completed successfully
  [running]    Step currently being executed
  [failed ]    Step failed (may be retried)
  [pending]    Step waiting to be claimed

Examples:
  formiga workflow status abc12345`;
}

function getWorkflowAutoresearchHelp(): string {
  return `formiga workflow autoresearch — Show AutoResearch progress for a workflow run

Usage: formiga workflow autoresearch <run-id>

Resolves the run's harness working directory, reads its project-local
autoresearch.config.json and autoresearch.jsonl files, then prints the
current metric summary and recent experiment timeline.

Examples:
  formiga workflow autoresearch abc12345`;
}

function getWorkflowDeleteHelp(): string {
  return `formiga workflow delete — Permanently delete a workflow run

Usage: formiga workflow delete <run-id> [--force]

Permanently deletes a workflow run and all associated data, including steps
and stories. The run-id accepts prefix matching.

By default, active runs (running or paused) cannot be deleted — they must
be canceled first. Use --force to cancel and delete an active run in one step.

Options:
  --force    Cancel and delete even if the run is currently running or paused.

Examples:
  formiga workflow delete abc12345
  formiga workflow delete abc12345 --force`;
}

function getWorkflowStopHelp(): string {
  return `formiga workflow stop — Cancel a running workflow

Usage: formiga workflow stop <run-id>

Cancels a running workflow by setting its status to canceled. The run-id
accepts prefix matching.

Active agents associated with the run will see the cancellation on their
next polling cycle.

Examples:
  formiga workflow stop abc12345`;
}

function getWorkflowPauseHelp(): string {
  return `formiga workflow pause — Pause a running workflow

Usage: formiga workflow pause <run-id> [--drain]

Pauses a running workflow via the dashboard daemon. Only runs with status
"running" can be paused. The daemon must be running for this command to work
(start it with \`formiga dashboard start\`).

When paused, agents stop polling and active work sessions are interrupted.
Paused runs can be resumed later with \`formiga workflow resume\`.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately.

Examples:
  formiga workflow pause abc12345
  formiga workflow pause abc12345 --drain`;
}

function getWorkflowResumeHelp(): string {
  return `formiga workflow resume — Resume a paused or failed workflow run

Usage: formiga workflow resume <run-id>

Resumes a workflow run that is paused or has failed. The run-id accepts
prefix matching.

Behavior by status:
  paused    Connects to the dashboard daemon and resumes agent polling.
            The daemon must be running for this to work.
  failed    Restarts the run from the failed step, creating a new run
            entry. The daemon is notified of the new run automatically.
  Other     Terminal runs (completed, canceled) cannot be resumed.
            Runs with status "running" are already active and do not
            need to be resumed.

Examples:
  formiga workflow resume abc12345       # Resume a paused run
  formiga workflow resume abc12345       # Re-start a failed run`;
}

function getWorkflowPauseAllHelp(): string {
  return `formiga workflow pause-all — Pause all running workflows

Usage: formiga workflow pause-all [--drain]

Pauses every workflow run currently in "running" status. Uses the dashboard
daemon to pause each run. If the daemon is unreachable for a specific run,
a warning is printed and that run is skipped.

Options:
  --drain    Let in-flight agent sessions complete before pausing, rather
             than interrupting them immediately. Applies to all runs.

Examples:
  formiga workflow pause-all
  formiga workflow pause-all --drain`;
}

function getWorkflowResumeAllHelp(): string {
  return `formiga workflow resume-all — Resume all paused workflows

Usage: formiga workflow resume-all

Resumes every workflow run currently in "paused" status. Uses the dashboard
daemon to resume agent polling for each run. If the daemon is unreachable
for a specific run, a warning is printed and that run is skipped.

Only paused runs are resumed; failed runs are not resumed by this command
(use \`formiga workflow resume <run-id>\` for individual failed runs).

Examples:
  formiga workflow resume-all`;
}

function getWorkflowGroupHelp(): string {
  return `formiga workflow — Manage workflows and runs

Usage: formiga workflow <list|runs|install|uninstall|run|status|autoresearch|stop|delete|pause|resume|pause-all|resume-all>

Commands for managing Formiga workflows and their runs.

Subcommands:
  list        List available bundled workflows
  runs        List all workflow runs with status, tokens, task preview
  install     Install a specific workflow by name
  uninstall   Uninstall a workflow (--all for all workflows, --force to skip
              active-runs check)
  run         Start a new workflow run with the given task
  status      Show detailed run status with step listing
  autoresearch
              Show AutoResearch progress for a run
  stop        Cancel a running workflow
  delete      Permanently delete a run and all its data (--force for active runs)
  pause       Pause a running workflow via the daemon
  resume      Resume a paused or failed workflow run
  pause-all   Pause all running workflows
  resume-all  Resume all paused workflows

Examples:
  formiga workflow list
  formiga workflow runs
  formiga workflow install feature-dev-merge
  formiga workflow run feature-dev-merge "Add a new feature"
  formiga workflow status abc12345
  formiga workflow autoresearch abc12345
  formiga workflow pause abc12345 --drain`;
}

function getNudgeHelp(): string {
  return `formiga nudge — Wake all scheduled agents for running runs

Usage: formiga nudge

Wakes all scheduled agents for all currently running runs, causing them to
poll once immediately without waiting for their normal timers. Does not
resume paused runs or interrupt in-flight agents.

Examples:
  formiga nudge            # Nudge all scheduled agents for active runs`;
}

function getAutoresearchHelp(): string {
  return `formiga autoresearch — Run durable optimization experiment loops

Usage: formiga autoresearch <init|run-experiment|log-experiment|status|next|loop|prune>

AutoResearch stores a project-local session in:
  autoresearch.config.json   Session configuration
  autoresearch.md            Agent-facing objective and loop contract
  autoresearch.jsonl         Append-only experiment history
  autoresearch.sh            Benchmark command
  autoresearch.checks.sh     Optional correctness checks

Subcommands:
  init            Create a new AutoResearch session
  run-experiment  Run the configured experiment command and append a measured result
  log-experiment  Log the keep/discard decision, learning, and next focus
  loop            Run a bounded experiment loop with live terminal progress
  run-loop-iteration
                  Run a single transactional experiment iteration
  status          Summarize baseline, best run, failures, and next prompt
  next            Print the ratchet prompt for the next experiment
  prune           Remove stale AutoResearch registry rows from SQLite (DB only)
  wizard          Interactive setup wizard that guides you through creating
                  an AutoResearch command sequence

Examples:
  formiga autoresearch init --goal "reduce validation loss" --metric val_bpb --direction lower --command "uv run train.py"
  formiga autoresearch run-experiment
  formiga autoresearch log-experiment --status auto --description "try smaller LR" --learned "stable but slower" --next-focus "test warmup"
  formiga autoresearch prune --older-than 30d`;
}

function getAutoresearchInitHelp(): string {
  return `formiga autoresearch init — Create an AutoResearch session

Usage: formiga autoresearch init --goal <text> --metric <name> --direction <lower|higher> --command <cmd> [options]

Options:
  --unit <unit>             Metric unit, such as seconds, bpb, auc, or ms
  --metric-regex <regex>    Regex with the metric value in capture group 1
  --checks-command <cmd>    Correctness command to run after successful benchmarks
  --cwd <dir>               Project directory (default: current directory)
  --overwrite               Replace existing autoresearch files

Examples:
  formiga autoresearch init --goal "speed up tests" --metric total_ms --unit ms --direction lower --command "pnpm test --run"`;
}

function getAutoresearchRunExperimentHelp(): string {
  return `formiga autoresearch run-experiment — Execute the current experiment

Usage: formiga autoresearch run-experiment [options]

Runs the configured command, captures stdout/stderr tails, parses the metric,
runs optional checks, and appends a run_result entry to autoresearch.jsonl.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --command <cmd>           Override the configured command for this run
  --metric-regex <regex>    Override metric parser for this run
  --checks-command <cmd>    Override or provide correctness checks
  --timeout-seconds <n>     Command timeout (default: 1800)

Examples:
  formiga autoresearch run-experiment
  formiga autoresearch run-experiment --metric-regex "val_bpb=([0-9.]+)"`;
}

function getAutoresearchLogExperimentHelp(): string {
  return `formiga autoresearch log-experiment — Record experiment learning and decision

Usage: formiga autoresearch log-experiment --description <text> [options]

By default --status auto classifies the latest measured result as baseline,
keep, discard, crash, or checks_failed by comparing it with prior accepted
runs in autoresearch.jsonl.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --status <status>         auto, baseline, keep, discard, crash, checks_failed
  --metric <number>         Metric value if no latest run_result should be used
  --description <text>      What changed in this experiment
  --hypothesis <text>       Hypothesis tested
  --learned <text>          Evidence learned from the result
  --next-focus <text>       Next experiment direction
  --commit                  Commit kept/baseline results with git
  --revert-discard          Revert non-autoresearch tracked files on discard

Examples:
  formiga autoresearch log-experiment --status auto --description "cache parser" --learned "faster but flaky" --next-focus "fix invalidation"`;
}

function getAutoresearchStatusHelp(): string {
  return `formiga autoresearch status — Summarize the experiment loop

Usage: formiga autoresearch status [--cwd <dir>]

Shows baseline, best result, keep/discard counts, failure counts, and the
ratchet prompt for the next experiment.

Examples:
  formiga autoresearch status`;
}

function getAutoresearchNextHelp(): string {
  return `formiga autoresearch next — Print the next experiment prompt

Usage: formiga autoresearch next [--cwd <dir>]

Prints the evidence-driven prompt that agents should read before proposing
the next experiment. This is the ratchet: use prior results before editing.

Examples:
  formiga autoresearch next`;
}

function getAutoresearchLoopHelp(): string {
  return `formiga autoresearch loop — Run a bounded experiment loop

Usage: formiga autoresearch loop [options]

Runs a bounded AutoResearch experiment loop. An action mode is REQUIRED —
the loop will fail without one.

Action modes:
  --measure-only    Repeated benchmark only (no optimization). Honest measurement;
                    no code/config changes between iterations.
  --prompt          pi-driven optimization. Between iterations, spawns pi to make
                    one small code change guided by AutoResearch history.

Options:
  --target-metric <number>        Stop loop when the target metric is reached
                                  (compared via the configured direction)
  --max-iterations <number>       Maximum number of iterations (default: 20)
  --max-consecutive-failures <n>  Stop after N consecutive failures (default: 3)
  --timeout <duration>            Per-pi-action timeout (default: 5m). Format: <number><s|m|h>
                                  (e.g. 300s, 10m, 1h)
  --cwd <dir>                     Project directory (default: current directory)

Stop conditions (the loop stops when any one is met):
  - Target metric reached (requires --target-metric or config target)
  - Max iterations reached (--max-iterations)
  - Too many consecutive failures (--max-consecutive-failures)
  - User cancels with Ctrl-C / SIGINT

Progress display shows for each iteration:
  [measure-only] or [prompt] label, [N/MAX] iteration number, current focus,
  measured metric, decision (keep/discard/crash), best metric (loop + all-time),
  failure count, and stop reason.

After the loop ends, a final summary prints: total iterations, best
metric (this loop and all-time), best run number, and kept/discarded/crashed counts.

Cancellation (Ctrl-C / SIGINT) prints the last completed iteration info
and leaves autoresearch.jsonl in a consistent state.

Examples:
  formiga autoresearch loop --measure-only --max-iterations 10
  formiga autoresearch loop --prompt --target-metric 0.5 --max-iterations 30
  formiga autoresearch loop --prompt --max-consecutive-failures 5
  formiga autoresearch loop --prompt --timeout 10m --max-iterations 10`;
}

function getAutoresearchRunLoopIterationHelp(): string {
  return `formiga autoresearch run-loop-iteration — Run a transactional experiment iteration

Usage: formiga autoresearch run-loop-iteration [options]

Runs a single transactional AutoResearch experiment iteration. The iteration
follows this lifecycle:

  1. If --prompt is provided, invokes pi to make one candidate code change.
  2. Runs the configured experiment command and measures the metric.
  3. Logs the result to autoresearch.jsonl:
     - keep/baseline results are committed (autoresearch* files excluded).
     - discard results are reverted (candidate changes rolled back).
     - crash/checks_failed results are reverted.
  4. Ensures the working tree has no dirty non-autoresearch files.

Options:
  --cwd <dir>               Project directory (default: current directory)
  --prompt <text>           pi agent prompt for code change (optional)
  --command <cmd>           Override the configured experiment command
  --timeout <duration>      Per-pi-action timeout (default: 5m). Format: <number><s|m|h>
                            (e.g. 300s, 10m, 1h)
  --iteration <n>           Iteration number (for logging)
  --description <text>      Description of the experiment

Output:
  JSON object with run number, status, metric, agent success,
  committed/reverted flags, and the full log entry.

Examples:
  formiga autoresearch run-loop-iteration --prompt "try smaller LR" --iteration 1
  formiga autoresearch run-loop-iteration --command "uv run train.py" --iteration 5
  formiga autoresearch run-loop-iteration --prompt test --iteration 1`;
}

function getAutoresearchPruneHelp(): string {
  return `formiga autoresearch prune — Remove stale AutoResearch registry rows

Usage: formiga autoresearch prune --older-than <duration> [--missing] [--dry-run]

Prunes (removes) stale autoresearch_sessions registry rows from the SQLite DB.
This never touches project-local autoresearch.jsonl or config files — those
remain safe on disk.

Options:
  --older-than <d>   Prune sessions older than the given duration (required).
  --missing          Only prune sessions whose cwd/config/log files no longer exist.
  --dry-run          Print what would be pruned without actually deleting anything.

Duration format:
  Duration is specified as a number followed by a unit letter:
    d — days   (e.g. 30d = 30 days)
    h — hours  (e.g. 24h = 24 hours)
    m — minutes(e.g. 30m = 30 minutes)

Examples:
  formiga autoresearch prune --older-than 30d
  formiga autoresearch prune --older-than 7d --missing
  formiga autoresearch prune --older-than 30d --dry-run`;
}

function getAutoresearchWizardHelp(): string {
  return `formiga autoresearch wizard — Interactive AutoResearch setup wizard

Usage: formiga autoresearch wizard [--cwd <dir>]

Launches an interactive wizard that guides you through setting up an
AutoResearch session. The wizard asks questions about what you want to
improve and how to measure success, then generates the exact Formiga
command sequence you need.

The wizard does not directly create project files. If initialization is
needed, it generates and optionally executes the correct formiga
autoresearch init command. Then it generates the formiga autoresearch
loop command to start the optimization loop.

Options:
  --cwd <dir>    Working directory (default: current directory)

Examples:
  formiga autoresearch wizard
  formiga autoresearch wizard --cwd /path/to/project`;
}

function getUsageText(): string {
  return [
    "Run formiga <command> --help for detailed command help.",
    "",
    "formiga get-ready                    Install bundled workflows and start dashboard/control plane",
    "formiga uninstall [--force]          Full uninstall",
    "formiga status                       Show detailed system status (services, paths, runs, processes)",
    "", "formiga workflow list                List available workflows",
    "formiga workflow install <name|--all>  Install a workflow (or all)",
    "formiga workflow run <name> <task> [--no-hurry-please-save-tokens-mode]",
    "                                      [--working-directory-for-harness <dir>]",
    "                                      [--pi-as-harness | --hermes-as-harness]",
    "                                      [--no-relaunch-upon-rugpull]",
    "                                      Start a workflow run",
    "", "formiga autoresearch init            Create durable experiment-loop state",
    "formiga autoresearch run-experiment  Run the configured experiment command",
    "formiga autoresearch log-experiment   Log keep/discard learning for the loop",
    "formiga autoresearch loop            Run a bounded experiment loop with live progress",
    "formiga autoresearch run-loop-iteration Run a single transactional experiment iteration",
    "formiga autoresearch status          Summarize AutoResearch state",
    "formiga autoresearch next            Print the next experiment prompt",
    "formiga autoresearch prune           Remove stale AutoResearch registry rows",
    "           --older-than <duration>    (e.g. 30d, 7d, 24h)",
    "formiga autoresearch wizard          Interactive AutoResearch setup wizard",
    "formiga workflow autoresearch <run-id> Show run AutoResearch progress",
    "formiga workflow status <query>      Check run status",
    "formiga workflow runs                List all workflow runs",
    "formiga workflow pause <run-id>      Pause a running workflow",
    "formiga workflow pause-all [--drain]  Pause all running workflows",
    "formiga workflow resume <run-id>     Resume a paused or failed run",
    "formiga workflow resume-all           Resume all paused workflows",
    "formiga workflow stop <run-id>       Stop/cancel a running workflow",
    "formiga workflow delete <run-id>     Permanently delete a run [--force]",
    "formiga control-plane start [--port N]Start control plane (default: 3339)",
    "formiga control-plane stop            Stop control plane",
    "formiga control-plane status          Check control plane status",
    "", "formiga dashboard [start] [--port N] Start dashboard (default: 3334)",
    "formiga dashboard stop               Stop dashboard",
    "formiga dashboard status             Check dashboard status",
    "", "formiga step peek <agent-id> --run-id <run-id>     Check for pending work (HAS_WORK or NO_WORK)",
    "formiga step claim <agent-id> --run-id <run-id>    Claim pending step (JSON output)",
    "formiga step complete <step-id>      Complete step (reads output from stdin)",
    "formiga step fail <step-id> <error>  Fail step with retry logic",
    "formiga step stories <run-id>        List stories for a run",
    "", "formiga logs [<lines>|<run-id>|#<run-number>] Show recent activity",
    "formiga logs-tail [<lines>|<run-id>|#<run-number>] Follow recent activity",
    "", "formiga version                      Show installed version",
    "formiga skill-path                  Print path to the bundled formiga-agents skill",
    "formiga source-path                  Print source checkout path",
    "formiga nudge                       Wake all scheduled agents for all running runs",
  ].join("\n") + "\n";
}

function printUsage() {
  process.stdout.write(getUsageText());
}

async function main() {
  const args = process.argv.slice(2);
  const [group, action, target] = args;

  // Check for --help before anything else: display command-specific help
  // if recognized, otherwise show global usage.
  if (hasHelpFlag(args)) {
    if (group === "version" || group === "--version" || group === "-v") {
      printHelp(getVersionHelp());
    }
    if (group === "skill-path") {
      printHelp(getSkillPathHelp());
    }
    if (group === "source-path") {
      printHelp(getSourcePathHelp());
    }
    if (group === "get-ready") {
      printHelp(getGetReadyHelp());
    }
    if (group === "uninstall") {
      printHelp(getUninstallHelp());
    }
    if (group === "status") {
      printHelp(getStatusHelp());
    }
    if (group === "dashboard") {
      if (action === "start") { printHelp(getDashboardStartHelp()); }
      if (action === "stop") { printHelp(getDashboardStopHelp()); }
      if (action === "status") { printHelp(getDashboardStatusHelp()); }
      printHelp(getDashboardHelp());
    }
    if (group === "control-plane") {
      if (action === "start") { printHelp(getControlPlaneStartHelp()); }
      if (action === "stop") { printHelp(getControlPlaneStopHelp()); }
      if (action === "status") { printHelp(getControlPlaneStatusHelp()); }
      printHelp(getControlPlaneHelp());
    }
    if (group === "step") {
      if (action === "peek") { printHelp(getStepPeekHelp()); }
      if (action === "claim") { printHelp(getStepClaimHelp()); }
      if (action === "complete") { printHelp(getStepCompleteHelp()); }
      if (action === "fail") { printHelp(getStepFailHelp()); }
      if (action === "stories") { printHelp(getStepStoriesHelp()); }
    }
    if (group === "logs") {
      printHelp(getLogsHelp());
    }
    if (group === "logs-tail") {
      printHelp(getLogsTailHelp());
    }
    if (group === "workflow") {
      if (action === "list") { printHelp(getWorkflowListHelp()); }
      if (action === "runs") { printHelp(getWorkflowRunsHelp()); }
      if (action === "install") { printHelp(getWorkflowInstallHelp()); }
      if (action === "uninstall") { printHelp(getWorkflowUninstallHelp()); }
      if (action === "run") { printHelp(getWorkflowRunHelp()); }
      if (action === "status") { printHelp(getWorkflowStatusHelp()); }
      if (action === "autoresearch") { printHelp(getWorkflowAutoresearchHelp()); }
      if (action === "delete") { printHelp(getWorkflowDeleteHelp()); }
      if (action === "stop") { printHelp(getWorkflowStopHelp()); }
      if (action === "pause") { printHelp(getWorkflowPauseHelp()); }
      if (action === "resume") { printHelp(getWorkflowResumeHelp()); }
      if (action === "pause-all") { printHelp(getWorkflowPauseAllHelp()); }
      if (action === "resume-all") { printHelp(getWorkflowResumeAllHelp()); }
      printHelp(getWorkflowGroupHelp());
    }
    if (group === "autoresearch") {
      if (action === "init") { printHelp(getAutoresearchInitHelp()); }
      if (action === "run-experiment") { printHelp(getAutoresearchRunExperimentHelp()); }
      if (action === "log-experiment") { printHelp(getAutoresearchLogExperimentHelp()); }
      if (action === "status") { printHelp(getAutoresearchStatusHelp()); }
      if (action === "next") { printHelp(getAutoresearchNextHelp()); }
      if (action === "loop") { printHelp(getAutoresearchLoopHelp()); }
      if (action === "run-loop-iteration") { printHelp(getAutoresearchRunLoopIterationHelp()); }
      if (action === "prune") { printHelp(getAutoresearchPruneHelp()); }
      if (action === "wizard") { printHelp(getAutoresearchWizardHelp()); }
      printHelp(getAutoresearchHelp());
    }
    if (group === "nudge") {
      printHelp(getNudgeHelp());
    }
    printHelp(getUsageText());
  }

  if (group === "version" || group === "--version" || group === "-v") {
    console.log(getVersion()); return;
  }
  if (group === "skill-path") {
    console.log(resolveSkillPath()); return;
  }

  if (group === "source-path") {
    console.log(resolveSourcePath()); return;
  }

  if (group === "uninstall" && (!args[1] || args[1] === "--force")) {
    const force = args.includes("--force");
    const activeRuns = await checkActiveRuns();
    if (activeRuns.length > 0 && !force) {
      process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`);
      for (const run of activeRuns) process.stderr.write(`  - ${run.id}: ${run.task}\n`);
      process.stderr.write(`\nUse --force to uninstall anyway.\n`); process.exit(1);
    }
    if (isRunning().running) { stopDaemon(); console.log("Dashboard stopped."); }
    await uninstallAllWorkflows();
    console.log("Formiga fully uninstalled."); return;
  }

  if (group === "get-ready" && !args[1]) {
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) { console.log("No bundled workflows found."); return; }
    console.log(`Installing ${workflows.length} workflow(s)...`);
    for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); } }
    console.log(`\nDone. Start with: formiga workflow run <name> "your task"`);
    if (!isRunning().running) { try { const r = await startDaemon(3334); console.log(`\nDashboard started (PID ${r.pid}): http://localhost:${r.port}`); } catch (err) { console.log(`\nNote: dashboard not started: ${err instanceof Error ? err.message : String(err)}`); } }
    else console.log("\nDashboard already running.");
    return;
  }

  if (group === "dashboard") {
    const sub = args[1];
    if (sub === "stop") { console.log(stopDaemon() ? "Dashboard stopped." : "Dashboard is not running."); return; }
    if (sub === "status") {
      const st = getDaemonStatus();

      if (!st.running) {
        console.log("Dashboard is not running.");
      } else {
        console.log(`Dashboard running (PID ${st.pid})`);
        console.log(`Dashboard endpoint: http://localhost:${st.port}`);
      }
      return;
    }
    let port = 3334; const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) port = parseInt(args[portIdx + 1], 10) || 3334;
    else if (sub && sub !== "start" && !sub.startsWith("-")) { const p = parseInt(sub, 10); if (!Number.isNaN(p)) port = p; }
    if (isRunning().running) { const status = getDaemonStatus(); if (status.running) console.log(`Dashboard already running (PID ${status.pid})`); console.log(`  http://localhost:${port}`); return; }
    const result = await startDaemon(port); console.log(`Dashboard started (PID ${result.pid})\n  http://localhost:${result.port}`); return;
  }

  if (group === "nudge") {
    if (args.length > 1) {
      process.stderr.write(`Unknown nudge option: ${args.slice(1).join(" ")}\nUsage: formiga nudge\n`);
      process.exit(1);
    }
    let response = await nudgeWithDaemon();
    if (response === null) {
      process.stderr.write("Failed to nudge: control plane is not reachable.\n");
      process.exit(1);
    }
    if (response.status !== 200) {
      const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
      process.stderr.write(`Failed to nudge: ${errMsg}\n`);
      process.exit(1);
    }
    const body = response.body;
    const runningRuns = typeof body.runningRuns === "number" ? body.runningRuns : 0;
    if (runningRuns === 0) {
      console.log("No running Formiga runs to nudge.");
      return;
    }
    const launched = typeof body.launched === "number" ? body.launched : 0;
    const skippedInFlight = typeof body.skippedInFlight === "number" ? body.skippedInFlight : 0;
    console.log(`Nudged ${runningRuns} running run(s): launched ${launched} agent(s), skipped ${skippedInFlight} in-flight.`);
    return;
  }

  if (group === "control-plane") {
    const sub = args[1];
    if (sub === "stop") {
      console.log(stopControlPlane() ? "Control plane stopped." : "Control plane is not running.");
      return;
    }
    if (sub === "status") {
      const st = getControlPlaneStatus();
      if (!st.running) {
        console.log("Control plane is not running.");
        console.log(`Default endpoint: http://localhost:${st.port}${st.endpoint}`);
        return;
      }
      console.log(`Control plane running (PID ${st.pid})`);
      console.log(`Port: ${st.port}`);
      console.log(`Endpoint: http://localhost:${st.port}${st.endpoint}`);
      return;
    }
    let port = DEFAULT_CONTROL_PORT;
    const portIdx = args.indexOf("--port");
    if (portIdx !== -1 && args[portIdx + 1]) {
      port = parseInt(args[portIdx + 1], 10) || DEFAULT_CONTROL_PORT;
    }
    // Support positional port as well: formiga control-plane start 4444
    if (sub && sub !== "start" && !sub.startsWith("-")) {
      const p = parseInt(sub, 10);
      if (!Number.isNaN(p)) port = p;
    } else if (target && !target.startsWith("-")) {
      const p = parseInt(target, 10);
      if (!Number.isNaN(p)) port = p;
    }
    const running = getControlPlaneStatus();
    if (running.running) {
      console.log(`Control plane already running (PID ${running.pid})`);
      console.log(`Port: ${running.port}`);
      console.log(`Endpoint: http://localhost:${running.port}${running.endpoint}`);
      return;
    }
    try {
      const result = await startControlPlane(port);
      const label = result.alreadyRunning ? "already running" : "started";
      console.log(`Control plane ${label}${result.pid > 0 ? ` (PID ${result.pid})` : ""}`);
      console.log(`Endpoint: http://localhost:${result.port}${getControlPlaneStatus().endpoint}`);
    } catch (err) {
      process.stderr.write(`Failed to start control plane: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }

  if (group === "step") {
    if (action === "peek" || action === "claim") {
      if (!target) { process.stderr.write(`Missing agent-id.\nUsage: formiga step ${action} <agent-id> --run-id <run-id>\n`); process.exit(1); }
      // --run-id is required for peek/claim so concurrent runs of the same
      // workflow + agent can't cross-claim. No implicit inference — the
      // caller (typically the polling prompt) must pass it.
      let runIdArg: string | undefined;
      const remainder = args.slice(3);
      for (let i = 0; i < remainder.length; i++) {
        const tok = remainder[i];
        if (tok === "--run-id") { runIdArg = remainder[i + 1]?.trim(); i++; continue; }
        const inline = "--run-id=";
        if (tok.startsWith(inline)) { runIdArg = tok.slice(inline.length).trim(); }
      }
      if (!runIdArg) {
        process.stderr.write(
          `Missing --run-id for step ${action}.\nUsage: formiga step ${action} <agent-id> --run-id <run-id>\n`,
        );
        process.exit(1);
      }
      if (action === "peek") {
        console.log(peekStep(target, runIdArg));
        return;
      }
      const jobId = process.env.FORMIGA_WORKER_JOB_ID;
      const pidStr = process.env.FORMIGA_WORKER_PID;
      const pgidStr = process.env.FORMIGA_WORKER_PGID;
      const workerOwnership = (jobId && pidStr)
        ? { jobId, pid: Number(pidStr), ...(pgidStr ? { pgid: Number(pgidStr) } : {}) }
        : undefined;
      const r = claimStep(target, runIdArg, workerOwnership);
      console.log(r.found ? JSON.stringify({ stepId: r.stepId, runId: r.runId, input: r.resolvedInput }) : "NO_WORK");
      return;
    }
    if (action === "complete") { if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); } let output = args.slice(3).join(" ").trim(); if (!output) { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c); output = Buffer.concat(chunks).toString("utf-8").trim(); } console.log(JSON.stringify(completeStep(target, output))); return; }
    if (action === "fail") { if (!target) { process.stderr.write("Missing step-id.\n"); process.exit(1); } console.log(JSON.stringify(await failStep(target, args.slice(3).join(" ").trim() || "Unknown error"))); return; }
    if (action === "stories") { if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); } const fullRunId = getWorkflowStatus(target).id; const stories = getStories(fullRunId); if (stories.length === 0) { console.log("No stories found."); return; } for (const s of stories) console.log(`${s.storyId.padEnd(8)} [${s.status.padEnd(7)}] ${s.title}${s.retryCount > 0 ? ` (retry ${s.retryCount})` : ""}`); return; }
    process.stderr.write(`Unknown step action: ${action}\n`); process.exit(1);
  }

  if (group === "logs") {
    const selector = parseLogsSelector(args[1]);

    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      printEvents(getRecentEvents(selector.limit));
      return;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (runId) {
        const events = getRunEvents(runId);
        events.length === 0 ? console.log(`No events for run #${selector.runNumber}.`) : printEvents(events);
        return;
      }

      const fallbackEvents = getRunEvents(selector.raw);
      fallbackEvents.length === 0 ? console.log(`No run #${selector.runNumber}.`) : printEvents(fallbackEvents);
      return;
    }

    let runId: string;
    try {
      runId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      console.log(err instanceof Error ? err.message : `No run found matching "${selector.runId}".`);
      return;
    }
    const events = getRunEvents(runId);
    events.length === 0 ? console.log(`No events for run "${selector.runId}".`) : printEvents(events);
    return;
  }

  if (group === "logs-tail") {
    const selector = parseLogsSelector(args[1]);

    if (selector.kind === "global-recent" || selector.kind === "global-limit") {
      await streamEventSource({ kind: "global" }, selector.limit);
      return;
    }

    if (selector.kind === "run-number") {
      const runId = lookupRunIdByNumber(selector.runNumber);
      if (!runId) {
        console.log(`No run #${selector.runNumber}.`);
        return;
      }
      await streamEventSource({ kind: "run", runId }, 50);
      return;
    }

    let logsTailRunId: string;
    try {
      logsTailRunId = getWorkflowStatus(selector.runId).id;
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${selector.runId}".`;
      // The DB row may lag behind the events file in early bootstrap (events
      // can be written before the run row is committed). If the literal runId
      // already has an events file on disk, tail it; otherwise fall through
      // to the not-found message so unknown prefixes don't hang forever.
      if (message.startsWith("No run found matching")) {
        const { getEventsPath } = await import("../installer/events.js");
        const fsMod = await import("node:fs");
        const pathMod = await import("node:path");
        const eventsFile = pathMod.join(getEventsPath(), `${selector.runId}.jsonl`);
        if (fsMod.existsSync(eventsFile)) {
          await streamEventSource({ kind: "run", runId: selector.runId }, 50);
          return;
        }
      }
      console.log(message);
      return;
    }
    await streamEventSource({ kind: "run", runId: logsTailRunId }, 50);
    return;
  }

  if (group === "autoresearch") {
    const cwd = readOption(args, "--cwd");
    if (action === "init") {
      const usage = "formiga autoresearch init --goal <text> --metric <name> --direction <lower|higher> --command <cmd>";
      const entry = initExperiment({
        cwd,
        goal: requireOption(args, "--goal", usage),
        metricName: requireOption(args, "--metric", usage),
        metricUnit: readOption(args, "--unit"),
        direction: parseDirection(requireOption(args, "--direction", usage)),
        command: requireOption(args, "--command", usage),
        metricRegex: readOption(args, "--metric-regex"),
        checksCommand: readOption(args, "--checks-command"),
        overwrite: args.includes("--overwrite"),
      });
      console.log(`Initialized AutoResearch session for metric ${entry.metric_name} (${entry.direction}).`);
      console.log("Next: formiga autoresearch run-experiment");
      upsertAutoresearchSession(cwd ?? process.cwd());
      return;
    }

    if (action === "run-experiment") {
      const timeoutSecondsRaw = readOption(args, "--timeout-seconds");
      const timeoutMs = timeoutSecondsRaw ? Math.max(1, Number(timeoutSecondsRaw)) * 1000 : undefined;
      if (timeoutSecondsRaw && !Number.isFinite(timeoutMs)) {
        process.stderr.write(`Invalid --timeout-seconds "${timeoutSecondsRaw}".\n`);
        process.exit(1);
      }
      const result = await runExperiment({
        cwd,
        command: readOption(args, "--command"),
        metricRegex: readOption(args, "--metric-regex"),
        checksCommand: readOption(args, "--checks-command"),
        timeoutMs,
      });
      console.log(JSON.stringify(result, null, 2));
      upsertAutoresearchSession(cwd ?? process.cwd());
      return;
    }

    if (action === "log-experiment") {
      const metricRaw = readOption(args, "--metric");
      const metric = metricRaw === undefined ? undefined : Number(metricRaw);
      if (metricRaw !== undefined && !Number.isFinite(metric)) {
        process.stderr.write(`Invalid --metric "${metricRaw}".\n`);
        process.exit(1);
      }
      const usage = "formiga autoresearch log-experiment --description <text>";
      const entry = await logExperiment({
        cwd,
        metric,
        status: parseAutoresearchDecision(readOption(args, "--status")) ?? "auto",
        description: requireOption(args, "--description", usage),
        hypothesis: readOption(args, "--hypothesis"),
        learned: readOption(args, "--learned"),
        nextFocus: readOption(args, "--next-focus"),
        commit: args.includes("--commit"),
        revertDiscard: args.includes("--revert-discard"),
      });
      console.log(`Logged run ${entry.run}: ${entry.status}${entry.metric === null ? "" : ` (${entry.metric})`}.`);
      console.log(`Best: ${entry.best_metric ?? "(none)"}`);
      console.log(`Confidence: ${formatAutoresearchConfidence(entry)}`);
      upsertAutoresearchSession(cwd ?? process.cwd());
      return;
    }

    if (action === "status") {
      upsertAutoresearchSession(cwd ?? process.cwd());
      printAutoresearchSummary(cwd);
      return;
    }

    if (action === "next") {
      upsertAutoresearchSession(cwd ?? process.cwd());
      console.log(summarizeAutoresearch(cwd).nextPrompt);
      return;
    }

    if (action === "loop") {
      const targetMetricRaw = readOption(args, "--target-metric");
      const targetMetric = targetMetricRaw !== undefined ? Number(targetMetricRaw) : undefined;
      if (targetMetricRaw !== undefined && !Number.isFinite(targetMetric)) {
        process.stderr.write(`Invalid --target-metric "${targetMetricRaw}".\n`);
        process.exit(1);
      }
      const maxIterRaw = readOption(args, "--max-iterations");
      const maxIterations = maxIterRaw !== undefined ? Math.max(1, parseInt(maxIterRaw, 10)) : undefined;
      if (maxIterRaw !== undefined && !Number.isFinite(maxIterations)) {
        process.stderr.write(`Invalid --max-iterations "${maxIterRaw}".\n`);
        process.exit(1);
      }
      const maxFailRaw = readOption(args, "--max-consecutive-failures");
      const maxConsecutiveFailures = maxFailRaw !== undefined ? Math.max(1, parseInt(maxFailRaw, 10)) : undefined;
      if (maxFailRaw !== undefined && !Number.isFinite(maxConsecutiveFailures)) {
        process.stderr.write(`Invalid --max-consecutive-failures "${maxFailRaw}".\n`);
        process.exit(1);
      }
      const timeoutRaw = readOption(args, "--timeout");
      let timeoutSeconds: number | undefined;
      if (timeoutRaw !== undefined) {
        try {
          timeoutSeconds = Math.floor(parseDuration(timeoutRaw) / 1000);
          if (timeoutSeconds <= 0) {
            process.stderr.write(`Invalid --timeout "${timeoutRaw}": must be a positive number.\n`);
            process.exit(1);
          }
        } catch (err) {
          process.stderr.write(`Invalid --timeout "${timeoutRaw}": ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      }
      const isMeasureOnly = args.includes("--measure-only");
      const isPrompt = args.includes("--prompt");
      if (!isMeasureOnly && !isPrompt) {
        process.stderr.write(
          "No action mode specified. Use --measure-only for repeated benchmarks (no optimization) or --prompt for pi-driven optimization.\n",
        );
        process.exit(1);
      }
      if (isMeasureOnly && isPrompt) {
        process.stderr.write("Can only specify one action mode at a time (--measure-only or --prompt).\n");
        process.exit(1);
      }
      const actionMode = isMeasureOnly ? "measure-only" : "prompt";
      upsertAutoresearchSession(cwd ?? process.cwd());
      await loopAutoresearch({ cwd, targetMetric, maxIterations, maxConsecutiveFailures, actionMode, timeoutSeconds });
      return;
    }

    if (action === "prune") {
      const olderThanIdx = args.indexOf("--older-than");
      if (olderThanIdx === -1 || !args[olderThanIdx + 1]) {
        process.stderr.write(
          "Missing --older-than <duration>.\nUsage: formiga autoresearch prune --older-than <duration> [--missing] [--dry-run]\n",
        );
        process.exit(1);
      }

      let thresholdMs: number;
      try {
        thresholdMs = parseDuration(args[olderThanIdx + 1]);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      }

      const dryRun = args.includes("--dry-run");
      const missingOnly = args.includes("--missing");
      const cutoff = new Date(Date.now() - thresholdMs).toISOString();

      const { getAutoresearchSessions, deleteAutoresearchSession } = await import("../db.js");
      const sessions = getAutoresearchSessions({ includeMissing: true });

      const candidates = sessions.filter((s) => {
        // Check if session is older than threshold
        const updatedAt = s.updated_at;
        if (!updatedAt || updatedAt >= cutoff) return false;

        // If --missing, only include sessions whose files are gone
        if (missingOnly && !s.files_missing) return false;

        return true;
      });

      if (candidates.length === 0) {
        console.log("No sessions to prune.");
        return;
      }

      for (const s of candidates) {
        const reasonParts: string[] = [];
        if (s.files_missing) reasonParts.push("missing files");
        reasonParts.push(`last seen ${s.last_seen_at ?? "never"}`);
        const reason = reasonParts.join(", ");

        if (dryRun) {
          console.log(
            `[DRY RUN] Would prune: ${s.cwd} (${s.metric_name ?? "unknown metric"}) — ${reason}`,
          );
        } else {
          deleteAutoresearchSession(s.id);
          console.log(
            `Pruned: ${s.cwd} (${s.metric_name ?? "unknown metric"}) — ${reason}`,
          );
        }
      }

      if (dryRun) {
        console.log(`\nDry run: ${candidates.length} session(s) would be pruned.`);
      } else {
        console.log(`\nPruned ${candidates.length} session(s).`);
      }
      return;
    }

    if (action === "run-loop-iteration") {
      const timeoutRaw = readOption(args, "--timeout");
      let timeoutSeconds: number | undefined;
      if (timeoutRaw !== undefined) {
        try {
          timeoutSeconds = Math.floor(parseDuration(timeoutRaw) / 1000);
          if (timeoutSeconds <= 0) {
            process.stderr.write(`Invalid --timeout "${timeoutRaw}": must be a positive number.\n`);
            process.exit(1);
          }
        } catch (err) {
          process.stderr.write(`Invalid --timeout "${timeoutRaw}": ${err instanceof Error ? err.message : String(err)}\n`);
          process.exit(1);
        }
      }
      const iterationRaw = readOption(args, "--iteration");
      const iteration = iterationRaw !== undefined ? Math.max(1, parseInt(iterationRaw, 10)) : undefined;
      if (iterationRaw !== undefined && !Number.isFinite(iteration)) {
        process.stderr.write(`Invalid --iteration "${iterationRaw}".\n`);
        process.exit(1);
      }
      upsertAutoresearchSession(cwd ?? process.cwd());
      const result = await runLoopIteration({
        cwd,
        prompt: readOption(args, "--prompt"),
        command: readOption(args, "--command"),
        timeoutSeconds,
        iteration,
        description: readOption(args, "--description"),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    process.stderr.write(`Unknown autoresearch action: ${action}\nUsage: formiga autoresearch <init|run-experiment|log-experiment|status|next|loop|run-loop-iteration|prune>\n`);
    process.exit(1);
  }

  if (group === "status") {
    console.log("Formiga Status");
    console.log("===============");
    console.log();
    console.log(formatServiceStatus());
    console.log();
    console.log("---");
    console.log();
    console.log(formatFormigaInfo({ getVersion }));
    console.log();
    console.log("---");
    console.log();
    console.log(formatRunsSummary());
    console.log();
    console.log("---");
    console.log();
    console.log(formatProcessList());
    return;
  }

  if (args.length < 2) { printUsage(); process.exit(1); }
  if (group !== "workflow") { printUsage(); process.exit(1); }

  if (action === "runs") {
    const runs = listRuns();
    if (runs.length === 0) { console.log("No workflow runs found."); return; }
    console.log("Workflow runs:");
    for (const r of runs) console.log(`  [${r.status.padEnd(9)}] ${r.id.slice(0, 8).padEnd(10)} ${r.workflowId.padEnd(14)} ${r.tokensSpent.toLocaleString().padStart(8)} tokens  ${r.task.slice(0, 50)}${r.task.length > 50 ? "..." : ""}`);
    return;
  }

  if (action === "list") {
    const jsonFlag = args.includes("--json");
    const workflows = await listBundledWorkflows();
    if (workflows.length === 0) {
      if (jsonFlag) console.log("[]");
      else console.log("No workflows available.");
      return;
    }
    if (jsonFlag) {
      const specs = await Promise.all(
        workflows.map(async (wid) => {
          try {
            const dir = resolveBundledWorkflowDir(wid);
            const spec = await loadWorkflowSpec(dir);
            return { id: spec.id, name: spec.name || spec.id, description: spec.description || "" };
          } catch {
            return { id: wid, name: wid, description: "" };
          }
        }),
      );
      console.log(JSON.stringify(specs));
      return;
    }
    const descriptions = await Promise.all(workflows.map(w => getWorkflowShortDescription(w)));
    console.log("Available workflows:");
    for (let i = 0; i < workflows.length; i++) { console.log(`  ${workflows[i]} - ${descriptions[i]}`); }
    return;
  }

  if (action === "stop") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    try { const fullId = getWorkflowStatus(target).id; const r = await stopWorkflow(fullId); console.log(`Cancelled run ${r.runId.slice(0, 8)}.`); } catch (err) { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); }
    return;
  }

  if (action === "pause") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    const drain = args.includes("--drain");
    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (runStatus !== "running") {
      process.stderr.write(`Cannot pause run ${fullId.slice(0, 8)}: status is "${runStatus}" (only running runs can be paused).\n`);
      process.exit(1);
    }
    const response = await pauseRunWithDaemon(fullId, drain);
    if (response === null) {
      process.stderr.write("Daemon is unreachable. Is the daemon running? Try: formiga dashboard start\n");
      process.exit(1);
    }
    if (response.status !== 200) {
      const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
      process.stderr.write(`Failed to pause run: ${errMsg}\n`);
      process.exit(1);
    }
    console.log(`Paused run ${fullId.slice(0, 8)}.`);
    return;
  }

  if (action === "resume") {
    if (!target) { process.stderr.write("Missing run-id.\n"); process.exit(1); }
    let fullId: string;
    let runStatus: string;
    try {
      const detail = getWorkflowStatus(target);
      fullId = detail.id;
      runStatus = detail.status;
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    if (runStatus === "paused") {
      const response = await resumeRunWithDaemon(fullId);
      if (response === null) {
        process.stderr.write("Daemon is unreachable. Is the daemon running? Try: formiga dashboard start\n");
        process.exit(1);
      }
      if (response.status !== 200 && response.status !== 202) {
        const errMsg = typeof response.body.error === "string" ? response.body.error : "Unknown error";
        process.stderr.write(`Failed to resume run: ${errMsg}\n`);
        process.exit(1);
      }
      console.log(`Resumed run ${fullId.slice(0, 8)}.`);
      return;
    }
    if (runStatus === "failed") {
      const result = await resumeWorkflow(fullId);
      if (result.status === "not_found") { console.log(`No failed run found matching "${target}".`); return; }
      console.log(`Resumed run ${result.runId!.slice(0, 8)} (${result.workflowId}), restarting from step: ${result.stepId}`);
      return;
    }
    if (runStatus === "completed" || runStatus === "canceled") {
      process.stderr.write(`Cannot resume run ${fullId.slice(0, 8)}: status is "${runStatus}" (terminal runs cannot be resumed).\n`);
      process.exit(1);
    }
    process.stderr.write(`Cannot resume run ${fullId.slice(0, 8)}: status is "${runStatus}" (only paused or failed runs can be resumed).\n`);
    process.exit(1);
  }

  if (action === "pause-all") {
    const drain = args.includes("--drain");
    const runs = listRuns(1000).filter(r => r.status === "running");
    if (runs.length === 0) {
      console.log("No runs to pause.");
      return;
    }
    let paused = 0;
    for (const r of runs) {
      const response = await pauseRunWithDaemon(r.id, drain);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run ${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200) {
        console.warn(`Warning: failed to pause run ${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      paused++;
    }
    console.log(`Paused ${paused} run(s).`);
    return;
  }

  if (action === "resume-all") {
    const runs = listRuns(1000).filter(r => r.status === "paused");
    if (runs.length === 0) {
      console.log("No runs to resume.");
      return;
    }
    let resumed = 0;
    for (const r of runs) {
      const response = await resumeRunWithDaemon(r.id);
      if (response === null) {
        console.warn(`Warning: daemon unreachable for run ${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      if (response.status !== 200 && response.status !== 202) {
        console.warn(`Warning: failed to resume run ${r.id.slice(0, 8)} — skipped`);
        continue;
      }
      resumed++;
    }
    console.log(`Resumed ${resumed} run(s).`);
    return;
  }

  if (!target) { printUsage(); process.exit(1); }

  if (action === "install") {
    const isAll = target === "--all" || target === "all";
    if (isAll) {
      const workflows = await listBundledWorkflows();
      if (workflows.length === 0) { console.log("No bundled workflows found."); return; }
      console.log(`Installing ${workflows.length} workflow(s)...`);
      for (const wf of workflows) { try { await installWorkflow({ workflowId: wf }); console.log(`  ✓ ${wf}`); } catch (err) { console.log(`  ✗ ${wf}: ${err instanceof Error ? err.message : String(err)}`); } }
      console.log(`\nDone. Start with: formiga workflow run <name> "your task"`);
      return;
    }
    const result = await installWorkflow({ workflowId: target });
    console.log(`Installed workflow: ${result.workflowId}\nAgent crons will start when a run begins.\n\nStart with: formiga workflow run ${result.workflowId} "your task"`);
    return;
  }

  if (action === "uninstall") {
    const force = args.includes("--force"); const isAll = target === "--all" || target === "all";
    const activeRuns = await checkActiveRuns(isAll ? undefined : target);
    if (activeRuns.length > 0 && !force) { process.stderr.write(`Cannot uninstall: ${activeRuns.length} active run(s):\n`); activeRuns.forEach(r => process.stderr.write(`  - ${r.id}: ${r.task}\n`)); process.exit(1); }
    if (isAll) { await uninstallAllWorkflows(); console.log("All workflows uninstalled."); } else { await uninstallWorkflow(target); console.log(`Uninstalled: ${target}`); }
    return;
  }

  if (action === "run") {
    const workflowName = args[2];
    if (!workflowName) { process.stderr.write("Missing workflow name.\n"); process.exit(1); }

    let runArgs: ReturnType<typeof parseWorkflowRunArgs>;
    try {
      runArgs = parseWorkflowRunArgs(args.slice(3));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }

    if (!runArgs.taskTitle) { process.stderr.write("Missing task description.\n"); process.exit(1); }
    let harnessType: HarnessType | undefined;
    if (runArgs.harnessAs !== undefined) {
      harnessType = runArgs.harnessAs as HarnessType;
    }

    const result = await runWorkflow({
      workflowId: workflowName,
      taskTitle: runArgs.taskTitle,
      workingDirectoryForHarness: runArgs.workingDirectoryForHarness,
      worktreeOriginRepository: runArgs.worktreeOriginRepository,
      worktreeOriginRef: runArgs.worktreeOriginRef,
      noHurrySaveTokensMode: runArgs.noHurrySaveTokensMode,
      noRelaunchUponRugpull: runArgs.noRelaunchUponRugpull,
      harnessType,
    });
    console.log(`Run: ${result.runId.slice(0, 8)}\nWorkflow: ${result.workflowId}\nTask: ${result.taskTitle}\nStatus: ${result.status}\nHarness CWD: ${result.workingDirectoryForHarness}`);
    return;
  }

  if (action === "status") {
    if (!target) { process.stderr.write("Missing query.\n"); process.exit(1); }
    try {
      const result = getWorkflowStatus(target);
      console.log(`Run: ${result.id.slice(0, 8)}\nWorkflow: ${result.workflowId}\nTask: ${result.task}\nStatus: ${result.status}\nTokens: ${result.tokensSpent.toLocaleString()}`);
      console.log(`Steps:`);
      for (const step of result.steps) {
        const icon = step.status === "done" ? "  [done   ]" : step.status === "running" ? "  [running]" : step.status === "failed" ? "  [failed ]" : step.status === "pending" ? "  [pending]" : `  [${step.status.padEnd(7)}]`;
        console.log(`${icon} ${step.stepId} (${step.agentId.split("_").slice(-1)[0]})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
      console.log(message.startsWith("No run found matching") ? `No run found matching "${target}".` : message);
    }
    return;
  }

  if (action === "autoresearch") {
    if (!target) {
      process.stderr.write("Missing run-id.\nUsage: formiga workflow autoresearch <run-id>\n");
      process.exit(1);
    }
    printWorkflowAutoresearch(target);
    return;
  }

  if (action === "delete") {
    if (!target) { process.stderr.write("Missing run-id.\nUsage: formiga workflow delete <run-id> [--force]\n"); process.exit(1); }
    const force = args.includes("--force");
    try {
      let fullId: string;
      try {
        fullId = getWorkflowStatus(target).id;
      } catch (err) {
        const message = err instanceof Error ? err.message : `No run found matching "${target}".`;
        process.stderr.write(message.startsWith("No run found matching") ? `No run found matching "${target}".\n` : `${message}\n`);
        process.exit(1);
      }
      const result = await deleteWorkflow(fullId, { force });
      console.log(`Deleted run ${result.runId.slice(0, 8)}.`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    return;
  }



  if (action === "ensure-crons") {
    // Polling jobs are now tied to (runId, agentId) and admitted via the
    // daemon control plane. There is no longer a workflow-wide
    // "ensure-crons" notion — use `formiga workflow run` instead
    // (which registers the new run with the daemon).
    process.stderr.write(
      "`workflow ensure-crons` is removed. Run-scoped scheduling makes it obsolete \u2014 " +
      "start a run with `formiga workflow run <id> '<task>'`.\n",
    );
    process.exit(1);
  }

  printUsage(); process.exit(1);
}

await main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
