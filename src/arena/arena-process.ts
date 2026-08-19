// ══════════════════════════════════════════════════════════════════════
// arena-process.ts — Detached host process for the arena engine
// ══════════════════════════════════════════════════════════════════════
//
// Spawned by direct-spawn's spawnArenaProcess when a run's arena step
// becomes pending. Hosting the arena in its own detached process fixes a
// structural hang: `formiga step complete` runs in a CLI subprocess spawned
// by the agent's harness via its Bash tool, and the arena runs for many
// minutes — so launching it in-process kept that CLI subprocess (and the
// harness's bash call, and the harness itself) from ever resolving.
//
// This process owns the whole arena lifecycle: launchArenaFromStep runs the
// rounds with a healthy event loop (heartbeat + per-agent timeouts fire, so
// the reconciler's stuck detection sees a fresh arena_sessions.updated_at),
// then completes the step and advances the pipeline. The parent never waits
// for it, and a daemon restart does not kill it.
//
// Note: this process intentionally does NOT process.exit() after the arena
// completes — completeStep's postAdvanceSpawn starts the next agent's
// harness (the reporter) in this same process (the daisy-chain scheduling
// model), and a forced exit would kill that harness mid-run. The process
// exits naturally once no handles remain.
//
// Usage: node dist/arena/arena-process.js <runId> <stepId>
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "../db.js";
import { logger } from "../lib/logger.js";
import { launchArenaFromStep } from "./arena-workflow.js";

async function main(): Promise<void> {
  const [, , runId, stepId] = process.argv;
  if (!runId || !stepId) {
    logger.error("arena-process: runId and stepId are required", {
      argv: process.argv.slice(2),
    });
    process.exitCode = 2;
    return;
  }

  // Touch the DB early so a misconfigured environment fails loudly here
  // (clear log) instead of deep inside the arena engine.
  await getPrisma().$connect();

  logger.info("arena-process: launching arena", { runId, stepId });
  await launchArenaFromStep(runId, stepId);
  logger.info("arena-process: arena workflow segment complete", { runId, stepId });
}

main().catch((err) => {
  logger.error("arena-process: fatal error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exitCode = 1;
});
