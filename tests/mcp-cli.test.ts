/**
 * Tests for tamandua mcp CLI commands (US-003).
 *
 * Validates:
 * 1. tamandua mcp start prints PID and endpoint URL
 * 2. tamandua mcp start --port 5555 starts MCP on port 5555
 * 3. tamandua mcp start when already running shows existing status without restarting
 * 4. tamandua mcp status shows running state, PID, port, and endpoint when MCP is up
 * 5. tamandua mcp status shows not running when MCP is down
 * 6. tamandua mcp stop kills MCP process and prints confirmation
 * 7. tamandua mcp stop when not running prints not running message
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled CLI is in dist/cli/
const CLI_SCRIPT = path.resolve(__dirname, "..", "dist", "cli", "cli.js");

// Import daemonctl for direct cleanup (shared PID/port files)
import { stopMcp, isMcpRunning, getMcpStatus, MCP_PID_FILE, MCP_PORT_FILE } from "../src/server/daemonctl.js";
import { DEFAULT_MCP_PORT } from "../src/server/mcp-server.js";

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

async function waitForHttpUp(url: string, timeoutMs = 7000): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 7000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } catch {
      return;
    }
  }

  throw new Error(`Timed out waiting for ${url} to become unreachable`);
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn("node", ["--no-warnings", CLI_SCRIPT, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Filter harmless node warnings from stderr (e.g. SQLite experimental warning)
 * so they don't pollute test assertions.
 */
function cleanStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      if (line.includes("ExperimentalWarning") && line.includes("SQLite")) return false;
      if (line.includes("node --trace-warnings")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function cleanupMcpFiles(): void {
  try { fs.unlinkSync(MCP_PID_FILE); } catch {}
  try { fs.unlinkSync(MCP_PORT_FILE); } catch {}
}

// ── Tests ──────────────────────────────────────────────────────────

describe("tamandua mcp CLI", { concurrency: 1 }, () => {
  before(() => {
    // Best-effort cleanup of any stale MCP that might interfere
    stopMcp();
    cleanupMcpFiles();
  });

  after(() => {
    stopMcp();
    cleanupMcpFiles();
  });

  // AC 5: tamandua mcp status shows not running when MCP is down
  it("mcp status shows not running when MCP is down", async () => {
    cleanupMcpFiles();

    const { stdout, stderr, exitCode } = await runCli(["mcp", "status"]);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running" in output, got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
  });

  // AC 1: tamandua mcp start prints PID and endpoint URL
  it("mcp start prints PID and endpoint URL", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      const { stdout, stderr, exitCode } = await runCli(["mcp", "start"]);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
      assert.ok(stdout.includes("PID"), `Expected "PID" in output, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${DEFAULT_MCP_PORT}`), `Expected port ${DEFAULT_MCP_PORT} in output, got: ${stdout}`);
      assert.ok(stdout.includes("/mcp"), `Expected /mcp endpoint in output, got: ${stdout}`);

      // Verify it actually started
      const status = getMcpStatus();
      assert.equal(status.running, true);
      assert.notEqual(status.pid, null);

      // Verify endpoint reachable
      const res = await waitForHttpUp(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 2: tamandua mcp start --port 5555 starts MCP on port 5555
  it("mcp start --port 5555 starts MCP on port 5555", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const customPort = 5555;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      const { stdout, stderr, exitCode } = await runCli(["mcp", "start", "--port", String(customPort)]);

      assert.equal(exitCode, 0, `CLI exited with code ${exitCode}, stderr: ${cleanStderr(stderr)}`);
      assert.ok(stdout.includes("started"), `Expected "started" in output, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

      // Verify on custom port
      const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500);

      // Verify default port is NOT reachable
      try {
        await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
        assert.fail("MCP should not be reachable on default port when custom port was used");
      } catch {
        // Expected
      }

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 3: tamandua mcp start when already running shows existing status without restarting
  it("mcp start when already running shows existing status", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // First start
      const first = await runCli(["mcp", "start"]);
      assert.equal(first.exitCode, 0);
      assert.ok(first.stdout.includes("started"));

      // Capture the PID from first start
      const runningStatus = getMcpStatus();
      assert.equal(runningStatus.running, true);
      const firstPid = runningStatus.pid;

      // Second start - should show "already running" with the same PID
      const second = await runCli(["mcp", "start"]);
      assert.equal(second.exitCode, 0);
      assert.ok(second.stdout.includes("already running"), `Expected "already running", got: ${second.stdout}`);
      assert.ok(second.stdout.includes(`PID ${firstPid}`), `Expected PID ${firstPid}, got: ${second.stdout}`);
      assert.ok(second.stdout.includes(`localhost:${DEFAULT_MCP_PORT}`));
      assert.ok(second.stdout.includes("/mcp"));
      // Should NOT show "started" (second attempt didn't restart)
      assert.ok(!second.stdout.includes("MCP server started"));

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 4: tamandua mcp status shows running state, PID, port, and endpoint when MCP is up
  it("mcp status shows running state when MCP is up", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // Start MCP
      const start = await runCli(["mcp", "start"]);
      assert.equal(start.exitCode, 0);

      const runningStatus = getMcpStatus();
      assert.equal(runningStatus.running, true);

      // Check status
      const { stdout, stderr, exitCode } = await runCli(["mcp", "status"]);

      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("running"), `Expected "running", got: ${stdout}`);
      assert.ok(stdout.includes(`PID ${runningStatus.pid}`), `Expected PID ${runningStatus.pid}, got: ${stdout}`);
      assert.ok(stdout.includes(`Port: ${runningStatus.port}`), `Expected Port: ${runningStatus.port}, got: ${stdout}`);
      assert.ok(stdout.includes(`localhost:${runningStatus.port}`), `Expected localhost, got: ${stdout}`);
      assert.ok(stdout.includes("/mcp"), `Expected /mcp endpoint, got: ${stdout}`);
      assert.equal(cleanStderr(stderr), "");

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 6: tamandua mcp stop kills MCP process and prints confirmation
  it("mcp stop kills MCP process and prints confirmation", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // Start MCP
      const start = await runCli(["mcp", "start"]);
      assert.equal(start.exitCode, 0);

      // Verify it's running
      let status = getMcpStatus();
      assert.equal(status.running, true);

      // Stop
      const { stdout, stderr, exitCode } = await runCli(["mcp", "stop"]);

      assert.equal(exitCode, 0);
      assert.ok(stdout.includes("stopped"), `Expected "stopped", got: ${stdout}`);
      assert.equal(cleanStderr(stderr), "");

      // Wait for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify it's actually stopped
      status = getMcpStatus();
      assert.equal(status.running, false, "MCP should not be running after stop");

      // Verify PID file is cleaned up
      assert.equal(fs.existsSync(MCP_PID_FILE), false, "PID file should be removed after stop");

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 7: tamandua mcp stop when not running prints not running message
  it("mcp stop when not running prints not running", async () => {
    cleanupMcpFiles();

    // Ensure nothing is running
    stopMcp();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const { stdout, stderr, exitCode } = await runCli(["mcp", "stop"]);

    assert.equal(exitCode, 0);
    assert.ok(stdout.includes("not running"), `Expected "not running", got: ${stdout}`);
    assert.equal(cleanStderr(stderr), "");
  });

  // Extra: verify --port flag parsing works with various formats
  it("mcp start --port with explicit flag parses correctly", async (t) => {
    if (!fs.existsSync(CLI_SCRIPT)) {
      t.skip("CLI script not built — run npm run build first");
      return;
    }

    const customPort = 5556;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // --port flag placed after the start subcommand
      const { stdout, exitCode } = await runCli(["mcp", "start", "--port", String(customPort)]);

      assert.equal(exitCode, 0);
      assert.ok(stdout.includes(`localhost:${customPort}`), `Expected port ${customPort} in output, got: ${stdout}`);

      // Verify endpoint
      const res = await waitForHttpUp(`http://127.0.0.1:${customPort}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500);

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });
});
