// ═══════════════════════════════════════════════════════════════════════════════
// arena/index.ts — Public API surface for the competition arena module.
// ═══════════════════════════════════════════════════════════════════════════════

export type {
  ArenaConfig,
  ArenaAgentConfig,
  ArenaSession,
  ArenaStatus,
  ArenaDecision,
  MetricDirection,
  ConfidenceBand,
  ConfidenceResult,
  RoundResult,
  AgentRoundResult,
  BenchmarkResult,
  BenchmarkConfig,
} from "./arena-types.js";

export type { ArenaResult } from "./arena-engine.js";

export { computeConfidence } from "./arena-confidence.js";
export { makeDecision, isImprovement } from "./arena-decision.js";
export { runBenchmark, extractMetric } from "./arena-benchmark.js";
export { buildAgentPrompt } from "./arena-prompt.js";
export { ArenaRepositoryImpl, type ArenaRepository, type ArenaReadonly } from "./arena-repository.js";
export { runArena } from "./arena-engine.js";
