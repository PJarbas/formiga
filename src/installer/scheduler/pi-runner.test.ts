// ══════════════════════════════════════════════════════════════════════
// pi-runner.test.ts — CR-4/CR-5: runPi must not leak the child.
// ══════════════════════════════════════════════════════════════════════
//
// CR-4: the timeout guard must cover the WHOLE invocation. Previously it
// was only installed after streaming finished, so a wedged run whose stdout
// never closes escaped the timeout and ran forever.
// CR-5: a stream rejection must kill the process group before re-throwing,
// otherwise the detached child outlives runPi.
//
// Both are asserted by capturing the pgid via onSpawn and verifying the
// group is dead after runPi rejects.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPi } from "../../../dist/installer/scheduler/pi-runner.js";

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

describe("runPi CR-4/CR-5 child leak protection", () => {
  let tempHome: string;
  let piPath: string;
  let savedPiBinary: string | undefined;
  const spawnedPgids: number[] = [];

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-pi-runner-"));
    piPath = path.join(tempHome, "pi-mock");
    savedPiBinary = process.env.FORMIGA_PI_BINARY;
    process.env.FORMIGA_PI_BINARY = piPath;
  });

  afterEach(() => {
    if (savedPiBinary === undefined) delete process.env.FORMIGA_PI_BINARY;
    else process.env.FORMIGA_PI_BINARY = savedPiBinary;
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
    makeMockBinary(piPath, `sleep 30`);
    let capturedPgid = 0;
    const runPromise = runPi(["--print", "test"], {
      timeout: 1,
      onSpawn: ({ pgid }) => { capturedPgid = pgid; },
    });

    // onSpawn fires shortly after launch (before the 1s timeout).
    for (let i = 0; i < 20 && capturedPgid === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.notEqual(capturedPgid, 0, "onSpawn should report a pgid");
    spawnedPgids.push(capturedPgid);

    await assert.rejects(runPromise, /pi timed out/);
    assert.equal(await pgidIsDead(capturedPgid), true, "timeout must kill the process group");
  });

  it("kills the child when the stdout stream rejects (CR-5)", async () => {
    // Keeps running so a leaked child would be observable.
    makeMockBinary(piPath, `sleep 30`);
    // A regular file where a directory is required makes the output stream
    // fail (ENOTDIR on mkdir) → streamStdoutWithExtractor rejects.
    const blocker = path.join(tempHome, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    const badOutputFile = path.join(blocker, "sub", "out.log");

    let capturedPgid = 0;
    const runPromise = runPi(["--print", "test"], {
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
});
