// ══════════════════════════════════════════════════════════════════════
// step-ops.ts — Re-export shim
// ══════════════════════════════════════════════════════════════════════
//
// Branch 3 god-object decomposition: this module's contents were extracted
// into focused submodules under ./steps/. This shim preserves the public
// API so existing callers continue to work unchanged.
//
// Submodules:
//   - steps/template-resolver — template substitution and KEY: value parsing
//   - steps/story-manager     — story rows, progress file, story-template helpers
//   - steps/pipeline-control  — run/step advancement, terminal event emission
//   - steps/recovery          — abandoned/orphaned step cleanup
//   - steps/context           — resolveStepContext (template var collection)
//   - steps/claim             — peekStep, claimStep (state-machine: pending → running)
//   - steps/complete          — validateExpects, completeStep (state-machine: running → done/advance)
//   - steps/fail              — failStep + escalation helpers (state-machine: running → failed/retry)

export {
  parseOutputKeyValues,
  resolveTemplate,
  findMissingTemplateKeys,
  computeHasFrontendChanges,
  RESERVED_CONTEXT_KEYS,
} from "./steps/template-resolver.js";

export {
  getAgentWorkspacePath,
  readProgressFile,
  buildStoryPlanSection,
  mergeStoryPlanIntoProgress,
  writeStoryPlanToProgress,
  getStories,
  getCurrentStory,
  formatStoryForTemplate,
  formatCompletedStories,
  parseAndInsertStories,
} from "./steps/story-manager.js";

export {
  scheduleRunCronTeardown,
  getWorkflowId,
  emitRunTerminalEvent,
  finalizeDrainingPause,
  advancePipeline,
  archiveRunProgress,
} from "./steps/pipeline-control.js";

export {
  setRunContextKey,
  cleanupAbandonedSteps,
  recoverOrphanedStepsForAgent,
} from "./steps/recovery.js";

export { resolveStepContext } from "./steps/context.js";

export {
  peekStep,
  claimStep,
  type PeekResult,
  type WorkerOwnership,
  type ClaimResult,
} from "./steps/claim.js";

export { validateExpects, completeStep } from "./steps/complete.js";

export { failStep } from "./steps/fail.js";
