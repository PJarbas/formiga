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
  scriptPath: string;
  experimentId?: number;
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
