import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readEventsFromCursor, type TamanduaEvent } from "../../dist/installer/events.js";

function makeEvent(runId: string, event: string): TamanduaEvent {
  return {
    ts: new Date().toISOString(),
    event,
    runId,
  };
}

describe("readEventsFromCursor", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-events-"));
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns only events appended after the provided global offset", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    const first = makeEvent("run-a", "run.started");
    const second = makeEvent("run-a", "step.running");
    fs.appendFileSync(globalFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf-8");

    const initial = readEventsFromCursor({ kind: "global" }, 0);
    assert.deepEqual(initial.events, [first, second]);

    const third = makeEvent("run-a", "step.done");
    fs.appendFileSync(globalFile, `${JSON.stringify(third)}\n`, "utf-8");

    const appended = readEventsFromCursor({ kind: "global" }, initial.nextOffset);
    assert.deepEqual(appended.events, [third]);

    const nothingNew = readEventsFromCursor({ kind: "global" }, appended.nextOffset);
    assert.deepEqual(nothingNew.events, []);
    assert.equal(nothingNew.nextOffset, appended.nextOffset);
  });

  it("supports run-specific event files", () => {
    const runId = "run-123";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const first = makeEvent(runId, "story.started");
    fs.appendFileSync(runFile, `${JSON.stringify(first)}\n`, "utf-8");

    const initial = readEventsFromCursor({ kind: "run", runId }, 0);
    assert.deepEqual(initial.events, [first]);

    const second = makeEvent(runId, "story.done");
    fs.appendFileSync(runFile, `${JSON.stringify(second)}\n`, "utf-8");

    const appended = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
    assert.deepEqual(appended.events, [second]);
  });

  it("ignores malformed/incomplete JSONL rows while continuing to stream later valid events", () => {
    const runId = "run-malformed";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const first = makeEvent(runId, "run.started");
    fs.appendFileSync(runFile, `${JSON.stringify(first)}\n{\"ts\":\"partial\"`, "utf-8");

    const initial = readEventsFromCursor({ kind: "run", runId }, 0);
    assert.deepEqual(initial.events, [first]);

    const later = makeEvent(runId, "run.completed");
    fs.appendFileSync(runFile, `, invalid}\n${JSON.stringify(later)}\n`, "utf-8");

    const afterMalformed = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
    assert.deepEqual(afterMalformed.events, [later]);
  });
});
