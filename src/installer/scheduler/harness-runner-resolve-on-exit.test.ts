import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runPi } from "./pi-runner.js";
import { runOpencode } from "./opencode-runner.js";

// Guards the chronic arena hang (#143): runPi/runOpencode used to resolve only
// when the stdout pipe closed (`for await (const chunk of stdout)` then
// `return await exitPromise`). When the harness spawns a grandchild that
// inherits the stdout fd and outlives it (opencode tool/server processes, pi
// session processes), the pipe never closes and the runner wedged forever —
// the arena froze after generation and the reconciler killed the run as
// "stuck". The fix races the stream drain against the child's exit and tears
// the pipe down on exit, so the runner resolves as soon as the main process
// is gone without losing the transcript already flushed to disk.

/** Structural subset of RunPiOptions/RunOpencodeOptions accepted by both runners. */
interface RunnerOptions {
  timeout?: number;
  workdir?: string;
  outputFile?: string;
}

interface RunnerResult {
  exitCode: number | null;
  outputFile: string;
}

type RunnerFn = (args: string[], opts: RunnerOptions) => Promise<RunnerResult>;

/** Binary that writes a marker, then exits while a grandchild holds the stdout fd open. */
function makeWedgeBinary(binPath: string): void {
  fs.writeFileSync(
    binPath,
    [
      "#!/bin/sh",
      'echo "FAKE_MARKER_OUTPUT"',
      // Keep the main process alive briefly so the runner consumes the marker
      // before we exit (de-flakes the disk-flush assertion below).
      "sleep 1",
      // Background grandchild inherits fd 1 and holds the pipe open well past
      // our exit — this is what wedged the runner before the fix.
      "sleep 30 &",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function makeCleanBinary(binPath: string): void {
  fs.writeFileSync(
    binPath,
    ["#!/bin/sh", 'echo "FAKE_MARKER_OUTPUT"', "exit 0"].join("\n"),
    { mode: 0o755 },
  );
}

/**
 * The write stream is flushed asynchronously when the stdout pipe is torn down
 * (the drain loop rejects, then the finally block ends + flushes the stream).
 * Poll the output file so the assertion doesn't race that flush.
 */
async function waitForMarkerOnDisk(outputFile: string): Promise<void> {
  const deadline = Date.now() + 5000;
  let content = "";
  while (Date.now() < deadline) {
    try {
      content = fs.readFileSync(outputFile, "utf-8");
    } catch {
      content = "";
    }
    if (content.includes("FAKE_MARKER_OUTPUT")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`output file ${outputFile} never received FAKE_MARKER_OUTPUT; last read: ${JSON.stringify(content)}`);
}

describe("harness runner resolves on child exit", () => {
  let tempHome: string;
  let savedPi: string | undefined;
  let savedOpencode: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-runner-exit-"));
    savedPi = process.env.FORMIGA_PI_BINARY;
    savedOpencode = process.env.FORMIGA_OPENCODE_BINARY;
  });

  afterEach(() => {
    if (savedPi === undefined) delete process.env.FORMIGA_PI_BINARY;
    else process.env.FORMIGA_PI_BINARY = savedPi;
    if (savedOpencode === undefined) delete process.env.FORMIGA_OPENCODE_BINARY;
    else process.env.FORMIGA_OPENCODE_BINARY = savedOpencode;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  async function assertWedgeResolves(run: RunnerFn): Promise<void> {
    const workdir = path.join(tempHome, "work");
    fs.mkdirSync(workdir, { recursive: true });
    const outputFile = path.join(tempHome, "out.log");

    const started = Date.now();
    const result = await run(["arg"], {
      timeout: 10, // the mock exits in ~1s; a regression wedges until this fires
      workdir,
      outputFile,
    });
    const elapsedMs = Date.now() - started;

    assert.equal(result.exitCode, 0);
    assert.ok(elapsedMs < 8000, `resolved too slowly (${elapsedMs}ms) — likely wedged until the timeout`);
    await waitForMarkerOnDisk(outputFile);
  }

  it("runPi resolves when the child exits but a grandchild holds the stdout pipe", async () => {
    const binPath = path.join(tempHome, "pi-wedge");
    makeWedgeBinary(binPath);
    process.env.FORMIGA_PI_BINARY = binPath;
    await assertWedgeResolves((args, opts) => runPi(args, opts));
  });

  it("runOpencode resolves when the child exits but a grandchild holds the stdout pipe", async () => {
    const binPath = path.join(tempHome, "opencode-wedge");
    makeWedgeBinary(binPath);
    process.env.FORMIGA_OPENCODE_BINARY = binPath;
    await assertWedgeResolves((args, opts) => runOpencode(args, opts));
  });

  it("runPi still resolves on the normal path (pipe closes naturally)", async () => {
    const binPath = path.join(tempHome, "pi-clean");
    makeCleanBinary(binPath);
    process.env.FORMIGA_PI_BINARY = binPath;

    const outputFile = path.join(tempHome, "out-clean.log");
    const result = await runPi(["arg"], { timeout: 10, workdir: tempHome, outputFile });

    assert.equal(result.exitCode, 0);
    await waitForMarkerOnDisk(outputFile);
  });

  it("runOpencode still reports a non-zero exit as failure", async () => {
    const binPath = path.join(tempHome, "opencode-fail");
    fs.writeFileSync(binPath, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    process.env.FORMIGA_OPENCODE_BINARY = binPath;

    const outputFile = path.join(tempHome, "out-fail.log");
    await assert.rejects(
      () => runOpencode(["arg"], { timeout: 10, workdir: tempHome, outputFile }),
      /exited with code 3/,
    );
  });
});
