// ══════════════════════════════════════════════════════════════════════
// interfaces.ts — Agent runner interfaces, types, and messaging protocol
// ══════════════════════════════════════════════════════════════════════

// ── Agent context (input) ──────────────────────────────────────────────

export interface AgentContext {
  runId: string;
  roundNumber: number;
  workspacePath: string;
  config?: Record<string, unknown>;
  previousResults?: AgentResult[];
  messages?: AgentMessage[];
  /** Live reference to the inter-agent messenger for sending messages. */
  messenger?: AgentMessenger;
  /** Metric name optimized by this agent (e.g. "cv_mean", "cv_rmse"). */
  metricName?: string;
  /** Cross-run history: configs that failed or were rejected. */
  previousFailures?: Array<{
    model_type: string;
    hyperparameters: Record<string, unknown>;
    reject_reason: string | null;
  }>;
  /** Cross-run history: configs that succeeded. */
  previousSuccesses?: Array<{
    model_type: string;
    hyperparameters: Record<string, unknown>;
    val_metric: number;
  }>;
}

// ── Agent result (output) ──────────────────────────────────────────────

export interface AgentResult {
  agentName: string;
  modelId?: string;
  modelType?: string;
  status: "SUCCESS" | "FAILED";
  hyperparameters?: Record<string, unknown>;
  cvMean?: number;
  cvStd?: number;
  cvScores?: number[];
  trainMean?: number;
  trainValGap?: number;
  artifactPath?: string;
  secondaryMetrics?: Record<string, number>;
  trainTimeSeconds?: number;
  inferenceTimeMsPer1k?: number;
  featureImportancesTop10?: Array<[string, number]>;
  errorMessage?: string;
  reportPath?: string;
  outputs?: Record<string, string>;
  /** Metric name optimized by this agent (e.g. "cv_mean", "cv_rmse"). */
  metricName?: string;
}

// ── Plan mode (modelers) ───────────────────────────────────────────────

export interface AgentPlan {
  agentName: string;
  approaches: string[];
  searchSpace: Record<string, unknown>;
  trialsPerApproach: number;
  overfittingMitigation: string;
  timeBudget?: number;
}

// ── Inter-agent messaging ──────────────────────────────────────────────

export interface AgentMessage {
  from: string;
  to: string;
  timestamp: string;
  content: string;
  type: "finding" | "alert" | "status" | "feedback";
}

export interface AgentMessenger {
  send(message: AgentMessage): void;
  receive(agentName: string): AgentMessage[];
  broadcast(from: string, content: string): void;
}

// ── Validation ─────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// ── Agent runner interface ─────────────────────────────────────────────

export interface AgentRunner {
  readonly name: string;
  readonly tools: string[];
  readonly model: string;
  /**
   * @deprecated Branch 7 — the runtime path for the ML pipeline is
   * `workflows/ml-pipeline/workflow.yml`, where prompts live in
   * `agents/<id>/AGENTS.md` and are loaded by the scheduler. `buildPrompt`
   * is kept only for the programmatic `FormigaEngine`/`RoundManager` path
   * and the legacy test suite; prefer editing the markdown personas.
   */
  buildPrompt(context: AgentContext): string;
  validateOutput(output: string): ValidationResult;
}
