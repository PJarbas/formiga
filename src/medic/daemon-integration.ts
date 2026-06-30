/**
 * Medic Daemon Integration
 *
 * Provides a lightweight ticker that integrates the medic health
 * check into the daemon's reconciler loop. Replaces the dead
 * cron-based medic scheduling with a guaranteed in-process check.
 */
import { logger } from "../lib/logger.js";
import { runMedicCheck } from "./medic.js";

// ── Configuration ──────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 5 * 60_000;

function getMedicIntervalMs(): number {
  const raw = process.env.FORMIGA_MEDIC_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 30_000 ? n : DEFAULT_INTERVAL_MS;
}

// ── Ticker ─────────────────────────────────────────────────────────

export interface MedicTicker {
  tickIfDue(): Promise<void>;
  reset(): void;
}

export function createMedicTicker(): MedicTicker {
  let lastCheckAt = 0;

  return {
    async tickIfDue(): Promise<void> {
      const now = Date.now();
      if (now - lastCheckAt < getMedicIntervalMs()) return;

      lastCheckAt = now;
      try {
        const result = await runMedicCheck();
        if (result.actionsTaken > 0) {
          logger.info("medic-ticker: remediated issues", {
            issuesFound: result.issuesFound,
            actionsTaken: result.actionsTaken,
            summary: result.summary,
          });
        }
      } catch (err) {
        logger.warn("medic-ticker: check failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    reset(): void {
      lastCheckAt = 0;
    },
  };
}
