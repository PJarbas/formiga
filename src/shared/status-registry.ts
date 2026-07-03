// ══════════════════════════════════════════════════════════════════════
// status-registry.ts — Single source of truth for all status values
// and transformations across the ML pipeline.
//
// RULES:
//   1. All valid status values live in ENTITY_STATUSES — nowhere else.
//   2. All mappings between representations live in mapping tables below.
//   3. All resolution goes through resolveX() functions — no if/else chains.
//   4. Unknown values are logged with context, never silently swallowed.
// ══════════════════════════════════════════════════════════════════════

// ── Logger interface (DI — decoupled from any specific logger) ──────────

export interface StatusLogger {
  warn(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
}

const NULL_LOGGER: StatusLogger = {
  warn() {},
  debug() {},
};

let activeLogger: StatusLogger = NULL_LOGGER;

/** Inject a logger at startup. Until called, resolution is silent. */
export function setStatusLogger(logger: StatusLogger): void {
  activeLogger = logger;
}

export function getStatusLogger(): StatusLogger {
  return activeLogger;
}

// ── Canonical status values ─────────────────────────────────────────────
// Const arrays → literal union types via `(typeof X)[number]`.
// Adding a status = editing ONE entry here.

export const ENTITY_STATUSES = {
  Run: ["running", "paused", "done", "completed", "failed", "canceled"] as const,
  Step: ["waiting", "pending", "running", "done", "completed", "failed", "canceled", "cancelled"] as const,
  Story: ["pending", "running", "done", "failed"] as const,
  Experiment: ["PENDING", "SUCCESS", "FAILED", "AUDITED", "OVERFITTED"] as const,
  ArenaSession: ["running", "converged", "target_reached", "max_rounds", "failed", "paused"] as const,
  SpecApproval: ["pending", "approved", "rejected"] as const,
  RunWorktree: ["creating", "active", "removing", "removed", "error"] as const,
  JobRegistry: ["active", "idle", "paused", "failed", "completed"] as const,
  PhaseResult: ["completed", "failed", "timed_out"] as const,
  ArenaDecision: ["keep", "discard", "crash", "checks_failed", "baseline"] as const,
} as const;

export type EntityName = keyof typeof ENTITY_STATUSES;

// Discriminated union types — one per entity
export type RunStatus = (typeof ENTITY_STATUSES.Run)[number];
export type StepStatus = (typeof ENTITY_STATUSES.Step)[number];
export type StoryStatus = (typeof ENTITY_STATUSES.Story)[number];
export type ExperimentStatus = (typeof ENTITY_STATUSES.Experiment)[number];
export type ArenaSessionStatus = (typeof ENTITY_STATUSES.ArenaSession)[number];
export type SpecApprovalStatus = (typeof ENTITY_STATUSES.SpecApproval)[number];
export type RunWorktreeStatus = (typeof ENTITY_STATUSES.RunWorktree)[number];
export type JobRegistryStatus = (typeof ENTITY_STATUSES.JobRegistry)[number];
export type PhaseResultStatus = (typeof ENTITY_STATUSES.PhaseResult)[number];
export type ArenaDecisionValue = (typeof ENTITY_STATUSES.ArenaDecision)[number];

// ── Intermediate representations ────────────────────────────────────────
// These bridge between storage (DB) and display (UI).

/** Kanban board collapsed 4-state model. */
export type VisualStatus = "todo" | "running" | "done" | "failed";

/** Dashboard pipeline agent 5-state model (includes timed_out). */
export type DashboardAgentStatus = "idle" | "running" | "completed" | "failed" | "timed_out";

/** Pipeline run status (idle + terminal states). */
export type PipelineRunStatus = "idle" | "running" | "paused" | "completed" | "failed";

/** UI superset — every status the dashboard can display with a badge. */
export type UIStatus =
  | DashboardAgentStatus
  | "pending"
  | "approved"
  | "rejected"
  | "promoted"
  | "overfitted"
  | "success"
  | "keep"
  | "discard"
  | "crash"
  | "checks_failed"
  | "converged"
  | "target_reached"
  | "max_rounds"
  | "max_no_improve"
  | "paused";

// ── Mapping tables ──────────────────────────────────────────────────────
// Explicit Record<X, Y> — every valid input has exactly one output.
// Adding a status to ENTITY_STATUSES without updating the relevant table
// causes a TypeScript compile error (missing key).

export const EXPERIMENT_TO_DASHBOARD: Record<ExperimentStatus, DashboardAgentStatus> = {
  PENDING: "running",
  SUCCESS: "completed",
  FAILED: "failed",
  AUDITED: "completed",
  OVERFITTED: "failed",
};

export const STEP_TO_VISUAL: Record<StepStatus, VisualStatus> = {
  waiting: "todo",
  pending: "todo",
  running: "running",
  done: "done",
  completed: "done",
  failed: "failed",
  canceled: "failed",
  cancelled: "failed",
};

export const STORY_TO_VISUAL: Record<StoryStatus, VisualStatus> = {
  pending: "todo",
  running: "running",
  done: "done",
  failed: "failed",
};

export const ARENA_DECISION_TO_VISUAL: Record<ArenaDecisionValue, VisualStatus> = {
  keep: "done",
  discard: "failed",
  crash: "failed",
  checks_failed: "failed",
  baseline: "done",
};

export const VISUAL_TO_DASHBOARD: Record<VisualStatus, DashboardAgentStatus> = {
  todo: "idle",
  running: "running",
  done: "completed",
  failed: "failed",
};

/** PhaseResult already matches DashboardAgentStatus values — identity map. */
export const PHASE_RESULT_TO_DASHBOARD: Record<PhaseResultStatus, DashboardAgentStatus> = {
  completed: "completed",
  failed: "failed",
  timed_out: "timed_out",
};

/** Primary status → UIStatus (for status-config styling). */
export const STATUS_TO_UI: Record<string, UIStatus> = {
  // DashboardAgentStatus — identity
  idle: "idle",
  running: "running",
  completed: "completed",
  failed: "failed",
  timed_out: "timed_out",
  // UIStatus identity (not a DashboardAgentStatus)
  pending: "pending",
  // VisualStatus → UIStatus
  todo: "idle",
  done: "completed",
  // Experiment UPPERCASE → UI lowercase
  PENDING: "pending",
  SUCCESS: "success",
  FAILED: "failed",
  AUDITED: "completed",
  OVERFITTED: "overfitted",
  // Arena
  keep: "keep",
  discard: "discard",
  crash: "crash",
  checks_failed: "checks_failed",
  baseline: "success",
  converged: "converged",
  target_reached: "target_reached",
  max_rounds: "max_rounds",
  max_no_improve: "max_no_improve",
  paused: "paused",
  // SpecApproval
  approved: "approved",
  rejected: "rejected",
  // Promoted
  promoted: "promoted",
};

// ── Resolution context (for error reporting) ───────────────────────────

export interface ResolutionContext {
  /** Entity type (e.g. "Experiment", "Step", "ArenaDecision") */
  entityType: string;
  /** Entity identifier (experiment_id, step_id, etc.) */
  entityId?: string;
  /** Field being resolved (almost always "status") */
  fieldName?: string;
}

// ── Resolution functions ─────────────────────────────────────────────────

/** Look up a value in a Record, logging if the key is missing. */
function lookupWithFallback<V>(
  table: Record<string, V>,
  key: string,
  fallback: V,
  context: ResolutionContext | undefined,
): V {
  if (key in table) return table[key];
  activeLogger.warn(
    `Unknown status '${key}' for ${context?.entityType ?? "unknown"} ${context?.entityId ?? ""}.${context?.fieldName ?? "status"}; defaulting to '${fallback}'`,
    { ...context, receivedValue: key },
  );
  return fallback;
}

/**
 * Resolve any status value to DashboardAgentStatus.
 *
 * Priority: identity → Experiment → PhaseResult → Step/Story → fallback "idle"
 */
export function resolveDashboardStatus(
  value: string | null | undefined,
  context?: ResolutionContext,
): DashboardAgentStatus {
  if (!value) return "idle";

  const raw = String(value).trim();

  // 1. Identity — already a DashboardAgentStatus
  if (raw === "idle" || raw === "running" || raw === "completed" || raw === "failed" || raw === "timed_out") {
    return raw as DashboardAgentStatus;
  }

  // 2. Experiment (UPPERCASE)
  if (raw in EXPERIMENT_TO_DASHBOARD) {
    return EXPERIMENT_TO_DASHBOARD[raw as ExperimentStatus];
  }

  // 3. PhaseResult
  if (raw in PHASE_RESULT_TO_DASHBOARD) {
    return PHASE_RESULT_TO_DASHBOARD[raw as PhaseResultStatus];
  }

  // 4. Step/Story → Visual → Dashboard
  const visual = STEP_TO_VISUAL[raw as StepStatus] ?? STORY_TO_VISUAL[raw as StoryStatus];
  if (visual) return VISUAL_TO_DASHBOARD[visual];

  // 5. Unknown
  return lookupWithFallback({}, raw, "idle" as DashboardAgentStatus, context);
}

/**
 * Resolve any status value to VisualStatus (kanban).
 *
 * Priority: identity → Step → Story → ArenaDecision → fallback "todo"
 */
export function resolveVisualStatus(
  value: string | null | undefined,
  context?: ResolutionContext,
): VisualStatus {
  if (!value) return "todo";

  const raw = String(value).trim();

  // 1. Identity
  if (raw === "todo" || raw === "running" || raw === "done" || raw === "failed") {
    return raw as VisualStatus;
  }

  // 2. Step
  if (raw in STEP_TO_VISUAL) return STEP_TO_VISUAL[raw as StepStatus];

  // 3. Story
  if (raw in STORY_TO_VISUAL) return STORY_TO_VISUAL[raw as StoryStatus];

  // 4. Arena decision
  if (raw in ARENA_DECISION_TO_VISUAL) return ARENA_DECISION_TO_VISUAL[raw as ArenaDecisionValue];

  // 5. Unknown
  return lookupWithFallback({}, raw, "todo" as VisualStatus, context);
}

/**
 * Resolve any status value to UIStatus (for dashboard styling/config).
 *
 * Priority: STATUS_TO_UI lookup → fallback "idle"
 */
export function resolveUIStatus(
  value: string | null | undefined,
  context?: ResolutionContext,
): UIStatus {
  if (!value) return "idle";

  const raw = String(value).trim();
  return lookupWithFallback(STATUS_TO_UI, raw, "idle" as UIStatus, context);
}

// ── Validation helpers ──────────────────────────────────────────────────

/** Check if a value is a valid status for a given entity type. */
export function isValidStatus(entity: EntityName, value: string | null | undefined): boolean {
  if (!value) return false;
  return (ENTITY_STATUSES[entity] as readonly string[]).includes(value);
}

/** Get all valid status values for an entity type. */
export function getValidStatusValues(entity: EntityName): readonly string[] {
  return ENTITY_STATUSES[entity];
}