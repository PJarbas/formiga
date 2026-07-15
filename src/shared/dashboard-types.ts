// ══════════════════════════════════════════════════════════════════════
// dashboard-types.ts — Types shared between server API and React frontend
// ══════════════════════════════════════════════════════════════════════

// Re-export canonical status types from the registry (single source of truth)
export type {
  VisualStatus,
  DashboardAgentStatus as AgentStatus,
  PipelineRunStatus,
  UIStatus,
} from "./status-registry.js";

// Keep AgentStatus as a convenient alias
import type { DashboardAgentStatus } from "./status-registry.js";

// ── ML Kanban (per-agent lane view, Tela 2) ──────────────────────────

/** @deprecated Use DashboardAgentStatus from status-registry instead */
type AgentStatus = DashboardAgentStatus;

export interface MLKanbanCard {
  /** Unique card id (experiment_id or round-phase key). */
  id: string;
  /** Agent persona name (data-analyst, feature-engineer, etc.). */
  agentName: string;
  /** Short display title. */
  title: string;
  status: AgentStatus;
  /** Subtitle line — e.g. "cvMean: 0.85" or "Round 3/5". */
  sub: string;
  /** When this card was last updated (ISO 8601). */
  updatedAt: string;
}

export interface MLKanbanLane {
  agent: string;
  label: string;
  stepId?: string;
  stepType?: string;
  status: AgentStatus;
  cards: MLKanbanCard[];
  summary: { done: number; failed: number; running: number; total: number };
}

export interface MLKanbanSnapshot {
  runId: string;
  roundNumber: number;
  status: string;
  lanes: MLKanbanLane[];
  generatedAt: string;
}

// ── Leaderboard (Tela 3) ─────────────────────────────────────────────

export interface LeaderboardEntry {
  id: string;
  runId: string;
  roundNumber: number;
  agentName: string;
  modelId: string;
  modelType: string;
  status: string;
  cvMean: number;
  cvStd: number;
  trainMean: number;
  trainValGap: number;
  hyperparameters: Record<string, unknown> | null;
  featureImportancesTop10: Array<[string, number]> | null;
  trainTimeSeconds: number | null;
  inferenceTimeMsPer1k: number | null;
  createdAt: string;
  promotedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  artifactPath: string | null;
  /** Arena decision (keep/discard/crash) when this entry came from an arena round. */
  decision?: string | null;
  /** Arena confidence score when this entry came from an arena round. */
  confidenceScore?: number | null;
  /** Arena confidence band (high/medium/low/unknown). */
  confidenceBand?: string | null;
  /** Agent's hypothesis text for this experiment. */
  hypothesis?: string | null;
  /** Agent's learned text for this experiment. */
  learned?: string | null;
}

export interface ModelReportResponse {
  content: string;
  filename: string;
}

export interface ReproductionScriptResponse {
  script: string;
  filename: string;
  language: "python";
}

export interface CompareResponse {
  entries: LeaderboardEntry[];
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total: number;
  bestCvMean: number | null;
  filters: {
    agentName?: string;
    roundNumber?: number;
    status?: string;
  };
}

// ── Pipeline status (Tela 1) ─────────────────────────────────────────

export type WorkflowType = "ml-pipeline" | "ml-autoresearch";

export type PipelinePhase = "idle" | "data_analysis" | "feature_engineering" | "modeling" | "audit" | "arena" | "report" | "complete" | (string & {});

export interface PipelineStatus {
  runId: string | null;
  status: "idle" | "running" | "paused" | "completed" | "failed";
  currentPhase: PipelinePhase;
  currentRound: number;
  maxRounds: number;
  startedAt: string | null;
  updatedAt: string | null;
  /** Dynamic agent statuses keyed by agent ID */
  agentStats: Record<string, AgentStatus>;
  /** @deprecated Use agentStats instead - kept for backwards compatibility */
  phaseStats: {
    dataAnalyst: AgentStatus;
    featureEngineer: AgentStatus;
    modelerClassic: AgentStatus;
    modelerAdvanced: AgentStatus;
    mlCritic: AgentStatus;
  };
  quickStats: {
    totalExperiments: number;
    bestCvMean: number | null;
    roundsCompleted: number;
    tokensSpent: number;
  };
  workflowType?: WorkflowType;
}

// ── Agent detail (Tela 4) ────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  label: string;
  description: string;
  tools: string[];
  model: string;
  /** Logical ML phase this agent belongs to */
  phase: PipelinePhase;
  /** Step ID in the `steps` table */
  stepId: string;
  /** Harness type: pi (direct) or hermes (workflow-driven) */
  harness: "pi" | "hermes" | "unknown";
  /** Output artifacts produced by this agent */
  artifactsOut: string[];
  /** Pending inter-agent messages count */
  messagesCount: number;
}

export interface AgentDetail {
  agent: AgentInfo;
  currentStatus: AgentStatus;
  totalTrials: number;
  lastOutput: string | null;
  lastError: string | null;
  rounds: Array<{
    roundNumber: number;
    status: string;
    cvMean: number | null;
    modelType: string | null;
  }>;
}

export interface AgentLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface AgentLogsResponse {
  agentName: string;
  entries: AgentLogEntry[];
  total: number;
  offset: number;
  limit: number;
}

// ── Agent Reasoning (consolidated view) ─────────────────────────────

export interface AgentKeyDecision {
  roundNumber: number;
  modelType: string;
  cvMean: number;
  trainMean: number;
  status: string;
  reason: string | null;
  promotedAt: string | null;
  rejectedAt: string | null;
}

export interface AgentApproaches {
  models: string[];
  searchSpace: Record<string, unknown> | null;
  overfittingMitigation: string | null;
}

export interface AgentReasoningResponse {
  agentName: string;
  hypothesis: string | null;
  learned: string | null;
  nextFocus: string | null;
  approaches: AgentApproaches;
  keyDecisions: AgentKeyDecision[];
  specDiff: { before: string; after: string } | null;
  summary: string | null;
}

// ── Rounds ───────────────────────────────────────────────────────────

export interface RoundSummary {
  runId: string;
  roundNumber: number;
  status: string;
  totalExperiments: number;
  experimentsRegistered: number;
  experimentsRejected: number;
  bestCvMean: number | null;
  currentPhase: PipelinePhase | null;
  durationMs: number | null;
  startedAt: string | null;
  completedAt: string | null;
}

// ── Cross-findings ───────────────────────────────────────────────────

export interface CrossFinding {
  id: string;
  runId: string;
  roundNumber: number;
  fromAgent: string;
  toAgent: string;
  content: string;
  createdAt: string;
}

// ── Agent info registry (used by /api/agents) ────────────────────────

// ── Pipeline Flow (DAG view) ──────────────────────────────────────

export interface PipelineFlowNode {
  agentId: string;
  label: string;
  status: DashboardAgentStatus;
  harness: "pi" | "hermes" | "unknown";
  phase: PipelinePhase;
  artifactsOut: string[];
  messagesCount: number;
  elapsedSeconds?: number;
  timeoutSeconds?: number;
  lastOutputAt?: string;
}

export interface PipelineFlowEdge {
  from: string;
  to: string;
  artifactLabel: string;
  status: "pending" | "in-transit" | "delivered";
}

export interface PipelineFlowResponse {
  nodes: PipelineFlowNode[];
  edges: PipelineFlowEdge[];
  runId: string | null;
  workflowType?: "ml-autoresearch" | "ml-pipeline";
}

// ── Agent registries per workflow ────────────────────────────────────

/** Agents for ml-pipeline workflow */
export const ML_PIPELINE_AGENTS: Record<string, AgentInfo> = {
  "data-analyst": {
    name: "data-analyst",
    label: "Data Analyst",
    description: "Performs exploratory data analysis: distributions, correlations, missing values, outlier detection, and generates hypotheses.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "data_analysis",
    stepId: "eda",
    harness: "pi",
    artifactsOut: ["eda_report", "eda_config"],
    messagesCount: 0,
  },
  "feature-engineer": {
    name: "feature-engineer",
    label: "Feature Engineer",
    description: "Engineers features, creates train/test split, trains a baseline model. Ensures zero data leakage and deterministic splits.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "feature_engineering",
    stepId: "features",
    harness: "pi",
    artifactsOut: ["features_metadata", "split_config", "baseline_submission", "preprocessing_config"],
    messagesCount: 0,
  },
  "modeler-classic": {
    name: "modeler-classic",
    label: "Modeler (Classic)",
    description: "Trains classical ML models: GBM, Linear, RF, SVM, Stacking. Minimum 4 model families, 50+ trials. Plan mode on first round.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "modeling",
    stepId: "model-classic",
    harness: "pi",
    artifactsOut: ["modeler_classic_submission", "modeler_classic_plan", "modeler_classic_report", "cross_findings"],
    messagesCount: 0,
  },
  "modeler-advanced": {
    name: "modeler-advanced",
    label: "Modeler (Advanced)",
    description: "Trains advanced models: Neural Networks, TabNet, FT-Transformer, AutoML. CUDA detection, early stopping, torch seed determinism.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "modeling",
    stepId: "model-advanced",
    harness: "pi",
    artifactsOut: ["modeler_advanced_submission", "modeler_advanced_plan", "modeler_advanced_report", "cross_findings_advanced"],
    messagesCount: 0,
  },
  "ml-critic": {
    name: "ml-critic",
    label: "ML Critic",
    description: "Adversarial auditor: validates model outputs with 8 audit checks. Read-only access — no Write tool. Can reject models from leaderboard.",
    tools: ["Read", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "audit",
    stepId: "audit",
    harness: "pi",
    artifactsOut: ["audit_report", "agent_decisions"],
    messagesCount: 0,
  },
};

/** Agents for ml-autoresearch workflow */
export const ML_AUTORESEARCH_AGENTS: Record<string, AgentInfo> = {
  "data-analyst": {
    name: "data-analyst",
    label: "Data Analyst",
    description: "Performs exploratory data analysis: distributions, correlations, missing values, outlier detection, and generates hypotheses.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "data_analysis",
    stepId: "eda",
    harness: "pi",
    artifactsOut: ["eda_report", "eda_config"],
    messagesCount: 0,
  },
  "feature-engineer": {
    name: "feature-engineer",
    label: "Feature Engineer",
    description: "Engineers features, creates train/test split, trains a baseline model, and creates benchmark scripts for the arena.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "feature_engineering",
    stepId: "features",
    harness: "pi",
    artifactsOut: ["features_metadata", "split_config", "baseline_submission", "benchmark_config", "preprocessing_config"],
    messagesCount: 0,
  },
  "arena-modeler-classic": {
    name: "arena-modeler-classic",
    label: "Modeler (Classic)",
    description: "Arena competitor using classical ML: GBM, Linear, RF, SVM, Stacking. Competes in rounds against the advanced modeler.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "arena",
    stepId: "arena",
    harness: "pi",
    artifactsOut: ["modeler_classic_submission", "cross_findings", "agent_decisions"],
    messagesCount: 0,
  },
  "arena-modeler-advanced": {
    name: "arena-modeler-advanced",
    label: "Modeler (Advanced)",
    description: "Arena competitor using advanced ML: Neural Networks, TabNet, FT-Transformer, AutoML. Competes in rounds against the classic modeler.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "arena",
    stepId: "arena",
    harness: "pi",
    artifactsOut: ["modeler_advanced_submission", "cross_findings_advanced", "agent_decisions"],
    messagesCount: 0,
  },
  "reporter": {
    name: "reporter",
    label: "Arena Reporter",
    description: "Summarizes arena competition results: best models, convergence analysis, and final leaderboard report.",
    tools: ["Read", "Write", "Bash", "Glob", "Grep"],
    model: "sonnet",
    phase: "report",
    stepId: "report",
    harness: "pi",
    artifactsOut: ["arena_report", "competition_timeline", "winner_feature_importance"],
    messagesCount: 0,
  },
};

/** Get agents for a specific workflow type */
export function getAgentsForWorkflow(workflowType: WorkflowType | undefined): Record<string, AgentInfo> {
  if (workflowType === "ml-autoresearch") {
    return ML_AUTORESEARCH_AGENTS;
  }
  return ML_PIPELINE_AGENTS;
}

/** Get agent IDs for a specific workflow type */
export function getAgentIdsForWorkflow(workflowType: WorkflowType | undefined): string[] {
  return Object.keys(getAgentsForWorkflow(workflowType));
}

/**
 * @deprecated Use getAgentsForWorkflow() instead for workflow-specific agents.
 * This combined registry is kept for backwards compatibility.
 */
export const AGENT_INFO_REGISTRY: Record<string, AgentInfo> = {
  ...ML_PIPELINE_AGENTS,
  ...ML_AUTORESEARCH_AGENTS,
};

// ── Actions, decisions & UX primitives (front-specs §9) ──────────────

export type SpecAction = "approve" | "reject" | "edit";

export interface Action {
  id: string;
  label: string;
  primary?: boolean;
  variant?: "default" | "destructive" | "success";
}

export interface DecisionAction {
  id: string;
  label: string;
  primary?: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  required: boolean;
}

export interface ChecklistState {
  runId: string;
  phase: string;
  items: ChecklistItem[];
  updatedAt: string;
}


export interface DiffHunk {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

export interface SpecDiff {
  before: string;
  after: string;
  changes: DiffHunk[];
}

// ── Kanban Card Detail (enriched panel data) ──────────────────────────

export interface KanbanCardDetail {
  runId: string;
  cardId: string;
  title: string;
  status: string;
  storyId?: string;
  description?: string;
  acceptanceCriteria?: string[];
  input_template: string;
  /** Agent raw output text (summary / result). */
  output?: string;
  task: string;
  events: Array<Record<string, unknown>>;
  timing?: {
    firstEvent: string;
    lastEvent: string;
    durationMs: number;
  };
  tokens?: {
    total: number;
    deltas: number[];
  };
  failureDetail?: string;
  retryCount: number;
  maxRetries: number;
}

// ── Trace ────────────────────────────────────────────────────────────

export interface TraceEntry {
  timestamp: string;
  event: string;
  detail?: string;
  level: "info" | "warn" | "error";
}

export type PhaseStatus = "done" | "running" | "pending" | "failed";
// Note: PhaseStatus is a UI-specific concept (pipeline phase progression).
// It is NOT the same as Step/Story/Experiment status. Kept here intentionally.

export interface PhaseInfo {
  id: string;
  label: string;
  status: PhaseStatus;
  elapsedMs: number;
  estimatedMs: number;
}

export type PendingDecisionType =
  | "spec_approval"
  | "overfitting_warning";

export interface PendingDecision {
  id: string;
  type: PendingDecisionType;
  title: string;
  description: string;
  actions: DecisionAction[];
  createdAt: string;
}

// ── Arena (ml-autoresearch — competitive arena dashboard) ─────────────

export type ArenaDashboardStatus = "running" | "converged" | "target_reached" | "max_rounds" | "failed" | "paused";

export interface ArenaSessionResponse {
  id: string;
  runId: string;
  metricName: string;
  metricDirection: "lower" | "higher";
  benchmarkScript: string;
  checksScript?: string | null;
  targetMetric: number | null;
  maxRounds: number;
  maxNoImprove: number;
  currentRound: number;
  bestMetric: number | null;
  bestAgent: string | null;
  bestExperimentId: number | null;
  baselineMetric: number | null;
  noiseFloorMad: number | null;
  status: ArenaDashboardStatus;
  totalKeep: number;
  totalDiscard: number;
  totalCrash: number;
  totalChecksFailed: number;
  consecutiveNoImprove: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArenaRoundExperiment {
  experimentId: number;
  agentName: string;
  modelType: string;
  metric: number | null;
  decision: string | null;
  confidenceScore: number | null;
  confidenceBand: string | null;
  hypothesis: string | null;
  learned: string | null;
  durationMs: number | null;
  status: string;
}

export interface ArenaRoundResponse {
  round: number;
  experiments: ArenaRoundExperiment[];
}

export interface ConvergencePoint {
  round: number;
  agent: string;
  metric: number;
  decision: string | null;
  timestamp: string;
}

export interface ArenaConvergenceResponse {
  points: ConvergencePoint[];
}

export interface ArenaStopReason {
  reason: "max_rounds" | "target_reached" | "converged" | "max_no_improve" | "stopped" | "failed" | "unknown";
  description: string;
}

export interface ArenaConfidenceResponse {
  noiseFloorMad: number | null;
  baselineMetric: number | null;
  bestMetric: number | null;
  bestAgent: string | null;
  bestExperimentId: number | null;
}

export interface ArenaAgentHistoryEntry {
  experimentId: number;
  round: number;
  hypothesis: string | null;
  learned: string | null;
  metric: number | null;
  decision: string | null;
  confidenceBand: string | null;
  createdAt: string;
}

export interface ArenaAgentHistoryResponse {
  agentId: string;
  experiments: ArenaAgentHistoryEntry[];
}

// ── Spec approvals (persisted) ───────────────────────────────────────

export type SpecApprovalStatus = "pending" | "approved" | "rejected";

export interface SpecApproval {
  id: string;
  runId: string;
  phase: string;
  status: SpecApprovalStatus;
  reason?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  updatedAt: string;
}

// ── Command Center aggregate (front-specs §3.1) ──────────────────────

export interface AgentStripItem {
  name: string;
  label: string;
  status: AgentStatus;
  bestCvMean: number | null;
  trials: number;
}

export interface ArenaProgress {
  currentRound: number;
  maxRounds: number;
  status: ArenaDashboardStatus;
}

export interface PipelineRunRow {
  runId: string;
  shortHash: string;
  workflowId: string;
  workflowType: WorkflowType;
  task: string;
  status: string;
  currentPhase: PipelinePhase;
  phases: PhaseInfo[];
  totalExperiments: number;
  bestCvMean: number | null;
  durationMs: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  arenaProgress?: ArenaProgress;
}

export interface CommandCenterSnapshot {
  runs: PipelineRunRow[];
}

// ── Agent Activity Stream ───────────────────────────────────────────

export type AgentEventType = "tool_call" | "thinking" | "step_event" | "artifact" | "error";
export type ToolStatus = "running" | "completed" | "failed";
export type StepEventKind = "claimed" | "completed" | "failed" | "retrying";

export interface AgentEventRow {
  id: number;
  runId: string;
  stepId: string;
  agentId: string;
  eventType: AgentEventType;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  toolStatus?: ToolStatus;
  durationMs?: number;
  thinking?: string;
  stepEvent?: StepEventKind;
  createdAt: string;
}

export interface AgentEventsResponse {
  events: AgentEventRow[];
  total: number;
  hasMore: boolean;
}

export interface AgentArtifactRow {
  id: number;
  runId: string;
  stepId: string;
  agentId: string;
  artifactKey: string;
  artifactPath?: string;
  content: Record<string, unknown>;
  contentType: string;
  sizeBytes?: number;
  checksum?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentArtifactsResponse {
  artifacts: AgentArtifactRow[];
}
