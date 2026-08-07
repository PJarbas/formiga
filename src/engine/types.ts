// ══════════════════════════════════════════════════════════════════════
// types.ts — ML pipeline types (extracted from autoresearch/types.ts)
// ══════════════════════════════════════════════════════════════════════

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
