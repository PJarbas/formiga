// ══════════════════════════════════════════════════════════════════════
// seed.ts — Determinism utilities for ML pipeline reproducibility
// ══════════════════════════════════════════════════════════════════════

export const DEFAULT_RANDOM_SEED = 42;

/** Python snippet injected into agent prompts to guarantee determinism. */
export function pythonSeedSnippet(seed: number = DEFAULT_RANDOM_SEED): string {
  return `import random, numpy as np
random.seed(${seed})
np.random.seed(${seed})
# If using torch: torch.manual_seed(${seed})`;
}

/** Seed object for config JSON serialization. */
export function seedConfig(seed: number = DEFAULT_RANDOM_SEED): Record<string, number> {
  return {
    random_state: seed,
    numpy_seed: seed,
    torch_manual_seed: seed,
  };
}
