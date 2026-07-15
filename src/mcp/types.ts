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
