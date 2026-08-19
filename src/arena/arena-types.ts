// ══════════════════════════════════════════════════════════════════════
// arena-types.ts — Pure type definitions for the ML competition arena
// No logic, no imports from runtime modules — shared across backend.
// ══════════════════════════════════════════════════════════════════════

export type MetricDirection = "lower" | "higher";
export type ArenaDecision = "keep" | "discard" | "crash" | "checks_failed" | "baseline";
export type ArenaStatus = "running" | "converged" | "target_reached" | "max_rounds" | "failed" | "paused";
export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

export interface ArenaConfig {
  runId: string;
  /** Workflow id that owns this run — used to resolve provisioned agent personas. */
  workflowId?: string;
  workspacePath: string;
  benchmarkScript?: string;
  checksScript?: string;
  metricName: string;
  metricDirection: MetricDirection;
  targetMetric?: number;
  maxRounds: number;
  maxNoImprove: number;
  commitOnKeep: boolean;
  revertOnDiscard: boolean;
  agents: ArenaAgentConfig[];
  /** Dataset signature for warm-start lookups across runs */
  datasetSignature?: string;
  /** Formiga API base URL for artifact access (e.g., http://localhost:3334) */
  formigaApi?: string;
  /**
   * Session heartbeat cadence while agents generate (reconciler stuck-detection
   * guard). The engine touches arena_sessions.updated_at at round start and on
   * every tick during the agent-generation wait, so a healthy LLM-bound round is
   * never marked "stuck" by the control server. Defaults to 3 minutes. Tunable
   * by operators; tests use a short interval to exercise the path cheaply.
   */
  heartbeatIntervalMs?: number;
}

export interface ArenaAgentConfig {
  id: string;
  agentPersona: string;
  timeout: number;
  strategyHint: string;
  /** Model type label for leaderboard (e.g. "xgboost", "lightgbm"). Falls back to agent id. */
  modelType?: string;
}

export interface ArenaSession {
  id: string;
  runId: string;
  metricName: string;
  metricDirection: MetricDirection;
  benchmarkScript: string | null;
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
  status: ArenaStatus;
  totalKeep: number;
  totalDiscard: number;
  totalCrash: number;
  totalChecksFailed: number;
  consecutiveNoImprove: number;
  /**
   * JSON checkpoint persisted at the end of each round (AL-4). Holds the
   * in-memory arena state (results, best fold scores, per-team ledger, dedup
   * signatures) so a daemon restart can resume from the last completed round
   * instead of losing the run. Parsed by the engine on resume.
   */
  stateJson?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoundResult {
  round: number;
  agentResults: AgentRoundResult[];
  bestMetricThisRound: number | null;
  improvedOverPrevious: boolean;
}

export interface AgentRoundResult {
  agentId: string;
  hypothesis: string;
  learned: string;
  nextFocus: string;
  metric: number | null;
  decision: ArenaDecision;
  durationMs: number;
  benchmarkStdout: string;
  benchmarkStderr: string;
  benchmarkExitCode: number | null;
  confidenceBand?: ConfidenceBand;
  /** True when the script was killed for exceeding the compute budget (RF-#90). */
  budgetExceeded?: boolean;
  scriptPath: string;
  experimentId?: number;
  /**
   * Cross-pollination note directed at the OTHER team(s) — a suggestion or
   * observation, distinct from `learned` (own reflection). Injected into the
   * next round's prompt so teams build on each other's findings. Sourced from
   * the agent's `_results.json`.
   */
  notes?: string;
}

export interface BenchmarkResult {
  metric: number | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ConfidenceResult {
  band: ConfidenceBand;
  score: number | null;
  noiseFloor: number | null;
  sampleCount: number;
  improvementAbs: number | null;
  improvementPct: number | null;
  note?: string;
}

export interface BenchmarkConfig {
  problemType: string;
  metric: {
    name: string;
    sklearnScorer: string;
    direction: MetricDirection;
    displayName: string;
    negateSklearn: boolean;
  };
  secondaryMetrics?: Array<{
    name: string;
    sklearnScorer: string;
    negateSklearn: boolean;
  }>;
  validation: {
    strategy: string;
    nSplits: number;
    shuffle?: boolean;
    randomState?: number;
    gap?: number;
  };
  data: {
    featuresPath: string;
    targetColumn: string;
    splitPath: string;
  };
  thresholds?: {
    maxTrainValGap?: number;
    minCvStdRatio?: number;
  };
}
