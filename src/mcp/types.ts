// ══════════════════════════════════════════════════════════════════════
// types.ts — Interfaces and types for Formiga MCP Server
// ══════════════════════════════════════════════════════════════════════

/**
 * JSON Schema for MCP tool input validation
 */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/**
 * MCP Tool definition schema
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/**
 * MCP Tool call result
 */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Context passed to tool handlers for each invocation
 */
export interface ToolContext {
  runId: string;
  stepId: string;
  agentId: string;
}

/**
 * Tool handler interface (Interface Segregation)
 */
export interface IToolHandler {
  readonly name: string;
  readonly schema: ToolSchema;
  handle(args: unknown, context: ToolContext): Promise<ToolResult>;
}

/**
 * Background queue interface for fire-and-forget operations
 */
export interface IBackgroundQueue {
  enqueue(task: () => Promise<void>): void;
  shutdown(timeoutMs?: number): Promise<void>;
  readonly pending: number;
}

/**
 * Artifact service interface (Dependency Inversion)
 */
export interface IArtifactService {
  save(input: ArtifactInput): Promise<number>;
  getNextCounter(input: { runId: string; agentId: string; artifactKey: string }): Promise<number>;
  /** Read a single artifact by (runId, key). Returns null if not found. */
  getByKey(runId: string, artifactKey: string): Promise<ArtifactRecord | null>;
  /** List all artifacts for a run, newest first. */
  listByRun(runId: string): Promise<ArtifactRecord[]>;
}

/**
 * Input for artifact saving
 */
export interface ArtifactInput {
  runId: string;
  stepId: string;
  agentId: string;
  artifactKey: string;
  content: Record<string, unknown>;
  contentType?: string;
  sizeBytes?: number;
}

/**
 * A persisted artifact record (read model).
 */
export interface ArtifactRecord {
  artifactKey: string;
  agentId: string;
  stepId: string;
  content: Record<string, unknown>;
  contentType: string;
  sizeBytes: number | null;
  createdAt: string;
}

/**
 * Decision service interface
 */
export interface IDecisionService {
  log(input: DecisionInput): Promise<number>;
}

/**
 * Input for decision logging
 */
export interface DecisionInput {
  runId: string;
  stepId: string;
  agentId: string;
  decisionType: DecisionType;
  description: string;
  reasoning?: string;
  alternativesConsidered?: string[];
}

/**
 * Valid decision types
 */
export type DecisionType =
  | "model_selection"
  | "feature_drop"
  | "hyperparameter"
  | "early_stop"
  | "error_recovery";

/**
 * Metric service interface
 */
export interface IMetricService {
  report(input: MetricInput): Promise<number>;
}

/**
 * Input for metric reporting
 */
export interface MetricInput {
  runId: string;
  stepId: string;
  agentId: string;
  name: string;
  value: number;
  tags?: Record<string, string>;
}

/**
 * Leaderboard service interface
 */
export interface ILeaderboardService {
  getTop(runId: string, limit: number): Promise<LeaderboardEntry[]>;
}

/**
 * Leaderboard entry
 */
export interface LeaderboardEntry {
  modelType: string;
  cvMean: number;
  trainMean: number;
  agentName: string;
  roundNumber: number;
}

/**
 * Arena service interface — read-only access to the competition state
 * (session, per-round experiments, convergence series). Distinct from
 * ILeaderboardService (ranking) by ISP: arena is its own domain.
 */
export interface IArenaService {
  /** The arena session for a run (best metric, rounds, convergence counters). */
  getSession(runId: string): Promise<ArenaSessionView | null>;
  /** All experiments grouped by round, oldest round first. */
  getRounds(runId: string): Promise<ArenaRoundView[]>;
  /** Convergence series: every measured metric point, ordered by time. */
  getConvergence(runId: string): Promise<ConvergencePoint[]>;
}

/** Read model: the competition-level state of an arena run. */
export interface ArenaSessionView {
  metricName: string;
  metricDirection: string;
  targetMetric: number | null;
  currentRound: number;
  maxRounds: number;
  bestMetric: number | null;
  bestAgent: string | null;
  baselineMetric: number | null;
  status: string;
  totalKeep: number;
  totalDiscard: number;
  totalCrash: number;
  consecutiveNoImprove: number;
}

/** Read model: one round's experiments. */
export interface ArenaRoundView {
  round: number;
  experiments: ArenaExperimentView[];
}

/** Read model: one experiment within a round. */
export interface ArenaExperimentView {
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

/** Read model: one point in the convergence series. */
export interface ConvergencePoint {
  round: number;
  agent: string;
  metric: number;
  decision: string | null;
  timestamp: string;
}

/**
 * MCP Server configuration
 */
export interface McpServerConfig {
  apiUrl: string;
  port?: number;
}

/**
 * Tool call request from MCP client
 */
export interface ToolCallRequest {
  name: string;
  arguments: unknown;
}
