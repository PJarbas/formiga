import { getDb } from "../../db.js";
import type { LoopConfig, Story } from "../types.js";
import {
  parseOutputKeyValues,
  computeHasFrontendChanges,
  RESERVED_CONTEXT_KEYS,
} from "./template-resolver.js";
import {
  readProgressFile,
  getStories,
  formatStoryForTemplate,
  formatCompletedStories,
} from "./story-manager.js";

// ══════════════════════════════════════════════════════════════════════
// Resolve Step Context
// ══════════════════════════════════════════════════════════════════════

/**
 * Resolve the full template context for a step in a run.
 * Collects context from the run's saved context, previous steps' KEY: value output,
 * and computed values like branch info, PR info, and frontend detection.
 * Optionally adds story context for loop steps.
 *
 * Uses a single LEFT JOIN to batch the run-context fetch + previous-steps scan
 * into one round-trip instead of two separate queries.
 */
export function resolveStepContext(
  runId: string,
  stepIndex: number,
  loopConfig?: LoopConfig,
  story?: Story
): Record<string, string> {
  const db = getDb();

  // Single JOIN: run context + previous completed steps in one round-trip.
  const rows = db
    .prepare(
      `SELECT r.context AS run_context, s.id AS step_id, s.output, s.step_id AS step_label, s.type
       FROM runs r
       LEFT JOIN steps s ON s.run_id = r.id
         AND s.step_index < ?
         AND s.status IN ('done', 'skipped')
       WHERE r.id = ?
       ORDER BY s.step_index ASC`
    )
    .all(stepIndex, runId) as {
      run_context: string;
      step_id: string | null;
      output: string | null;
      step_label: string | null;
      type: string | null;
    }[];

  // Extract run context from the first row (same for all rows due to the JOIN).
  const context: Record<string, string> =
    rows.length > 0 && rows[0].run_context ? JSON.parse(rows[0].run_context) : {};

  // Always inject run_id so templates can use {{run_id}}
  context["run_id"] = runId;

  // Collect output from previous completed steps
  for (const row of rows) {
    if (row.output) {
      const parsed = parseOutputKeyValues(row.output);
      for (const [key, value] of Object.entries(parsed)) {
        if (!RESERVED_CONTEXT_KEYS.has(key)) {
          context[key] = value;
        }
      }
    }
  }

  // Add branch info and PR detection context (extracted from previous step outputs)
  if (context["repo"] && context["branch"]) {
    context["has_frontend_changes"] = computeHasFrontendChanges(context["repo"], context["branch"]);
  }

  // Add PR info if available from context
  if (context["pr_url"]) {
    context["has_pr"] = "true";
  }

  // Add story context for loop steps
  if (story && loopConfig) {
    context["current_story"] = formatStoryForTemplate(story);
    context["current_story_id"] = story.storyId;
    context["current_story_title"] = story.title;

    const allStories = getStories(runId);
    context["completed_stories"] = formatCompletedStories(allStories);
    const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;
    context["stories_remaining"] = String(pendingCount);
    context["progress"] = readProgressFile(runId);

    if (!context["verify_feedback"]) {
      context["verify_feedback"] = "";
    }
  }

  return context;
}
