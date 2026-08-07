// ══════════════════════════════════════════════════════════════════════
// token-tracking.ts — Shared token attribution helpers
// ══════════════════════════════════════════════════════════════════════
//
// Extracted from polling-round.ts so the arena engine and any future
// harness-consumer can attribute token usage without duplicating the
// run-increment + system-fallback logic.
//
// Usage:
//   import { attributeTokenUsage, incrementRunTokenSpend } from "./token-tracking.js";
//
//   // After a polling round or arena agent completes:
//   await attributeTokenUsage(tokenUsage, {
//     runId: "abc-123",
//     agentId: "ml-autoresearch_data-analyst",
//     caller: "polling-round",
//   });
//
// Behaviour mirrors the original polling-round.ts logic exactly:
//   - Positive tokens → increment run.tokens_spent, emit run.tokens.updated
//   - Unresolved run → fall back to system token spend
//   - null/zero/negative → no-op with debug log
// ══════════════════════════════════════════════════════════════════════

import { getPrisma, incrementSystemTokenSpend } from "../../db.js";
import { logger } from "../../lib/logger.js";
import { emitEvent } from "../events.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface TokenSpendUpdate {
  workflowId?: string;
  tokensSpent: number;
}

export interface TokenAttributionContext {
  runId?: string | null;
  agentId?: string;
  /** Caller identifier for log context ("polling-round", "arena", etc.). */
  caller?: string;
}

// ── DB helpers ────────────────────────────────────────────────────────

/**
 * Increment a run's tokens_spent counter by tokenUsage.
 * Returns the updated workflow_id and total tokens_spent, or null if the
 * run is not found.
 */
export async function incrementRunTokenSpend(
  runId: string,
  tokenUsage: number,
): Promise<TokenSpendUpdate | null> {
  const prisma = getPrisma();
  try {
    const updated = await prisma.run.update({
      where: { id: runId },
      data: {
        tokens_spent: { increment: tokenUsage },
        updated_at: new Date(),
      },
      select: { workflow_id: true, tokens_spent: true },
    });
    return {
      workflowId: updated.workflow_id,
      tokensSpent: updated.tokens_spent,
    };
  } catch {
    return null;
  }
}

// ── Attribution ───────────────────────────────────────────────────────

/**
 * Attribute tokens to a run (primary) or system spend (fallback).
 *
 * Logic (matches polling-round.ts):
 *   1. null / ≤ 0 → no-op
 *   2. Resolved runId → increment run.tokens_spent + emit event
 *   3. No runId → fall back to system token spend
 */
export async function attributeTokenUsage(
  tokenUsage: number | null | undefined,
  context: TokenAttributionContext,
): Promise<void> {
  const logCtx = {
    caller: context.caller ?? "unknown",
    agentId: context.agentId,
    runId: context.runId,
  };

  if (tokenUsage === null || tokenUsage === undefined) {
    logger.debug("Token attribution skipped — tokenUsage is null", logCtx);
    return;
  }

  if (tokenUsage <= 0) {
    logger.debug("Token attribution skipped — non-positive usage", {
      ...logCtx,
      tokenUsage,
    });
    return;
  }

  if (!context.runId) {
    // ── Fallback: system spend ──────────────────────────────────────
    try {
      const newSystemTotal = await incrementSystemTokenSpend(tokenUsage);
      emitEvent({
        ts: new Date().toISOString(),
        event: "system.tokens.updated",
        runId: "system",
        tokenDelta: tokenUsage,
        tokensSpent: newSystemTotal,
      });
      logger.info("Token usage attributed to system spend (no runId)", {
        ...logCtx,
        tokenUsage,
        systemTokensSpent: newSystemTotal,
      });
    } catch (err) {
      logger.warn("System token attribution failed", {
        ...logCtx,
        tokenUsage,
        error: String(err),
      });
    }
    return;
  }

  // ── Primary: run-level attribution ────────────────────────────────
  try {
    const updated = await incrementRunTokenSpend(context.runId, tokenUsage);

    if (!updated) {
      logger.warn("Token usage not attributed — run missing", {
        ...logCtx,
        tokenUsage,
      });

      // Fall back to system spend so tokens are never silently dropped.
      try {
        const newSystemTotal = await incrementSystemTokenSpend(tokenUsage);
        emitEvent({
          ts: new Date().toISOString(),
          event: "system.tokens.updated",
          runId: "system",
          tokenDelta: tokenUsage,
          tokensSpent: newSystemTotal,
        });
        logger.info("Token usage attributed to system spend (run missing)", {
          ...logCtx,
          tokenUsage,
          systemTokensSpent: newSystemTotal,
        });
      } catch (fallbackErr) {
        logger.warn("System token fallback also failed", {
          ...logCtx,
          tokenUsage,
          error: String(fallbackErr),
        });
      }
      return;
    }

    emitEvent({
      ts: new Date().toISOString(),
      event: "run.tokens.updated",
      runId: context.runId,
      workflowId: updated.workflowId,
      tokenDelta: tokenUsage,
      tokensSpent: updated.tokensSpent,
    });

    logger.debug("Token usage attributed", {
      ...logCtx,
      tokenUsage,
      tokensSpent: updated.tokensSpent,
    });
  } catch (err) {
    logger.warn("Token attribution failed", {
      ...logCtx,
      tokenUsage,
      error: String(err),
    });
  }
}

/**
 * Convenience wrapper: attribute tokens from a HarnessResult's metadata.
 * Use when you have a HarnessResult and want one-line attribution.
 */
export async function attributeHarnessResultTokens(
  tokenUsage: number | null | undefined,
  context: TokenAttributionContext,
): Promise<void> {
  return attributeTokenUsage(tokenUsage, context);
}
