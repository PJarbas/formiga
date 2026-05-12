import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  buildKanbanSnapshot,
  laneAgentSuffix,
  normaliseStatus,
} from "../../dist/server/kanban-data.js";

function seedDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      run_number INTEGER,
      workflow_id TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT NOT NULL DEFAULT '{}',
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      notify_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      step_index INTEGER NOT NULL,
      input_template TEXT NOT NULL DEFAULT '',
      expects TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'waiting',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      type TEXT NOT NULL DEFAULT 'single',
      loop_config TEXT,
      current_story_id TEXT,
      abandoned_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      story_index INTEGER NOT NULL,
      story_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      output TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 4,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function insertRun(db: DatabaseSync, id: string, status: string, tokens = 0): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) " +
    "VALUES (?, 1, 'feature-dev-merge', 'demo task', ?, '{}', ?, ?, ?)",
  ).run(id, status, tokens, now, now);
}

function insertStep(
  db: DatabaseSync,
  runId: string,
  stepId: string,
  agent: string,
  index: number,
  status: string,
  opts: { type?: string; current_story_id?: string | null; retry?: number } = {},
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, type, current_story_id, retry_count, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, '', '', ?, ?, ?, ?, ?, ?)",
  ).run(
    `step_${runId}_${stepId}`,
    runId,
    stepId,
    `feature-dev-merge_${agent}`,
    index,
    status,
    opts.type ?? "single",
    opts.current_story_id ?? null,
    opts.retry ?? 0,
    now,
    now,
  );
}

function insertStory(
  db: DatabaseSync,
  runId: string,
  storyId: string,
  index: number,
  title: string,
  status: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO stories (id, run_id, story_index, story_id, title, status, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(`story_${runId}_${storyId}`, runId, index, storyId, title, status, now, now);
}

describe("kanban-data: normaliseStatus", () => {
  it("collapses raw statuses into 4 visual buckets", () => {
    assert.equal(normaliseStatus("waiting"), "todo");
    assert.equal(normaliseStatus("pending"), "todo");
    assert.equal(normaliseStatus("running"), "running");
    assert.equal(normaliseStatus("done"), "done");
    assert.equal(normaliseStatus("completed"), "done");
    assert.equal(normaliseStatus("failed"), "failed");
    assert.equal(normaliseStatus("canceled"), "failed");
    assert.equal(normaliseStatus("cancelled"), "failed");
    assert.equal(normaliseStatus(""), "todo");
    assert.equal(normaliseStatus(null), "todo");
    assert.equal(normaliseStatus(undefined), "todo");
    assert.equal(normaliseStatus("RUNNING"), "running");
  });
});

describe("kanban-data: laneAgentSuffix", () => {
  it("returns the role suffix when agent_id is namespaced", () => {
    assert.equal(laneAgentSuffix("feature-dev-merge_developer"), "developer");
    assert.equal(laneAgentSuffix("bug-fix_planner"), "planner");
  });
  it("falls back to the whole id when no underscore is present", () => {
    assert.equal(laneAgentSuffix("solo"), "solo");
  });
});

describe("kanban-data: buildKanbanSnapshot", () => {
  it("returns null for unknown runs", () => {
    const db = seedDb();
    assert.equal(buildKanbanSnapshot(db, "missing"), null);
  });

  it("derives one card per step for single-type lanes", () => {
    const db = seedDb();
    insertRun(db, "r1", "running", 42);
    insertStep(db, "r1", "plan", "planner", 0, "done");
    insertStep(db, "r1", "verify", "verifier", 1, "waiting");

    const snap = buildKanbanSnapshot(db, "r1");
    assert.ok(snap);
    assert.equal(snap.lanes.length, 2);
    assert.equal(snap.lanes[0].agent, "planner");
    assert.equal(snap.lanes[0].label, "Planner");
    assert.equal(snap.lanes[0].status, "done");
    assert.equal(snap.lanes[0].cards.length, 1);
    assert.equal(snap.lanes[0].cards[0].status, "done");
    assert.equal(snap.lanes[1].status, "todo");
    assert.equal(snap.run.tokens_spent, 42);
    assert.equal(snap.currentStoryId, null);
  });

  it("renders stories as cards for loop-type lanes", () => {
    const db = seedDb();
    insertRun(db, "r2", "running");
    insertStep(db, "r2", "plan", "planner", 0, "done");
    insertStep(db, "r2", "implement", "developer", 1, "running", {
      type: "loop",
      current_story_id: "US-002",
    });
    insertStory(db, "r2", "US-001", 0, "First story", "done");
    insertStory(db, "r2", "US-002", 1, "Second story", "pending");
    insertStory(db, "r2", "US-003", 2, "Third story", "pending");

    const snap = buildKanbanSnapshot(db, "r2")!;
    const devLane = snap.lanes.find((l) => l.agent === "developer")!;
    assert.equal(devLane.cards.length, 3);
    assert.equal(devLane.cards[0].status, "done");
    // The current story is promoted from pending → running.
    assert.equal(devLane.cards[1].id, "US-002");
    assert.equal(devLane.cards[1].status, "running");
    assert.equal(devLane.cards[2].status, "todo");
    assert.equal(devLane.summary.done, 1);
    assert.equal(devLane.summary.running, 1);
    assert.equal(devLane.summary.total, 3);
    assert.equal(snap.currentStoryId, "US-002");
  });

  it("does not promote stories when the loop step is already done", () => {
    const db = seedDb();
    insertRun(db, "r3", "completed");
    insertStep(db, "r3", "implement", "developer", 0, "done", {
      type: "loop",
      current_story_id: "US-002",
    });
    insertStory(db, "r3", "US-001", 0, "done one", "done");
    insertStory(db, "r3", "US-002", 1, "stale pointer", "pending");

    const snap = buildKanbanSnapshot(db, "r3")!;
    const devLane = snap.lanes[0];
    // Story stays todo because step.done supersedes a stale current_story_id.
    assert.equal(devLane.cards[1].status, "todo");
  });

  it("shows retry counters in card sub-text when retries are non-zero", () => {
    const db = seedDb();
    insertRun(db, "r4", "running");
    insertStep(db, "r4", "verify", "verifier", 0, "running", { retry: 2 });

    const snap = buildKanbanSnapshot(db, "r4")!;
    assert.match(snap.lanes[0].cards[0].sub, /retry 2\/4/);
  });

  it("orders lanes by step_index", () => {
    const db = seedDb();
    insertRun(db, "r5", "running");
    insertStep(db, "r5", "merge", "merger", 5, "waiting");
    insertStep(db, "r5", "plan", "planner", 0, "done");
    insertStep(db, "r5", "implement", "developer", 1, "running", { type: "loop" });

    const snap = buildKanbanSnapshot(db, "r5")!;
    assert.deepEqual(
      snap.lanes.map((l) => l.agent),
      ["planner", "developer", "merger"],
    );
  });
});
