// ══════════════════════════════════════════════════════════════════════
// types.ts — Re-export autoresearch types + ML pipeline types
// ══════════════════════════════════════════════════════════════════════

export type {
  AutoresearchDirection,
  AutoresearchDecision,
  AutoresearchRunStatus,
  AutoresearchConfidenceBand,
  AutoresearchSessionConfig,
  AutoresearchPaths,
  AutoresearchRunEntry,
  AutoresearchRunResultEntry,
  AutoresearchSessionEntry,
  AutoresearchLogEntry,
  AutoresearchSummary,
  AutoresearchConfidence,
  InitExperimentOptions,
  RunExperimentOptions,
  LogExperimentOptions,
  RunLoopIterationOptions,
  RunLoopIterationResult,
  LoopAutoresearchOptions,
  LoopAutoresearchResult,
} from "./autoresearch.js";

// ── ML Pipeline types ──────────────────────────────────────────────────

export interface FormigaConfig {
  maxRounds: number;
  timeouts: {
    dataAnalyst: number;
    featureEngineer: number;
    modelerClassic: number;
    modelerAdvanced: number;
    mlCritic: number;
  };
  seed: number;
  workspaceRoot: string;
  maxConcurrency: number;
}

export interface PipelineResult {
  runId: string;
  roundsCompleted: number;
  totalExperiments: number;
  bestModelId: string | null;
  bestMetric: number | null;
  errors: string[];
}
