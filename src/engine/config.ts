// ══════════════════════════════════════════════════════════════════════
// config.ts — FormigaConfig with defaults for the ML pipeline
// ══════════════════════════════════════════════════════════════════════

import type { FormigaConfig } from "./types.js";

const MINUTES = 60_000;

export const DEFAULT_FORMIGA_CONFIG: FormigaConfig = {
  maxRounds: 5,
  timeouts: {
    dataAnalyst: 10 * MINUTES,
    featureEngineer: 15 * MINUTES,
    modelerClassic: 60 * MINUTES,
    modelerAdvanced: 90 * MINUTES,
    mlCritic: 15 * MINUTES,
  },
  seed: 42,
  workspaceRoot: ".formiga/workspaces/ml",
  maxConcurrency: 2,
};

export function buildConfig(overrides?: Partial<FormigaConfig>): FormigaConfig {
  return {
    ...DEFAULT_FORMIGA_CONFIG,
    ...overrides,
    timeouts: {
      ...DEFAULT_FORMIGA_CONFIG.timeouts,
      ...overrides?.timeouts,
    },
  };
}
