/**
 * Regression test for issue #89: arena engine must kill the entire process
 * tree on timeout, not just the direct child.
 *
 * Run c682204f leaked a 55-min grid search because `child.kill("SIGTERM")`
 * only signaled the bash parent, leaving the python grandchild orphaned.
 * The fix uses `detached: true` + `process.kill(-pgid)` to kill the group.
 *
 * This test validates the group-kill contract: spawn a detached process
 * that itself spawns a long-lived grandchild, then kill the group and
 * assert the grandchild dies (the regression).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";

/** Mirrors production killProcessTree: signal the whole process group. */
function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already dead */ }
  }
}

function isAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number | null, timeoutMs = 5000): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

describe("arena process-tree kill (issue #89)", () => {
  const spawnedPids: number[] = [];

  afterEach(() => {
    // Best-effort cleanup of any survivors (group + direct).
    for (const pid of spawnedPids) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    spawnedPids.length = 0;
  });

  it("kills the whole tree (parent + grandchild) via process group", async () => {
    // A python parent that spawns a long-lived grandchild and reports its
    // PID via stdout. The parent stays alive waiting (so the group has 2
    // members). Killing the group must kill both.
    const script = `
import os, sys, subprocess, time
g = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(300)"])
sys.stdout.write(str(g.pid) + "\\n"); sys.stdout.flush()
g.wait()
`;
    const child = spawn("python3", ["-c", script], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.pid) spawnedPids.push(child.pid);

    // Read the grandchild's PID from stdout.
    const grandchildPid = await new Promise<number | null>((resolve) => {
      let buf = "";
      const timer = setTimeout(() => resolve(null), 8000);
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const match = buf.match(/(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });

    assert.ok(grandchildPid, "grandchild PID should be emitted");
    assert.ok(isAlive(grandchildPid), "grandchild should be alive before kill");

    // Act: kill the tree the way arena-engine now does (group signal).
    killProcessTree(child, "SIGKILL");

    // Assert: BOTH the parent and the grandchild die.
    const parentDead = await waitForDeath(child.pid, 3000);
    const grandchildDead = await waitForDeath(grandchildPid, 3000);
    assert.ok(parentDead, "parent should be killed");
    assert.ok(grandchildDead, "grandchild should be killed via group signal — the #89 regression");
  });
});
