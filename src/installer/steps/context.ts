import { getPrisma } from "../../db.js";
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
 */
export async function resolveStepContext(
  runId: string,
  stepIndex: number,
  loopConfig?: LoopConfig,
  story?: Story
): Promise<Record<string, string>> {
  const prisma = getPrisma();

  // Get run context
  const run = await prisma.run.findUnique({
    where: { id: runId },
    select: { context: true },
  });

  const context: Record<string, string> = run?.context ? JSON.parse(run.context) : {};

  // Always inject run_id so templates can use {{run_id}}
  context["run_id"] = runId;

  // Get previous completed steps
  const previousSteps = await prisma.step.findMany({
    where: {
      run_id: runId,
      step_index: { lt: stepIndex },
      status: { in: ["done", "skipped"] },
    },
    orderBy: { step_index: "asc" },
    select: { output: true },
  });

  // Collect output from previous completed steps
  for (const step of previousSteps) {
    if (step.output) {
      const parsed = parseOutputKeyValues(step.output);
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

    const allStories = await getStories(runId);
    context["completed_stories"] = formatCompletedStories(allStories);
    const pendingCount = allStories.filter((s) => s.status === "pending" || s.status === "running").length;
    context["stories_remaining"] = String(pendingCount);
    context["progress"] = await readProgressFile(runId);

    if (!context["verify_feedback"]) {
      context["verify_feedback"] = "";
    }
  }

  return context;
}
