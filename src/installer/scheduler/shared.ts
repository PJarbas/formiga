// ══════════════════════════════════════════════════════════════════════
// shared.ts — Cross-module state, types, and small helpers for scheduler
// ══════════════════════════════════════════════════════════════════════
//
// Job identity:  formiga-${workflowId}-${runId}-${agentId}
// Scope:         every job is tied to ONE (runId, agentId) tuple
// Ownership:    timers + in-flight pi children are owned by whatever
//               process invokes the scheduler (daemon in production;
//               occasionally direct callers in tests).
// State:        no on-disk persistence (cron-jobs.json removed). The DB
//               is the source of truth; the daemon's reconciler restores
//               in-memory job maps from runs.scheduling_status.
// ══════════════════════════════════════════════════════════════════════

import type { WorkflowSpec, WorkflowAgent, HarnessType } from "../types.js";

// ════════════════════════════════════════════════════════════════════
// In-memory state maps (with LRU-style bounds to prevent memory leaks)
// ════════════════════════════════════════════════════════════════════

/** Maximum number of entries per collection before eviction kicks in.
 *  Under normal operation these stay bounded by active-runs × agents-per-run;
 *  the cap protects against leaks after crashes or cleanup failures. */
const MAX_MAP_ENTRIES = 512;

function evictIfFull<K, V>(map: Map<K, V>): void {
  if (map.size >= MAX_MAP_ENTRIES) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
}

function evictSetIfFull(set: Set<unknown>): void {
  if (set.size >= MAX_MAP_ENTRIES) {
    const firstValue = set.values().next().value;
    if (firstValue !== undefined) set.delete(firstValue);
  }
}

/** Maps job id → active setInterval handle. */
export const activeTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Maps job id → delayed first-start timeout handle. */
export const pendingStartTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Maps job id → persistent metadata. */
export const jobMetadata = new Map<string, CronJobInfo>();

/**
 * Set of job ids whose pi process is currently running. Used to skip a
 * polling tick when the previous one for the same (run, agent) hasn't
 * finished — without this guard, setInterval would keep spawning new pi
 * every interval even though pi rounds can take 10–30 minutes.
 */
export const inFlightJobs: Set<string> & { addBounded(jobId: string): boolean } = Object.assign(new Set<string>(), {
  addBounded(jobId: string): boolean {
    if (inFlightJobs.has(jobId)) return false;
    evictSetIfFull(inFlightJobs);
    inFlightJobs.add(jobId);
    return true;
  },
});

export interface InFlightChild {
  pid: number;
  pgid: number;
  killed: boolean;
}

/**
 * Maps job id → in-flight child handle, exposing pid + pgid. Used by
 * `removeRunCrons` and daemon shutdown to terminate process groups.
 */
export const inFlightChildren = new Map<string, InFlightChild>();

/**
 * Bounded insert for jobMetadata. Evicts the oldest entry when at capacity.
 */
export function setJobMetadata(id: string, info: CronJobInfo): void {
  evictIfFull(jobMetadata);
  jobMetadata.set(id, info);
}

/**
 * Bounded insert for activeTimers. Evicts the oldest entry when at capacity.
 */
export function setActiveTimer(id: string, timer: ReturnType<typeof setInterval>): void {
  evictIfFull(activeTimers);
  activeTimers.set(id, timer);
}

/**
 * Bounded insert for pendingStartTimers. Evicts the oldest entry when at capacity.
 */
export function setPendingStartTimer(id: string, timer: ReturnType<typeof setTimeout>): void {
  evictIfFull(pendingStartTimers);
  pendingStartTimers.set(id, timer);
}

/**
 * Bounded insert for inFlightChildren. Evicts the oldest entry when at capacity.
 */
export function setInFlightChild(id: string, child: InFlightChild): void {
  evictIfFull(inFlightChildren);
  inFlightChildren.set(id, child);
}

// ── Persona files ──────────────────────────────────────────────────────

export const AGENT_PERSONA_FILES = ["AGENTS.md", "IDENTITY.md", "SOUL.md"] as const;

// ── Nudge types ────────────────────────────────────────────────────────

export interface NudgeJobDetail {
  runId: string;
  agentId: string;
  status: "launched" | "skipped_in_flight" | "error";
  error?: string;
}

export interface NudgeResult {
  runIds: string[];
  launched: number;
  skippedInFlight: number;
  errors: Array<{ runId?: string; agentId?: string; error: string }>;
  jobs: NudgeJobDetail[];
}

// ── Cron job types ─────────────────────────────────────────────────────

export interface CronJobInfo {
  /** formiga-${workflowId}-${runId}-${agentId} */
  id: string;
  workflowId: string;
  runId: string;
  agentId: string;
  intervalMinutes: number;
  model?: string;
  workModel?: string;
  sessionLabel?: string;
  timeoutSeconds?: number;
  /** Working directory used as cwd for `pi --print` invocations. */
  workingDirectoryForHarness?: string;
  /** Harness binary to use for agent invocations ("pi" or "hermes"). */
  harnessType?: HarnessType;
  createdAt: string;
}

export interface CreateCronJobParams {
  workflowId: string;
  runId: string;
  agent: WorkflowAgent;
  workflow?: WorkflowSpec;
  intervalMinutes?: number;
  staggerOffsetMs?: number;
  workingDirectoryForHarness?: string;
}

export interface SetupAgentCronsOptions {
  workingDirectoryForHarness?: string;
  /** When true, elevates polling floor to 15 min and default to 15 min to save tokens. */
  noHurrySaveTokensMode?: boolean;
}

// ── In-flight guard ────────────────────────────────────────────────────

/**
 * Atomically check and mark a job as in-flight.
 *
 * Returns `true` if the job was not already in flight (caller should
 * proceed) and `false` if it was (caller should skip). The check-and-add
 * is synchronous to close the TOCTOU window between the guard and the
 * first `await` inside `executePollingRound`.
 */
export function tryMarkJobInFlight(jobId: string): boolean {
  if (inFlightJobs.has(jobId)) return false;
  inFlightJobs.addBounded(jobId);
  return true;
}

// ── Process group termination ──────────────────────────────────────────

export function safeKillPgid(pgid: number, signal: NodeJS.Signals): void {
  try {
    // Negative PID => kill the entire process group.
    process.kill(-pgid, signal);
  } catch {
    // Group may already be gone.
  }
}

// ── Run-scoped job teardown ────────────────────────────────────────────
//
// Cancels every timer + in-flight pi child associated with `runId`,
// removes the job metadata, and returns the list of job ids that were
// torn down. Used by both `polling-round.ts` (when a run is observed to
// be no longer running) and `cron-manager.ts` (`removeRunCrons`). Living
// in shared.ts avoids the polling-round ↔ cron-manager import cycle.
export function teardownRunJobs(runId: string): string[] {
  const removed: string[] = [];

  for (const [id, info] of jobMetadata) {
    if (info.runId !== runId) continue;

    const pending = pendingStartTimers.get(id);
    if (pending) {
      clearTimeout(pending);
      pendingStartTimers.delete(id);
    }

    const timer = activeTimers.get(id);
    if (timer) {
      clearInterval(timer);
      activeTimers.delete(id);
    }

    const child = inFlightChildren.get(id);
    if (child && !child.killed) {
      child.killed = true;
      if (child.pgid) {
        safeKillPgid(child.pgid, "SIGTERM");
        setTimeout(() => safeKillPgid(child.pgid, "SIGKILL"), 5000).unref();
      }
    }
    inFlightChildren.delete(id);
    inFlightJobs.delete(id);
    jobMetadata.delete(id);
    removed.push(id);
  }

  return removed;
}

// ── Bounded log preview helpers ────────────────────────────────────────

const MAX_LOG_STREAM_PREVIEW = 200;

export interface StreamLogMetadata {
  bytes: number;
  preview: string;
  truncated: boolean;
}

export function buildStreamLogMetadata(stream: string): StreamLogMetadata {
  const normalized = stream.trim();
  const truncated = normalized.length > MAX_LOG_STREAM_PREVIEW;
  const preview = truncated ? `${normalized.slice(0, MAX_LOG_STREAM_PREVIEW)}…` : normalized;

  return {
    bytes: Buffer.byteLength(stream, "utf-8"),
    preview,
    truncated,
  };
}

export interface BoundedPreviewMetadata {
  preview: string;
  bytes: number;
  truncated: boolean;
}

export function buildBoundedPreview(value: string, maxChars: number): BoundedPreviewMetadata {
  const truncated = value.length > maxChars;
  const preview = truncated ? `${value.slice(0, maxChars)}…` : value;

  return {
    preview,
    bytes: Buffer.byteLength(value, "utf-8"),
    truncated,
  };
}
