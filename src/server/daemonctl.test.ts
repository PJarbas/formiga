import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import the module under test.
// tsx resolves .js extensions to .ts at runtime, so we import the source as .js
import {
  readControlPlanePort,
  writeControlPlanePort,
  isControlPlaneRunning,
  getControlPlaneStatus,
  startControlPlane,
  stopControlPlane,
  getControlPlanePidFile,
  getControlPlanePortFile,
} from "../../dist/server/daemonctl.js";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

// ── Helpers ────────────────────────────────────────────────────────

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

async function getAvailablePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// ── Isolated control plane helpers ────────────────────────────────

function createControlPlaneTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "formiga-daemonctl-cp-"));
}

function getIsolatedControlPlanePidFile(homeDir: string): string {
  return path.join(homeDir, ".formiga", "control-plane.pid");
}

function getIsolatedControlPlanePortFile(homeDir: string): string {
  return path.join(homeDir, ".formiga", "control-plane-port");
}

function readIsolatedControlPlanePort(homeDir: string): number {
  const portFile = getIsolatedControlPlanePortFile(homeDir);
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) return port;
  } catch {}
  return DEFAULT_CONTROL_PORT;
}

function writeIsolatedControlPlanePort(homeDir: string, port: number): void {
  const portFile = getIsolatedControlPlanePortFile(homeDir);
  fs.mkdirSync(path.dirname(portFile), { recursive: true });
  fs.writeFileSync(portFile, String(port), "utf-8");
}

function isIsolatedControlPlaneRunning(homeDir: string): { running: true; pid: number } | { running: false } {
  const pidFile = getIsolatedControlPlanePidFile(homeDir);
  if (!fs.existsSync(pidFile)) return { running: false };

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
  } catch {
    return { running: false };
  }

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}

function stopIsolatedControlPlane(homeDir: string): boolean {
  return stopControlPlane({ homeDir });
}

function cleanupIsolatedControlPlaneFiles(homeDir: string): void {
  try { fs.unlinkSync(getIsolatedControlPlanePidFile(homeDir)); } catch {}
  try { fs.unlinkSync(getIsolatedControlPlanePortFile(homeDir)); } catch {}
}

// ── Control plane file path tests ──────────────────────────────────

const CONTROL_STANDALONE_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "control-standalone.js");

describe("daemonctl control plane file paths", () => {
  it("CONTROL_PLANE_PID_FILE points to ~/.formiga/control-plane.pid", async () => {
    const { CONTROL_PLANE_PID_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PID_FILE.includes(".formiga"));
    assert.ok(CONTROL_PLANE_PID_FILE.endsWith("control-plane.pid"));
  });

  it("CONTROL_PLANE_PORT_FILE points to ~/.formiga/control-plane-port", async () => {
    const { CONTROL_PLANE_PORT_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_PORT_FILE.includes(".formiga"));
    assert.ok(CONTROL_PLANE_PORT_FILE.endsWith("control-plane-port"));
  });

  it("CONTROL_PLANE_LOG_FILE points to ~/.formiga/control-plane.log", async () => {
    const { CONTROL_PLANE_LOG_FILE } = await import("../../dist/server/daemonctl.js");
    assert.ok(CONTROL_PLANE_LOG_FILE.includes(".formiga"));
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
  // AC: DEFAULT_CONTROL_PORT constant is 3339 (no processes spawned)
  it("DEFAULT_CONTROL_PORT constant equals 3339", () => {
    assert.equal(DEFAULT_CONTROL_PORT, 3339);
  });

  // AC: readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists — isolated
  it("readControlPlanePort() returns DEFAULT_CONTROL_PORT (3339) when no port file exists on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);
      const port = readIsolatedControlPlanePort(tempHome);
      assert.equal(port, DEFAULT_CONTROL_PORT);
      assert.equal(port, 3339);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // AC: writeControlPlanePort(4242) persists and read returns 4242 — isolated
  it("writeControlPlanePort(4242) persists and read returns 4242 on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      writeIsolatedControlPlanePort(tempHome, 4242);
      const portFile = getIsolatedControlPlanePortFile(tempHome);
      assert.ok(fs.existsSync(portFile), "Control plane port file should exist after writeControlPlanePort");
      assert.equal(fs.readFileSync(portFile, "utf-8").trim(), "4242");

      const port = readIsolatedControlPlanePort(tempHome);
      assert.equal(port, 4242);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // AC: isControlPlaneRunning() returns false when no PID file exists — isolated
  it("isControlPlaneRunning() returns false when no PID file exists on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);
      const status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // AC: isControlPlaneRunning() returns false for stale PID files — isolated
  it("isControlPlaneRunning() returns false when PID file exists but process is dead on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      // Write a PID file with a PID that almost certainly doesn't exist
      const fakePid = 999999;
      const pidFile = getIsolatedControlPlanePidFile(tempHome);
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, String(fakePid), "utf-8");

      const status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false);

      // Verify it cleaned up the stale PID file
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // AC: getControlPlaneStatus() returns correct state before start — isolated
  it("getControlPlaneStatus() returns correct state before start on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false);

      const port = readIsolatedControlPlanePort(tempHome);
      assert.equal(port, DEFAULT_CONTROL_PORT);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("startControlPlane() spawns server and writes PID/port files on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const result = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.ok(result.pid > 0, "startControlPlane should return a valid PID");
      assert.equal(result.port, controlPort);

      const pidFile = getIsolatedControlPlanePidFile(tempHome);
      assert.ok(fs.existsSync(pidFile));
      const savedPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      assert.equal(savedPid, result.pid);

      const portFile = getIsolatedControlPlanePortFile(tempHome);
      assert.ok(fs.existsSync(portFile));

      const res = await fetch(`http://127.0.0.1:${controlPort}/control/health`);
      assert.equal(res.status, 200);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.status, "ok");

      const afterStatus = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(afterStatus.running, true);
      assert.equal(afterStatus.pid, result.pid);

      const afterPort = readIsolatedControlPlanePort(tempHome);
      assert.equal(afterPort, controlPort);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stopControlPlane() kills control plane process and cleans up files on isolated HOME", async (t) => {
    if (!fs.existsSync(CONTROL_STANDALONE_SCRIPT)) {
      t.skip("control-standalone.js not found — run npm run build first");
      return;
    }

    const controlPort = await getAvailablePort();
    if (!(await canBind(controlPort))) {
      t.skip(`Port ${controlPort} is already in use`);
      return;
    }

    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);

      const { pid } = await startControlPlane(controlPort, { homeDir: tempHome });
      assert.ok(pid > 0);

      let status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, true);

      const stopped = stopControlPlane({ homeDir: tempHome });
      assert.equal(stopped, true);

      const pidFile = getIsolatedControlPlanePidFile(tempHome);
      assert.equal(fs.existsSync(pidFile), false);

      const portFile = getIsolatedControlPlanePortFile(tempHome);
      assert.equal(fs.existsSync(portFile), false);

      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      status = isIsolatedControlPlaneRunning(tempHome);
      assert.equal(status.running, false);

      await waitForHttpDown(`http://127.0.0.1:${controlPort}/control/health`);
    } finally {
      try { stopIsolatedControlPlane(tempHome); } catch {}
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("startControlPlane() reports an unrelated process on the requested port clearly", async () => {
    const tempHome = createControlPlaneTempHome();
    const server = await new Promise<http.Server>((resolve, reject) => {
      const s = http.createServer((_req, res) => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not formiga");
      });
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");

      await assert.rejects(
        () => startControlPlane(address.port, { homeDir: tempHome }),
        /not a healthy Formiga control plane/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("stopControlPlane() returns false when control plane is not running on isolated HOME", () => {
    const tempHome = createControlPlaneTempHome();
    try {
      cleanupIsolatedControlPlaneFiles(tempHome);
      const result = stopControlPlane({ homeDir: tempHome });
      assert.equal(result, false);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
