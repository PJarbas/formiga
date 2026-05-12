/**
 * Kanban data shaping
 *
 * Reads steps + stories for a single run and returns a lane-grouped snapshot
 * for the kanban view. Lanes are derived dynamically from the run's steps so
 * any workflow shape renders correctly, not just the canonical
 * planner→setup→developer→verifier→tester→merger pipeline.
 *
 * Status normalisation collapses the storage statuses (waiting/pending/
 * running/done/failed/canceled) into four visual buckets:
 *
 *   - "todo"    → waiting, pending
 *   - "running" → running
 *   - "done"    → done, completed
 *   - "failed"  → failed, canceled, cancelled
 *
 * For loop steps (e.g. the developer step that iterates over user stories),
 * the lane's cards are the stories. For single steps, the lane has one card
 * representing the step itself.
 */
import type { DatabaseSync } from "node:sqlite";

export type VisualStatus = "todo" | "running" | "done" | "failed";

export interface KanbanCard {
  /** Card identifier shown in the chip (story_id for stories, step_id for steps). */
  id: string;
  /** Card body title. */
  title: string;
  /** Collapsed visual status. */
  status: VisualStatus;
  /** Short supplementary line — e.g. "retry 2/4" or last-updated time. */
  sub: string;
}

export interface KanbanLane {
  /** Agent role suffix (e.g. "developer"). Stable across workflows. */
  agent: string;
  /** Display label (e.g. "Developer"). */
  label: string;
  /** The step_id this lane represents in the workflow. */
  stepId: string;
  /** Step type — "single" or "loop". */
  stepType: string;
  /** Collapsed status for the lane as a whole. */
  status: VisualStatus;
  cards: KanbanCard[];
  summary: { done: number; failed: number; running: number; total: number };
}

export interface KanbanRunMeta {
  id: string;
  run_number: number | null;
  workflow_id: string;
  task: string;
  status: string;
  tokens_spent: number;
  created_at: string;
  updated_at: string;
}

export interface KanbanSnapshot {
  run: KanbanRunMeta;
  lanes: KanbanLane[];
  currentStoryId: string | null;
  /** Server-side wall clock, for client elapsed/skew calculations. */
  generatedAt: string;
}

interface StepRow {
  id: string;
  step_id: string;
  agent_id: string;
  step_index: number;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  type: string;
  current_story_id: string | null;
  updated_at: string;
}

interface StoryRow {
  story_id: string;
  story_index: number;
  title: string;
  status: string;
  retry_count: number | null;
  max_retries: number | null;
  updated_at: string;
}

interface RunRow {
  id: string;
  run_number: number | null;
  workflow_id: string;
  task: string;
  status: string;
  tokens_spent: number;
  created_at: string;
  updated_at: string;
}

const RUNNING_STATUSES = new Set(["running"]);
const DONE_STATUSES = new Set(["done", "completed"]);
const FAILED_STATUSES = new Set(["failed", "canceled", "cancelled"]);

export function normaliseStatus(raw: string | null | undefined): VisualStatus {
  if (!raw) return "todo";
  const s = String(raw).toLowerCase();
  if (RUNNING_STATUSES.has(s)) return "running";
  if (DONE_STATUSES.has(s)) return "done";
  if (FAILED_STATUSES.has(s)) return "failed";
  return "todo";
}

export function laneAgentSuffix(agentId: string): string {
  const idx = agentId.lastIndexOf("_");
  return idx >= 0 ? agentId.slice(idx + 1) : agentId;
}

function humanLabel(agent: string): string {
  if (!agent) return "Step";
  return agent.charAt(0).toUpperCase() + agent.slice(1).replace(/[-_]/g, " ");
}

function summarise(cards: KanbanCard[]): KanbanLane["summary"] {
  let done = 0;
  let failed = 0;
  let running = 0;
  for (const c of cards) {
    if (c.status === "done") done++;
    else if (c.status === "failed") failed++;
    else if (c.status === "running") running++;
  }
  return { done, failed, running, total: cards.length };
}

function laneStatusFromStepAndCards(
  stepStatus: VisualStatus,
  cards: KanbanCard[],
): VisualStatus {
  // The step itself is the source of truth, but for a loop step we may want to
  // surface "running" while the step row still says "pending" between story
  // claim cycles. Mirror what the cards collectively show in that case.
  if (stepStatus !== "todo") return stepStatus;
  if (cards.some((c) => c.status === "running")) return "running";
  if (cards.length > 0 && cards.every((c) => c.status === "done")) return "done";
  if (cards.some((c) => c.status === "failed")) return "failed";
  return "todo";
}

function storyCardSub(story: StoryRow): string {
  if ((story.retry_count ?? 0) > 0) {
    return `retry ${story.retry_count}/${story.max_retries ?? "?"}`;
  }
  return `updated ${story.updated_at}`;
}

function stepCardSub(step: StepRow): string {
  if ((step.retry_count ?? 0) > 0) {
    return `retry ${step.retry_count}/${step.max_retries ?? "?"}`;
  }
  return `updated ${step.updated_at}`;
}

/**
 * Build a kanban snapshot for one run. Returns null if the run does not exist.
 *
 * Visible for testing: takes a DatabaseSync handle directly so tests can pass
 * a temp-home db without monkey-patching getDb().
 */
export function buildKanbanSnapshot(
  db: DatabaseSync,
  runId: string,
): KanbanSnapshot | null {
  const run = db.prepare(`
    SELECT id, run_number, workflow_id, task, status, tokens_spent, created_at, updated_at
    FROM runs WHERE id = ?
  `).get(runId) as unknown as RunRow | undefined;

  if (!run) return null;

  const steps = db.prepare(`
    SELECT id, step_id, agent_id, step_index, status, retry_count, max_retries,
           type, current_story_id, updated_at
    FROM steps WHERE run_id = ?
    ORDER BY step_index ASC
  `).all(runId) as unknown as StepRow[];

  const stories = db.prepare(`
    SELECT story_id, story_index, title, status, retry_count, max_retries, updated_at
    FROM stories WHERE run_id = ?
    ORDER BY story_index ASC
  `).all(runId) as unknown as StoryRow[];

  // The current story is whichever story the (single) loop step claims.
  const loopStep = steps.find((s) => s.type === "loop");
  const currentStoryId = loopStep?.current_story_id ?? null;

  const lanes: KanbanLane[] = steps.map((step) => {
    const agent = laneAgentSuffix(step.agent_id);
    const label = humanLabel(agent);
    let cards: KanbanCard[];
    if (step.type === "loop") {
      cards = stories.map((story) => {
        let cardStatus = normaliseStatus(story.status);
        // Promote the claimed story to "running" while the loop step is alive.
        if (
          cardStatus === "todo" &&
          currentStoryId &&
          story.story_id === currentStoryId &&
          normaliseStatus(step.status) !== "done" &&
          normaliseStatus(step.status) !== "failed"
        ) {
          cardStatus = "running";
        }
        return {
          id: story.story_id,
          title: story.title,
          status: cardStatus,
          sub: storyCardSub(story),
        };
      });
    } else {
      cards = [{
        id: step.step_id,
        title: `${label} step`,
        status: normaliseStatus(step.status),
        sub: stepCardSub(step),
      }];
    }

    const stepStatus = normaliseStatus(step.status);
    return {
      agent,
      label,
      stepId: step.step_id,
      stepType: step.type,
      status: laneStatusFromStepAndCards(stepStatus, cards),
      cards,
      summary: summarise(cards),
    };
  });

  return {
    run: {
      id: run.id,
      run_number: run.run_number,
      workflow_id: run.workflow_id,
      task: run.task,
      status: run.status,
      tokens_spent: run.tokens_spent ?? 0,
      created_at: run.created_at,
      updated_at: run.updated_at,
    },
    lanes,
    currentStoryId,
    generatedAt: new Date().toISOString(),
  };
}
