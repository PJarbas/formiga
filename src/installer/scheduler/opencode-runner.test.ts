// ══════════════════════════════════════════════════════════════════════
// opencode-runner.test.ts — CR-4/CR-5 + arg building for runOpencode.
// ══════════════════════════════════════════════════════════════════════
//
// CR-4: the timeout guard must cover the WHOLE invocation (a wedged stdout
// stream must still die on time).
// CR-5: a stream rejection must kill the process group before re-throwing,
// otherwise the detached child outlives runOpencode.
//
// Also asserts the low-level arg passthrough via a mock binary that logs
// its argv — runOpencode spawns exactly what it's given, so the args the
// wrapper builds are observable here too.
//
// Imported from source (tsx resolves the `.js` → `.ts`) so it runs green
// without a `dist/` build, unlike the dist-importing runner tests.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runOpencode } from "./opencode-runner.js";

function makeMockBinary(binPath: string, behavior: string): void {
  fs.writeFileSync(binPath, `#!/bin/sh\n${behavior}\n`, { mode: 0o755 });
}

/** Poll until the process group is gone, or return false after the timeout. */
async function pgidIsDead(pgid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch {
      return true; // ESRCH — group is gone
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe("runOpencode CR-4/CR-5 child leak protection", () => {
  let tempHome: string;
  let opencodePath: string;
  let savedOpencodeBinary: string | undefined;
  const spawnedPgids: number[] = [];

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-opencode-runner-"));
    opencodePath = path.join(tempHome, "opencode-mock");
    savedOpencodeBinary = process.env.FORMIGA_OPENCODE_BINARY;
    process.env.FORMIGA_OPENCODE_BINARY = opencodePath;
  });

  afterEach(() => {
    if (savedOpencodeBinary === undefined) delete process.env.FORMIGA_OPENCODE_BINARY;
    else process.env.FORMIGA_OPENCODE_BINARY = savedOpencodeBinary;
    // Best-effort: nuke any surviving test groups so a failed assertion
    // can't leave orphaned sleep processes behind.
    for (const pgid of spawnedPgids) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("kills the child when the timeout fires while stdout stays open (CR-4)", async () => {
    // Never writes to stdout and never exits — a wedged run. Only the
    // timeout can end it.
    makeMockBinary(opencodePath, `sleep 30`);
    let capturedPgid = 0;
    const runPromise = runOpencode(["run", "test"], {
      timeout: 1,
      onSpawn: ({ pgid }) => { capturedPgid = pgid; },
    });

    // onSpawn fires shortly after launch (before the 1s timeout).
    for (let i = 0; i < 20 && capturedPgid === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(capturedPgid, 0, "onSpawn should report a pgid");
    spawnedPgids.push(capturedPgid);

    await assert.rejects(runPromise, /opencode timed out/);
    assert.equal(await pgidIsDead(capturedPgid), true, "timeout must kill the process group");
  });

  it("kills the child when the stdout stream rejects (CR-5)", async () => {
    // Keeps running so a leaked child would be observable.
    makeMockBinary(opencodePath, `sleep 30`);
    // A regular file where a directory is required makes the output stream
    // fail (ENOTDIR on mkdir) → streamStdoutWithExtractor rejects.
    const blocker = path.join(tempHome, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    const badOutputFile = path.join(blocker, "sub", "out.log");

    let capturedPgid = 0;
    const runPromise = runOpencode(["run", "test"], {
      timeout: 30,
      outputFile: badOutputFile,
      onSpawn: ({ pgid }) => { capturedPgid = pgid; },
    });
    // Attach the rejection handler synchronously — the mkdir ENOTDIR fires
    // within a few ms, so any await before attaching would make Node report
    // an unhandled rejection instead of our assertion.
    const rejection = assert.rejects(runPromise);

    for (let i = 0; i < 20 && capturedPgid === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(capturedPgid, 0, "onSpawn should report a pgid");
    spawnedPgids.push(capturedPgid);

    await rejection;
    assert.equal(await pgidIsDead(capturedPgid), true, "stream rejection must kill the process group");
  });

  it("spawns the exact argv it was given (observable via mock binary log)", async () => {
    const argsLog = path.join(tempHome, "args.log");
    makeMockBinary(opencodePath, `echo "$@" >> "${argsLog}"`);
    // Run to completion; stdout is empty, so parseArenaAgentOutput has
    // nothing — but the exit-0 path must still complete.
    const result = await runOpencode(["run", "hello world", "--pure", "--auto", "-m", "model-x"], {
      timeout: 30,
    });
    assert.equal(result.exitCode, 0);
    const logged = fs.readFileSync(argsLog, "utf-8").trim();
    assert.equal(logged, "run hello world --pure --auto -m model-x");
  });
});
