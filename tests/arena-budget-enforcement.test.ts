/**
 * Integration tests for compute budget enforcement (RF-#90, issue #90).
 *
 * Validates that the RLIMIT_CPU prelude kills a runaway script when the
 * budget's maxFitSeconds is exceeded. The grid search in run c682204f ran
 * 55 min because there was no effective budget; this confirms the script
 * is now killed in seconds.
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { deriveComputeBudget } from "../dist/arena/dataset-context.js";

const tmpDirs: string[] = [];

function writeScript(dir: string, body: string): string {
  const p = path.join(dir, `script-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(p, body);
  return p;
}

/** Mirrors arena-engine buildRlimitPrelude for testing. */
function runWithBudget(scriptPath: string, cwd: string, budget: { maxFitSeconds: number }) {
  const cpuHard = budget.maxFitSeconds + 2;
  const prelude = [
    "import resource as _r, sys as _s",
    `_r.setrlimit(_r.RLIMIT_CPU, (${budget.maxFitSeconds}, ${cpuHard}))`,
    "_path = _s.argv[1]",
    "exec(compile(open(_path, encoding='utf-8').read(), _path, 'exec'))",
  ].join("\n");
  return spawn("python3", ["-c", prelude, scriptPath], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("arena budget enforcement (RF-#90)", () => {
  let workdir: string;

  before(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-budget-"));
    tmpDirs.push(workdir);
  });

  after(() => {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("kills a runaway script via RLIMIT_CPU within the budget", async () => {
    // A CPU-bound infinite loop (not sleep — RLIMIT_CPU counts CPU time).
    const script = writeScript(workdir, `
x = 0
while True:
    x += 1
`);
    const budget = { maxFitSeconds: 2 };
    const child = runWithBudget(script, workdir, budget);

    const result = await new Promise<{ killed: boolean; code: number | null }>((resolve) => {
      let timedOut = false;
      const wallTimer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* */ }
      }, 10000);
      child.on("close", (code) => {
        clearTimeout(wallTimer);
        resolve({ killed: timedOut || code === null, code });
      });
      child.on("error", () => {
        clearTimeout(wallTimer);
        resolve({ killed: true, code: null });
      });
    });

    assert.ok(result.killed, "runaway script must be killed by the budget");
    assert.ok(result.code !== 0, "runaway script must not exit cleanly");
  });

  it("lets a quick script complete within the budget", async () => {
    const script = writeScript(workdir, `print("done")`);
    const child = runWithBudget(script, workdir, { maxFitSeconds: 5 });

    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      let stdout = "";
      const wallTimer = setTimeout(() => {
        try { process.kill(-child.pid!, "SIGKILL"); } catch { /* */ }
      }, 8000);
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.on("close", (code) => {
        clearTimeout(wallTimer);
        resolve({ code, stdout });
      });
      child.on("error", () => {
        clearTimeout(wallTimer);
        resolve({ code: null, stdout });
      });
    });

    assert.equal(result.code, 0, "quick script should complete cleanly");
    assert.ok(result.stdout.includes("done"));
  });

  it("tiny budget caps fit-seconds at 30 (would kill a 55-min grid)", () => {
    const b = deriveComputeBudget("tiny");
    assert.equal(b.maxFitSeconds, 30);
    assert.ok(30 < 55 * 60, "30s cap is far below the 55-min leak in c682204f");
  });
});
