/**
 * Tests for wizard-evaluator.ts
 *
 * Tests import from dist/ (not src/) matching the project convention.
 * No real pi invocations — all spawn calls are faked.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { SpawnOptions } from "node:child_process";

import {
  evaluateWizardResponse,
  extractJsonFromAssistantText,
  processWizardAssistantText,
  type PiSpawnFn,
} from "../../dist/cli/wizard-evaluator.js";

// ── Helpers ─────────────────────────────────────────────────────────

interface FakeChildProcess extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
}

/**
 * Create a fake ChildProcess that emits JSONL output on stdout.
 * The data is written to a PassThrough and ended synchronously.
 * The close event fires on next tick so the evaluator can attach
 * its data listeners first.
 */
function fakeChildProcessWithOutput(jsonlLines: string[]): FakeChildProcess {
  const emitter = new EventEmitter() as FakeChildProcess;
  const stdout = new PassThrough();
  for (const line of jsonlLines) {
    stdout.write(line + "\n");
  }
  stdout.end();
  emitter.stdout = stdout;
  emitter.stderr = new PassThrough();
  (emitter.stderr as PassThrough).end();
  // The "close" event fires after data is fully buffered.
  // Since stdout is already ended and data is in the buffer,
  // emit close on next tick so the evaluator's data listeners
  // are attached by then.
  setImmediate(() => emitter.emit("close", 0));
  return emitter;
}

function fakePiSpawn(child: FakeChildProcess): PiSpawnFn {
  return (_command: string, _args: string[], _options: SpawnOptions) => {
    return child as unknown as import("node:child_process").ChildProcess;
  };
}

/** Build a message_end event line for an assistant message. */
function assistantMessageEndLine(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

// ── Tests: extractJsonFromAssistantText ─────────────────────────────

describe("extractJsonFromAssistantText", () => {
  it("returns raw JSON unchanged", () => {
    const input = '{"ready": false, "question": "hello", "reason": "test"}';
    assert.equal(extractJsonFromAssistantText(input), input);
  });

  it("strips a single ```json fenced block", () => {
    const json =
      '{"ready": true, "commentary": "done", "needsInit": false, "loopArgv": ["autoresearch", "loop", "--prompt"]}';
    const input = "```json\n" + json + "\n```";
    assert.equal(extractJsonFromAssistantText(input), json);
  });

  it("strips a single ``` fenced block (no language tag)", () => {
    const json = '{"ready": false, "question": "q", "reason": "r"}';
    const input = "```\n" + json + "\n```";
    assert.equal(extractJsonFromAssistantText(input), json);
  });

  it("only strips one level of fence", () => {
    const inner = '{"ready": false}';
    const input = "```json\n" + inner + "\n```";
    assert.equal(extractJsonFromAssistantText(input), inner);
  });
});

// ── Tests: processWizardAssistantText ───────────────────────────────

describe("processWizardAssistantText", () => {
  it("returns not-ready for ready:false JSON", () => {
    const result = processWizardAssistantText(
      '{"ready": false, "question": "What metric?", "reason": "Missing metric"}',
      0,
      "",
    );
    assert.equal(result.ready, false);
    assert.equal(result.question, "What metric?");
    assert.equal(result.reason, "Missing metric");
  });

  it("returns ready for ready:true with init", () => {
    const result = processWizardAssistantText(
      JSON.stringify({
        ready: true,
        commentary: "Composed from your answers.",
        needsInit: true,
        initArgv: ["autoresearch", "init", "--goal", "reduce build time"],
        loopArgv: ["autoresearch", "loop", "--prompt"],
      }),
      0,
      "",
    );
    assert.equal(result.ready, true);
    assert.equal(result.commentary, "Composed from your answers.");
    assert.equal(result.needsInit, true);
    assert.deepEqual(result.initArgv, [
      "autoresearch",
      "init",
      "--goal",
      "reduce build time",
    ]);
    assert.deepEqual(result.loopArgv, [
      "autoresearch",
      "loop",
      "--prompt",
    ]);
  });

  it("returns ready for ready:true without init", () => {
    const result = processWizardAssistantText(
      JSON.stringify({
        ready: true,
        commentary: "Already initialized.",
        needsInit: false,
        loopArgv: ["autoresearch", "loop", "--prompt"],
      }),
      0,
      "",
    );
    assert.equal(result.ready, true);
    assert.equal(result.needsInit, false);
    assert.equal(result.initArgv, undefined);
  });

  it("handles ```json fenced block", () => {
    const json = JSON.stringify({
      ready: false,
      question: "What target?",
      reason: "Missing target",
    });
    const fenced = "```json\n" + json + "\n```";
    const result = processWizardAssistantText(fenced, 0, "");
    assert.equal(result.ready, false);
    assert.equal(result.question, "What target?");
  });

  it("throws on invalid JSON", () => {
    assert.throws(
      () => processWizardAssistantText("not valid json {{{", 0, ""),
      /Failed to parse pi JSON response/i,
    );
  });

  it("throws when ready field is missing", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          '{"question": "hello"}',
          0,
          "",
        ),
      /Unknown "ready" value/i,
    );
  });

  it("throws when not-ready is missing question", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          '{"ready": false, "reason": "some reason"}',
          0,
          "",
        ),
      /"question"/i,
    );
  });

  it("throws when not-ready is missing reason", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          '{"ready": false, "question": "q"}',
          0,
          "",
        ),
      /"reason"/i,
    );
  });

  it("throws when ready is missing commentary", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          JSON.stringify({
            ready: true,
            needsInit: false,
            loopArgv: ["autoresearch", "loop", "--prompt"],
          }),
          0,
          "",
        ),
      /"commentary"/i,
    );
  });

  it("throws when needsInit:true but no initArgv", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          JSON.stringify({
            ready: true,
            commentary: "done",
            needsInit: true,
            loopArgv: ["autoresearch", "loop", "--prompt"],
          }),
          0,
          "",
        ),
      /initArgv/i,
    );
  });

  it("throws when needsInit:true but initArgv is null", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          JSON.stringify({
            ready: true,
            commentary: "done",
            needsInit: true,
            initArgv: null,
            loopArgv: ["autoresearch", "loop", "--prompt"],
          }),
          0,
          "",
        ),
      /initArgv/i,
    );
  });

  it("throws when loopArgv is missing", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          JSON.stringify({
            ready: true,
            commentary: "done",
            needsInit: false,
          }),
          0,
          "",
        ),
      /loopArgv/i,
    );
  });

  it("throws when loopArgv is empty", () => {
    assert.throws(
      () =>
        processWizardAssistantText(
          JSON.stringify({
            ready: true,
            commentary: "done",
            needsInit: false,
            loopArgv: [],
          }),
          0,
          "",
        ),
      /loopArgv must not be empty/i,
    );
  });

  it("throws on non-object JSON (array)", () => {
    // Arrays are typeof 'object' in JS, so they pass the object check
    // but fail because arrays don't have a 'ready' property
    assert.throws(
      () => processWizardAssistantText("[1, 2, 3]", 0, ""),
      /Unknown "ready" value/i,
    );
  });

  it("throws on non-object JSON (string)", () => {
    assert.throws(
      () => processWizardAssistantText('"just a string"', 0, ""),
      /Expected a JSON object/i,
    );
  });
});

// ── Tests: evaluateWizardResponse (integration with fake spawn) ─────

describe("evaluateWizardResponse", () => {
  it("returns not-ready via fake spawn + readline", async () => {
    const notReady = {
      ready: false,
      question: "What benchmark?",
      reason: "Missing benchmark",
    };
    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(notReady)),
    ]);
    const spawnFn = fakePiSpawn(child);

    const promise = evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt");
    const result = await promise;
    assert.equal(result.ready, false);
    assert.equal(result.question, "What benchmark?");
  });

  it("returns ready with init via fake spawn + readline", async () => {
    const ready = {
      ready: true,
      commentary: "All set.",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--goal", "reduce build time"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const spawnFn = fakePiSpawn(child);

    const promise = evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt");
    const result = await promise;
    assert.equal(result.ready, true);
    assert.deepEqual(result.initArgv, ready.initArgv);
  });

  it("throws when pi returns no assistant text", async () => {
    const child = fakeChildProcessWithOutput([]);
    const spawnFn = fakePiSpawn(child);

    await assert.rejects(
      evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt"),
      /no assistant text/i,
    );
  });

  it("throws on spawn error", async () => {
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = null;
    child.stderr = null;

    const spawnFn = (_cmd: string, _args: string[], _opts: SpawnOptions) => {
      const cp = child as unknown as import("node:child_process").ChildProcess;
      setImmediate(() => {
        child.emit("error", new Error("spawn ENOENT"));
        child.emit("close", 1);
      });
      return cp;
    };

    await assert.rejects(
      evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt"),
      /Failed to spawn pi/i,
    );
  });

  it("spawns pi with correct args and stdio", async () => {
    let capturedArgs: string[] | undefined;
    let capturedStdio: unknown;
    let capturedCwd: string | undefined;

    const spawnFn: PiSpawnFn = (_cmd, args, opts) => {
      capturedArgs = args;
      capturedStdio = opts.stdio;
      capturedCwd = opts.cwd as string | undefined;

      const child = fakeChildProcessWithOutput([
        assistantMessageEndLine(
          JSON.stringify({
            ready: false,
            question: "q",
            reason: "r",
          }),
        ),
      ]);
      return child as unknown as import("node:child_process").ChildProcess;
    };

    await evaluateWizardResponse(spawnFn, "/custom/cwd", "evaluate this");

    assert.deepEqual(capturedArgs, [
      "--print",
      "--no-session",
      "--mode",
      "json",
      "evaluate this",
    ]);
    assert.deepEqual(capturedStdio, ["ignore", "pipe", "pipe"]);
    assert.equal(capturedCwd, "/custom/cwd");
  });

  it("ignores second error event after first already settled", async () => {
    // Emit error first, then a second error — the second should be ignored
    // by the settled guard.
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = null;
    child.stderr = null;

    const spawnFn = (_cmd: string, _args: string[], _opts: SpawnOptions) => {
      const cp = child as unknown as import("node:child_process").ChildProcess;
      setImmediate(() => {
        child.emit("error", new Error("first error"));
        child.emit("error", new Error("second error — ignored"));
        child.emit("close", 1);
      });
      return cp;
    };

    await assert.rejects(
      evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt"),
      /Failed to spawn pi: first error/i,
    );
  });

  it("ignores close event after error already settled", async () => {
    // Error sets settled, then close fires — close handler should return early.
    const child = new EventEmitter() as FakeChildProcess;
    child.stdout = null;
    child.stderr = null;

    const spawnFn = (_cmd: string, _args: string[], _opts: SpawnOptions) => {
      const cp = child as unknown as import("node:child_process").ChildProcess;
      setImmediate(() => {
        child.emit("error", new Error("spawn ENOENT"));
        child.emit("close", 1);
      });
      return cp;
    };

    await assert.rejects(
      evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt"),
      /Failed to spawn pi/i,
    );
  });

  it("rejects when processWizardAssistantText throws inside close handler", async () => {
    // Return valid JSONL but with text that will fail processWizardAssistantText
    // (missing required field). The close handler's try/catch should reject.
    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(
        JSON.stringify({ ready: true }),
      ),
    ]);
    const spawnFn = fakePiSpawn(child);

    await assert.rejects(
      evaluateWizardResponse(spawnFn, "/tmp/test", "test prompt"),
      /"commentary"/i,
    );
  });
});
