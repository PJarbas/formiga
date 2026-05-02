import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In dev (tsx), compiled output is in dist/server/
const MCP_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");

// Import the module under test.
// tsx resolves .js extensions to .ts at runtime, so we import the source as .js
import {
  readMcpPort,
  writeMcpPort,
  isMcpRunning,
  startMcp,
  stopMcp,
  getMcpStatus,
  MCP_PID_FILE,
  MCP_PORT_FILE,
  getMcpPidFile,
  getMcpPortFile,
} from "./daemonctl.js";
import { DEFAULT_MCP_PORT } from "./mcp-server.js";

// Module-level constants are resolved at import time against the original HOME.
// We use these paths directly rather than hijacking HOME.

async function httpGet(url: string): Promise<Response> {
  return fetch(url);
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

function cleanupMcpFiles(): void {
  try { fs.unlinkSync(MCP_PID_FILE); } catch {}
  try { fs.unlinkSync(MCP_PORT_FILE); } catch {}
}

// ── Tests ──────────────────────────────────────────────────────────

describe("daemonctl MCP lifecycle", { concurrency: 1 }, () => {
  after(() => {
    // Best-effort cleanup of any files created during tests
    cleanupMcpFiles();
  });

  // AC 1: readMcpPort() returns 3338 by default when no port file exists
  it("readMcpPort() returns DEFAULT_MCP_PORT (3338) when no MCP_PORT_FILE exists", () => {
    // Remove port file if it exists to test default
    try { fs.unlinkSync(MCP_PORT_FILE); } catch {}

    const port = readMcpPort();
    assert.equal(port, DEFAULT_MCP_PORT);
    assert.equal(port, 3338);
  });

  // AC 2: writeMcpPort(4242) persists and readMcpPort() returns 4242
  it("writeMcpPort(4242) persists and readMcpPort() returns 4242", () => {
    try {
      writeMcpPort(4242);

      assert.ok(fs.existsSync(MCP_PORT_FILE), "MCP port file should exist after writeMcpPort");
      assert.equal(fs.readFileSync(MCP_PORT_FILE, "utf-8").trim(), "4242");

      const port = readMcpPort();
      assert.equal(port, 4242);
    } finally {
      // Clean up — restore default
      try { fs.unlinkSync(MCP_PORT_FILE); } catch {}
    }
  });

  // AC 3: isMcpRunning() returns false when no MCP PID file exists
  it("isMcpRunning() returns false when no MCP PID file exists", () => {
    try { fs.unlinkSync(MCP_PID_FILE); } catch {}

    const status = isMcpRunning();
    assert.equal(status.running, false);
  });

  // AC 4: startMcp() spawns MCP standalone process, writes PID and port files
  it("startMcp() spawns MCP server and writes PID/port files", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      // Ensure clean state
      cleanupMcpFiles();

      const result = await startMcp();
      assert.ok(result.pid > 0, "startMcp should return a valid PID");
      assert.equal(result.port, DEFAULT_MCP_PORT);

      // Verify PID file exists and contains a valid PID
      assert.ok(fs.existsSync(MCP_PID_FILE), "MCP PID file should exist after startMcp");
      const savedPid = parseInt(fs.readFileSync(MCP_PID_FILE, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      // Verify port file exists
      assert.ok(fs.existsSync(MCP_PORT_FILE), "MCP port file should exist after startMcp");

      // Verify MCP endpoint is reachable
      const res = await httpGet(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500, "MCP endpoint should respond to GET");

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // AC 5: stopMcp() kills the MCP process and cleans up PID file
  it("stopMcp() kills MCP process and cleans up PID file", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // Start the MCP server
      const { pid } = await startMcp();
      assert.ok(pid > 0);

      // Verify it's running
      let status = isMcpRunning();
      assert.equal(status.running, true);

      // Stop it
      const stopped = stopMcp();
      assert.equal(stopped, true);

      // Verify PID file is cleaned up
      assert.equal(fs.existsSync(MCP_PID_FILE), false, "MCP PID file should be cleaned up after stopMcp");

      // Wait briefly for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify process is gone
      status = isMcpRunning();
      assert.equal(status.running, false, "isMcpRunning should return false after stopMcp");

      // Verify endpoint is down
      await waitForHttpDown(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
    } finally {
      try { stopMcp(); } catch {}
      cleanupMcpFiles();
    }
  });

  // AC 6: getMcpStatus() returns correct running state and port after startMcp
  it("getMcpStatus() returns correct state before and after startMcp", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      // Before start: not running
      const beforeStatus = getMcpStatus();
      assert.equal(beforeStatus.running, false);
      assert.equal(beforeStatus.pid, null);
      assert.equal(beforeStatus.port, DEFAULT_MCP_PORT);
      assert.equal(beforeStatus.endpoint, "/mcp");

      // Start MCP
      const { pid } = await startMcp();
      assert.ok(pid > 0);

      // After start: running
      const afterStatus = getMcpStatus();
      assert.equal(afterStatus.running, true);
      assert.equal(afterStatus.pid, pid);
      assert.equal(afterStatus.port, DEFAULT_MCP_PORT);
      assert.equal(afterStatus.endpoint, "/mcp");

    } finally {
      stopMcp();
      cleanupMcpFiles();
    }
  });

  // Round-trip test with custom port
  it("startMcp/stopMcp round-trip with custom port (3340)", async (t) => {
    if (!fs.existsSync(MCP_STANDALONE_SCRIPT)) {
      t.skip("mcp-standalone.js not found — run npm run build first");
      return;
    }

    const customPort = 3340;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupMcpFiles();

      const { pid, port } = await startMcp(customPort);
      assert.ok(pid > 0);
      assert.equal(port, customPort);

      // Verify port file was written with custom port
      assert.equal(readMcpPort(), customPort);

      // Verify endpoint on custom port
      const res = await httpGet(`http://127.0.0.1:${customPort}/mcp`);
      assert.ok(res.status >= 200 && res.status < 500);

      // Stop
      const stopped = stopMcp();
      assert.equal(stopped, true);

      // Verify down
      await waitForHttpDown(`http://127.0.0.1:${customPort}/mcp`);

      // PID file cleaned up
      assert.equal(fs.existsSync(MCP_PID_FILE), false);

      // Status reflects not running after stop
      const status = getMcpStatus();
      assert.equal(status.running, false);

    } finally {
      try { stopMcp(); } catch {}
      cleanupMcpFiles();
    }
  });

  // isMcpRunning() returns false for stale PID files (process no longer alive)
  it("isMcpRunning() returns false when PID file exists but process is dead", () => {
    // Save original state
    let hadOriginalPidFile = false;
    let originalPidContent: string | undefined;
    try {
      hadOriginalPidFile = fs.existsSync(MCP_PID_FILE);
      if (hadOriginalPidFile) {
        originalPidContent = fs.readFileSync(MCP_PID_FILE, "utf-8");
      }
    } catch {}

    try {
      cleanupMcpFiles();

      // Write a PID file with a PID that almost certainly doesn't exist
      const fakePid = 999999;
      fs.mkdirSync(path.dirname(MCP_PID_FILE), { recursive: true });
      fs.writeFileSync(MCP_PID_FILE, String(fakePid), "utf-8");

      const status = isMcpRunning();
      assert.equal(status.running, false);

      // Verify it cleaned up the stale PID file
      assert.equal(fs.existsSync(MCP_PID_FILE), false);
    } finally {
      // Restore original state
      if (hadOriginalPidFile && originalPidContent) {
        try {
          fs.mkdirSync(path.dirname(MCP_PID_FILE), { recursive: true });
          fs.writeFileSync(MCP_PID_FILE, originalPidContent, "utf-8");
        } catch {}
      } else {
        try { fs.unlinkSync(MCP_PID_FILE); } catch {}
      }
    }
  });

  // Verify file path helper exports
  it("getMcpPidFile() and getMcpPortFile() return expected paths", () => {
    const pidFile = getMcpPidFile();
    const portFile = getMcpPortFile();

    assert.ok(pidFile.includes(".tamandua"));
    assert.ok(pidFile.includes("mcp.pid"));
    assert.ok(portFile.includes(".tamandua"));
    assert.ok(portFile.includes("mcp-port"));
  });
});
