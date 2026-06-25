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
  buildPrompt(context: AgentContext): string;
  validateOutput(output: string): ValidationResult;
}
