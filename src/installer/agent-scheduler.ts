// ══════════════════════════════════════════════════════════════════════
// agent-scheduler.ts — Backward-compat re-export shim
// ══════════════════════════════════════════════════════════════════════
//
// The original 2113-LOC god object has been decomposed into the
// `src/installer/scheduler/` package. This file now exists only as a
// thin re-export surface so existing imports (CLI, daemon, tests,
// downstream tools) keep working without a path migration.
//
// New code should import from the focused submodules directly:
//   - ./scheduler/shared.js      — types, in-memory state maps
//   - ./scheduler/binary-discovery.js
//   - ./scheduler/pi-runner.js
//   - ./scheduler/hermes-runner.js
//   - ./scheduler/prompts.js
//   - ./scheduler/polling-parser.js
//   - ./scheduler/polling-round.js
//   - ./scheduler/cron-manager.js
// ══════════════════════════════════════════════════════════════════════

// ── Binary discovery ───────────────────────────────────────────────────
export { findHermesBinary, findPiBinary } from "./scheduler/binary-discovery.js";

// ── Harness runners ────────────────────────────────────────────────────
export { runPi, type RunPiOptions } from "./scheduler/pi-runner.js";
export { runHermes } from "./scheduler/hermes-runner.js";

// ── Prompt builders ────────────────────────────────────────────────────
export {
  buildAgentPersonaInstructions,
  buildAgentPrompt,
  buildPollingPrompt,
  buildWorkPrompt,
} from "./scheduler/prompts.js";

// ── Polling output parsing ────────────────────────────────────────────
export {
  classifyPollingRoundOutcome,
  extractTokenUsage,
  parsePollingRoundMetadata,
  type PollingRoundMetadata,
} from "./scheduler/polling-parser.js";

// ── Polling round orchestration ────────────────────────────────────────
export {
  autoCompleteStepIfRunning,
  buildPollingRoundContext,
  executePollingRound,
} from "./scheduler/polling-round.js";

// ── Direct spawn (event-driven sequential scheduling) ──────────────────
export { spawnAgentsForPendingSteps } from "./scheduler/direct-spawn.js";

// ── Output buffer ──────────────────────────────────────────────────────
export { OutputRingBuffer } from "./scheduler/output-buffer.js";

// ── Cron job lifecycle ─────────────────────────────────────────────────
export {
  _getJobIntervalsForRun,
  _hasRunScheduled,
  _runIdForScheduledHarnessWorkdir,
  _scheduledJobCount,
  _scheduledJobCountForRun,
  _scheduledRunIds,
  createAgentCronJob,
  listCronJobs,
  nudgeScheduledRuns,
  removeAgentCrons,
  removeRunCrons,
  setupAgentCrons,
  shutdownAllCrons,
  teardownWorkflowCronsIfIdle,
} from "./scheduler/cron-manager.js";

// ── Shared types + in-flight guard ─────────────────────────────────────
export {
  tryMarkJobInFlight,
  type CreateCronJobParams,
  type CronJobInfo,
  type NudgeJobDetail,
  type NudgeResult,
  type SetupAgentCronsOptions,
} from "./scheduler/shared.js";
