import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPrisma, resetPrisma } from "../../../dist/database/index.js";
import { getDb } from "../../../dist/db.js";
import {
  recordAgentEvent,
  flushAgentEventQueue,
} from "../../../dist/server/routes/agent-activity.js";

// Temp-DB helper (same pattern as dashboard.test.ts).
function makeTempDb(): { cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-agent-activity-"));
  const homeDir = path.join(root, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const dbPath = path.join(homeDir, ".formiga", "formiga.db");
  const previousHome = process.env.HOME;
  const previousDbPath = process.env.FORMIGA_DB_PATH;
  process.env.HOME = homeDir;
  process.env.FORMIGA_DB_PATH = dbPath;
  return {
    cleanup() {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousDbPath === undefined) delete process.env.FORMIGA_DB_PATH;
      else process.env.FORMIGA_DB_PATH = previousDbPath;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

let env: ReturnType<typeof makeTempDb>;

describe("agent activity batching (M-4)", () => {
  beforeEach(async () => {
    env = makeTempDb();
    await resetPrisma();
    getDb(); // opens + migrates the scratch DB
  });

  afterEach(async () => {
    // Drain any queued events so a failed test can't leak into the next one.
    await flushAgentEventQueue().catch(() => {});
    await resetPrisma();
    env.cleanup();
  });

  it("buffers events and persists them only when the queue is flushed", async () => {
    const prisma = getPrisma();
    await prisma.run.create({
      data: {
        id: "run1",
        workflow_id: "wf",
        task: "task",
        created_at: new Date(),
        updated_at: new Date(),
      },
    });

    await recordAgentEvent({
      runId: "run1",
      stepId: "step1",
      agentId: "a1",
      eventType: "tool_call",
      toolName: "bash",
      toolResult: "ok",
    });
    await recordAgentEvent({
      runId: "run1",
      stepId: "step1",
      agentId: "a1",
      eventType: "thinking",
      thinking: "hmm",
    });
    await recordAgentEvent({
      runId: "run1",
      stepId: "step1",
      agentId: "a1",
      eventType: "step_event",
      stepEvent: "completed",
    });

    assert.equal(await prisma.agentEvent.count(), 0, "no rows should exist before the flush");

    await flushAgentEventQueue();
    assert.equal(await prisma.agentEvent.count(), 3);

    const rows = await prisma.agentEvent.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      rows.map((r) => r.event_type),
      ["tool_call", "thinking", "step_event"],
    );
    assert.equal(rows[0].tool_name, "bash");
    assert.equal(rows[2].step_event, "completed");
  });

  it("flushing an empty queue is a no-op", async () => {
    await flushAgentEventQueue();
    assert.equal(await getPrisma().agentEvent.count(), 0);
  });
});
