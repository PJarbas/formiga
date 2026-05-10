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
  readControlPlanePort,
  writeControlPlanePort,
  isControlPlaneRunning,
  getControlPlaneStatus,
  startControlPlane,
  stopControlPlane,
  CONTROL_PLANE_PID_FILE,
  CONTROL_PLANE_PORT_FILE,
  getControlPlanePidFile,
  getControlPlanePortFile,
} from "../../dist/server/daemonctl.js";
import { DEFAULT_MCP_PORT } from "../../dist/server/mcp-server.js";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

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

// ── Control plane file path tests ──────────────────────────────────

const CONTROL_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");

function cleanupControlPlaneFiles(): void {
  try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}
  try { fs.unlinkSync(CONTROL_PLANE_PORT_FILE); } catch {}
}

describe("daemonctl control plane file paths", () => {
  it("CONTROL_PLANE_PID_FILE points to ~/.tamandua/control-plane.pid", async () => {
    const { CONTROL_PLANE_PID_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PID_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_PID_FILE.endsWith("control-plane.pid"));
  });

  it("CONTROL_PLANE_PORT_FILE points to ~/.tamandua/control-plane-port", async () => {
    const { CONTROL_PLANE_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PORT_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_PORT_FILE.endsWith("control-plane-port"));
  });

  it("CONTROL_PLANE_LOG_FILE points to ~/.tamandua/control-plane.log", async () => {
    const { CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_LOG_FILE.includes(".tamandua"));
    assert.ok(CONTROL_PLANE_LOG_FILE.endsWith("control-plane.log"));
  });

  it("getControlPlanePidFile() returns CONTROL_PLANE_PID_FILE", async () => {
    const { getControlPlanePidFile, CONTROL_PLANE_PID_FILE } = await import("../../dist/server/daemonctl.js");
    assert.equal(getControlPlanePidFile(), CONTROL_PLANE_PID_FILE);
  });

  it("getControlPlanePortFile() returns CONTROL_PLANE_PORT_FILE", async () => {
    const { getControlPlanePortFile, CONTROL_PLANE_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.equal(getControlPlanePortFile(), CONTROL_PLANE_PORT_FILE);
  });

  it("getControlPlaneLogFile() returns CONTROL_PLANE_LOG_FILE", async () => {
    const { getControlPlaneLogFile, CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    assert.equal(getControlPlaneLogFile(), CONTROL_PLANE_LOG_FILE);
  });

  it("control plane paths are distinct from MCP paths", async () => {
    const { CONTROL_PLANE_PID_FILE, CONTROL_PLANE_PORT_FILE, CONTROL_PLANE_LOG_FILE, MCP_PID_FILE, MCP_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.notEqual(CONTROL_PLANE_PID_FILE, MCP_PID_FILE);
    assert.notEqual(CONTROL_PLANE_PORT_FILE, MCP_PORT_FILE);
    assert.ok(CONTROL_PLANE_LOG_FILE.includes("control-plane.log"));
  });

  it("all control plane paths resolve via os.homedir()", async () => {
    const os = await import("node:os");
    const { CONTROL_PLANE_PID_FILE, CONTROL_PLANE_PORT_FILE, CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    const home = os.homedir();
    assert.ok(CONTROL_PLANE_PID_FILE.startsWith(home));
    assert.ok(CONTROL_PLANE_PORT_FILE.startsWith(home));
    assert.ok(CONTROL_PLANE_LOG_FILE.startsWith(home));
  });
});

// ── Control plane lifecycle tests ─────────────────────────────────

describe("daemonctl control plane lifecycle", { concurrency: 1 }, () => {
  after(() => {
    // Best-effort cleanup of any files created during tests
    cleanupControlPlaneFiles();
  });

  // AC 1: readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists
  it("readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists", () => {
    // Remove port file if it exists to test default
    try { fs.unlinkSync(CONTROL_PLANE_PORT_FILE); } catch {}

    const port = readControlPlanePort();
    assert.equal(port, DEFAULT_CONTROL_PORT);
    assert.equal(port, 3339);
  });

  // AC 2: writeControlPlanePort(4242) persists and readControlPlanePort() returns 4242
  it("writeControlPlanePort(4242) persists and readControlPlanePort() returns 4242", () => {
    try {
      writeControlPlanePort(4242);

      assert.ok(fs.existsSync(CONTROL_PLANE_PORT_FILE), "Control plane port file should exist after writeControlPlanePort");
      assert.equal(fs.readFileSync(CONTROL_PLANE_PORT_FILE, "utf-8").trim(), "4242");

      const port = readControlPlanePort();
      assert.equal(port, 4242);
    } finally {
      // Clean up — restore default
      try { fs.unlinkSync(CONTROL_PLANE_PORT_FILE); } catch {}
    }
  });

  // AC 3: isControlPlaneRunning() returns false when no PID file exists
  it("isControlPlaneRunning() returns false when no PID file exists", () => {
    try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}

    const status = isControlPlaneRunning();
    assert.equal(status.running, false);
  });

  // AC 4: isControlPlaneRunning() returns false when PID file exists but process is dead
  it("isControlPlaneRunning() returns false when PID file exists but process is dead", () => {
    // Save original state
    let hadOriginalPidFile = false;
    let originalPidContent: string | undefined;
    try {
      hadOriginalPidFile = fs.existsSync(CONTROL_PLANE_PID_FILE);
      if (hadOriginalPidFile) {
        originalPidContent = fs.readFileSync(CONTROL_PLANE_PID_FILE, "utf-8");
      }
    } catch {}

    try {
      cleanupControlPlaneFiles();

      // Write a PID file with a PID that almost certainly doesn't exist
      const fakePid = 999999;
      fs.mkdirSync(path.dirname(CONTROL_PLANE_PID_FILE), { recursive: true });
      fs.writeFileSync(CONTROL_PLANE_PID_FILE, String(fakePid), "utf-8");

      const status = isControlPlaneRunning();
      assert.equal(status.running, false);

      // Verify it cleaned up the stale PID file
      assert.equal(fs.existsSync(CONTROL_PLANE_PID_FILE), false);
    } finally {
      // Restore original state
      if (hadOriginalPidFile && originalPidContent) {
        try {
          fs.mkdirSync(path.dirname(CONTROL_PLANE_PID_FILE), { recursive: true });
          fs.writeFileSync(CONTROL_PLANE_PID_FILE, originalPidContent, "utf-8");
        } catch {}
      } else {
        try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}
      }
    }
  });

  // AC 5: getControlPlaneStatus() returns correct state before start
  it("getControlPlaneStatus() returns correct state before start", () => {
    try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}
    try { fs.unlinkSync(CONTROL_PLANE_PORT_FILE); } catch {}

    const status = getControlPlaneStatus();
    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.equal(status.port, DEFAULT_CONTROL_PORT);
    assert.equal(status.endpoint, "/control/health");
  });

  // AC 6: startControlPlane() spawns server, writes PID/port files, health endpoint reachable
  it("startControlPlane() spawns server and writes PID/port files", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      // Ensure clean state
      cleanupControlPlaneFiles();

      const result = await startControlPlane();
      assert.ok(result.pid > 0, "startControlPlane should return a valid PID");
      assert.equal(result.port, DEFAULT_CONTROL_PORT);

      // Verify PID file exists and contains a valid PID
      assert.ok(fs.existsSync(CONTROL_PLANE_PID_FILE), "Control plane PID file should exist after startControlPlane");
      const savedPid = parseInt(fs.readFileSync(CONTROL_PLANE_PID_FILE, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      // Verify port file exists
      assert.ok(fs.existsSync(CONTROL_PLANE_PORT_FILE), "Control plane port file should exist after startControlPlane");

      // Verify health endpoint is reachable
      const res = await fetch(`http://127.0.0.1:${DEFAULT_CONTROL_PORT}/control/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, "ok");

      // Verify getControlPlaneStatus after start
      const afterStatus = getControlPlaneStatus();
      assert.equal(afterStatus.running, true);
      assert.equal(afterStatus.pid, result.pid);
      assert.equal(afterStatus.port, DEFAULT_CONTROL_PORT);
      assert.equal(afterStatus.endpoint, "/control/health");
    } finally {
      stopControlPlane();
      cleanupControlPlaneFiles();
    }
  });

  // AC 7: stopControlPlane() kills process and cleans up files
  it("stopControlPlane() kills control plane process and cleans up files", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      // Start the control plane
      const { pid } = await startControlPlane();
      assert.ok(pid > 0);

      // Verify it's running
      let status = isControlPlaneRunning();
      assert.equal(status.running, true);

      // Stop it
      const stopped = stopControlPlane();
      assert.equal(stopped, true);

      // Verify PID file is cleaned up
      assert.equal(fs.existsSync(CONTROL_PLANE_PID_FILE), false, "Control plane PID file should be cleaned up after stopControlPlane");

      // Verify port file is cleaned up
      assert.equal(fs.existsSync(CONTROL_PLANE_PORT_FILE), false, "Control plane port file should be cleaned up after stopControlPlane");

      // Wait briefly for process to fully exit
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify process is gone
      status = isControlPlaneRunning();
      assert.equal(status.running, false, "isControlPlaneRunning should return false after stopControlPlane");

      // Verify health endpoint is down
      await waitForHttpDown(`http://127.0.0.1:${DEFAULT_CONTROL_PORT}/control/health`);
    } finally {
      try { stopControlPlane(); } catch {}
      cleanupControlPlaneFiles();
    }
  });

  // AC 8: Round-trip test with custom port
  it("startControlPlane/stopControlPlane round-trip with custom port (3341)", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const customPort = 3341;
    if (!(await canBind(customPort))) {
      t.skip(`Port ${customPort} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      const { pid, port } = await startControlPlane(customPort);
      assert.ok(pid > 0);
      assert.equal(port, customPort);

      // Verify port file was written with custom port
      assert.equal(readControlPlanePort(), customPort);

      // Verify health endpoint on custom port
      const res = await fetch(`http://127.0.0.1:${customPort}/control/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, "ok");

      // Stop
      const stopped = stopControlPlane();
      assert.equal(stopped, true);

      // Verify down
      await waitForHttpDown(`http://127.0.0.1:${customPort}/control/health`);

      // PID file cleaned up
      assert.equal(fs.existsSync(CONTROL_PLANE_PID_FILE), false);

      // Port file cleaned up
      assert.equal(fs.existsSync(CONTROL_PLANE_PORT_FILE), false);

      // Status reflects not running after stop
      const status = getControlPlaneStatus();
      assert.equal(status.running, false);
    } finally {
      try { stopControlPlane(); } catch {}
      cleanupControlPlaneFiles();
    }
  });

  // AC 9: startControlPlane() returns already-running info when already up
  it("startControlPlane() returns existing info when already running", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    if (!(await canBind(DEFAULT_CONTROL_PORT))) {
      t.skip(`Port ${DEFAULT_CONTROL_PORT} is already in use`);
      return;
    }

    try {
      cleanupControlPlaneFiles();

      const first = await startControlPlane();
      assert.ok(first.pid > 0);

      // Second call should detect already running
      const second = await startControlPlane();
      assert.equal(second.pid, first.pid);
      assert.equal(second.port, first.port);
    } finally {
      try { stopControlPlane(); } catch {}
      cleanupControlPlaneFiles();
    }
  });

  // AC 10: stopControlPlane() returns false when nothing is running
  it("stopControlPlane() returns false when control plane is not running", () => {
    try { fs.unlinkSync(CONTROL_PLANE_PID_FILE); } catch {}

    const result = stopControlPlane();
    assert.equal(result, false);
  });
});
