import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { getPrisma } from "../../db.js";
import { emitEvent } from "../events.js";
import { logger } from "../../lib/logger.js";
import type { Story } from "../types.js";

// ══════════════════════════════════════════════════════════════════════
// Agent Workspace (used by progress-file helpers below)
// ══════════════════════════════════════════════════════════════════════

/**
 * Get the workspace path for a Formiga agent by its id.
 * Reads from ~/.formiga/agents.json (a JSON array of agent configs with workspace paths).
 */
export function getAgentWorkspacePath(agentId: string): string | null {
  try {
    const configPath = path.join(os.homedir(), ".formiga", "agents.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const agents: Array<{ id: string; workspace?: string }> = Array.isArray(config) ? config : [];
    const agent = agents.find((a) => a.id === agentId);
    return agent?.workspace ?? null;
  } catch {
    return null;
  }
}

async function runHasStories(runId: string): Promise<boolean> {
  const prisma = getPrisma();
  const count = await prisma.story.count({
    where: { run_id: runId },
  });
  return count > 0;
}

async function getWorkflowId(runId: string): Promise<string | undefined> {
  try {
    const prisma = getPrisma();
    const run = await prisma.run.findUnique({
      where: { id: runId },
      select: { workflow_id: true },
    });
    return run?.workflow_id;
  } catch {
    return undefined;
  }
}

// ══════════════════════════════════════════════════════════════════════
// Progress File
// ══════════════════════════════════════════════════════════════════════

/**
 * Read progress.txt from the loop step's agent workspace.
 */
export async function readProgressFile(runId: string): Promise<string> {
  const prisma = getPrisma();
  const loopStep = await prisma.step.findFirst({
    where: { run_id: runId, type: "loop" },
    select: { agent_id: true },
  });
  if (!loopStep) return "(no progress file)";
  const workspace = getAgentWorkspacePath(loopStep.agent_id);
  if (!workspace) return "(no progress file)";
  try {
    const scopedPath = path.join(workspace, `progress-${runId}.txt`);
    const legacyPath = path.join(workspace, "progress.txt");
    const filePath = fs.existsSync(scopedPath) ? scopedPath : legacyPath;
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(no progress yet)";
  }
}

/**
 * Build a '## Story Plan' markdown section from an array of stories.
 * Exported for testability.
 */
export function buildStoryPlanSection(stories: Pick<Story, "storyId" | "title" | "description" | "acceptanceCriteria">[]): string {
  const parts: string[] = ["## Story Plan\n\n"];
  for (const story of stories) {
    parts.push(`### ${story.storyId}: ${story.title}\n\n`);
    parts.push(`**Description:** ${story.description}\n\n`);
    parts.push("**Acceptance Criteria:**\n");
    for (const ac of story.acceptanceCriteria) {
      parts.push(`- ${ac}\n`);
    }
    parts.push("\n");
  }
  return parts.join("");
}

/**
 * Merge a '## Story Plan' section into existing progress file content.
 * If a Story Plan section already exists, it is replaced. Otherwise it is
 * inserted after the first heading line (or at the top).
 * Exported for testability.
 */
export function mergeStoryPlanIntoProgress(existingContent: string, storyPlanSection: string): string {
  const storyPlanStart = "\n## Story Plan\n";
  const idx = existingContent.indexOf(storyPlanStart);
  if (idx !== -1) {
    // Find the next ## heading after the Story Plan start (or end of string)
    const afterStart = idx + storyPlanStart.length;
    const nextHeadingIdx = existingContent.indexOf("\n## ", afterStart);
    const endIdx = nextHeadingIdx !== -1 ? nextHeadingIdx : existingContent.length;
    return (
      existingContent.slice(0, idx) +
      "\n" +
      storyPlanSection.trimEnd() +
      (nextHeadingIdx !== -1 ? "" : "\n") +
      existingContent.slice(endIdx)
    );
  }

  if (existingContent.trim()) {
    // Insert after the first heading line, preserving existing content
    const headerMatch = existingContent.match(/^(# .+?\n)/);
    if (headerMatch) {
      return headerMatch[1] + "\n" + storyPlanSection + existingContent.slice(headerMatch[1].length);
    }
    return storyPlanSection + "\n" + existingContent;
  }

  return `# Progress Log\n\n${storyPlanSection}`;
}

/**
 * Write the full story plan to the progress log after STORIES_JSON is parsed.
 * Finds the loop step's agent workspace and writes/updates the '## Story Plan'
 * section in progress-{runId}.txt, preserving any existing Codebase Patterns or
 * other sections. Emits a 'stories.planned' event on success.
 */
export async function writeStoryPlanToProgress(runId: string): Promise<void> {
  if (!(await runHasStories(runId))) return;

  try {
    const prisma = getPrisma();
    const loopStep = await prisma.step.findFirst({
      where: { run_id: runId, type: "loop" },
      select: { agent_id: true },
    });

    if (!loopStep) {
      logger.warn("writeStoryPlanToProgress: no loop step found for run", { runId });
      return;
    }

    const workspace = getAgentWorkspacePath(loopStep.agent_id);
    if (!workspace) {
      logger.warn("writeStoryPlanToProgress: no workspace configured for loop agent", { runId, agentId: loopStep.agent_id });
      return;
    }

    const stories = await getStories(runId);
    if (stories.length === 0) return;

    const storyPlanSection = buildStoryPlanSection(stories);
    const scopedPath = path.join(workspace, `progress-${runId}.txt`);

    // Read existing content if any
    let existingContent = "";
    try {
      existingContent = fs.readFileSync(scopedPath, "utf-8");
    } catch {
      // File doesn't exist yet — that's fine
    }

    const newContent = mergeStoryPlanIntoProgress(existingContent, storyPlanSection);

    fs.mkdirSync(path.dirname(scopedPath), { recursive: true });
    fs.writeFileSync(scopedPath, newContent, "utf-8");

    const wfId = await getWorkflowId(runId);
    emitEvent({
      ts: new Date().toISOString(),
      event: "stories.planned",
      runId,
      workflowId: wfId,
      detail: `Wrote ${stories.length} stories to progress file`,
    });

    logger.info("Story plan written to progress file", { runId, storyCount: stories.length });
  } catch (err) {
    logger.warn("writeStoryPlanToProgress: failed to write progress file", {
      runId,
      error: (err as Error).message,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// Stories CRUD
// ══════════════════════════════════════════════════════════════════════

/**
 * Get all stories for a run, ordered by story_index.
 */
export async function getStories(runId: string): Promise<Story[]> {
  const prisma = getPrisma();
  const rows = await prisma.story.findMany({
    where: { run_id: runId },
    orderBy: { story_index: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    storyIndex: r.story_index,
    storyId: r.story_id,
    title: r.title,
    description: r.description,
    acceptanceCriteria: JSON.parse(r.acceptance_criteria),
    status: r.status,
    output: r.output ?? undefined,
    retryCount: r.retry_count,
    maxRetries: r.max_retries,
  }));
}

/**
 * Get the story currently being worked on by a loop step.
 */
export async function getCurrentStory(stepId: string): Promise<Story | null> {
  const prisma = getPrisma();
  const step = await prisma.step.findUnique({
    where: { id: stepId },
    select: { current_story_id: true },
  });
  if (!step?.current_story_id) return null;
  const row = await prisma.story.findUnique({
    where: { id: step.current_story_id },
  });
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    storyIndex: row.story_index,
    storyId: row.story_id,
    title: row.title,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria),
    status: row.status,
    output: row.output ?? undefined,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
  };
}

/**
 * Format a single story for template interpolation.
 */
export function formatStoryForTemplate(story: Story): string {
  const ac = story.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  return `Story ${story.storyId}: ${story.title}\n\n${story.description}\n\nAcceptance Criteria:\n${ac}`;
}

/**
 * Format completed stories as a summary bullet list.
 */
export function formatCompletedStories(stories: Story[]): string {
  const done = stories.filter((s) => s.status === "done");
  if (done.length === 0) return "(none yet)";
  return done.map((s) => `- ${s.storyId}: ${s.title}`).join("\n");
}

// ══════════════════════════════════════════════════════════════════════
// STORIES_JSON Parsing
// ══════════════════════════════════════════════════════════════════════

/**
 * Parse STORIES_JSON from step output and insert stories into the DB.
 */
export async function parseAndInsertStories(output: string, runId: string): Promise<void> {
  const lines = output.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("STORIES_JSON:"));
  if (startIdx === -1) return;

  const firstLine = lines[startIdx].slice("STORIES_JSON:".length).trim();
  const jsonLines = [firstLine];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^[A-Z_]+:\s/.test(lines[i])) break;
    jsonLines.push(lines[i]);
  }

  const jsonText = jsonLines.join("\n").trim();
  let stories: any[];
  try {
    stories = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Failed to parse STORIES_JSON: ${(e as Error).message}`);
  }

  if (!Array.isArray(stories)) {
    throw new Error("STORIES_JSON must be an array");
  }
  if (stories.length > 20) {
    throw new Error(`STORIES_JSON has ${stories.length} stories, max is 20`);
  }

  const prisma = getPrisma();
  const now = new Date();

  const seenIds = new Set<string>();
  for (let i = 0; i < stories.length; i++) {
    const s = stories[i];
    const ac = s.acceptanceCriteria ?? s.acceptance_criteria;
    if (!s.id || !s.title || !s.description || !Array.isArray(ac) || ac.length === 0) {
      throw new Error(`STORIES_JSON story at index ${i} missing required fields (id, title, description, acceptanceCriteria)`);
    }
    if (seenIds.has(s.id)) {
      throw new Error(`STORIES_JSON has duplicate story id "${s.id}"`);
    }
    seenIds.add(s.id);

    await prisma.story.create({
      data: {
        id: crypto.randomUUID(),
        run_id: runId,
        story_index: i,
        story_id: s.id,
        title: s.title,
        description: s.description,
        acceptance_criteria: JSON.stringify(ac),
        status: "pending",
        retry_count: 0,
        max_retries: 4,
        created_at: now,
        updated_at: now,
      },
    });
  }
}
