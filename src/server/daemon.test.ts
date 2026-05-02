import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT } from "./mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.join(__dirname, "daemon.js");
const DASHBOARD_PORT = 3334;

function spawnDaemon(
  port: number,
  homeDir: string,
  extraArgs: string[] = [],
): {
  child: ChildProcess;
  getOutput: () => string;
} {
  let output = "";
  const child = spawn("node", [DAEMON_SCRIPT, String(port), ...extraArgs], {
    env: {
      ...process.env,
      HOME: homeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf-8");
  });

  return { child, getOutput: () => output };
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 7000): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;

  return await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for daemon process ${child.pid} to exit`));
    }, timeoutMs);

    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code ?? 0);
    });
  });
}

async function forceKillIfAlive(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;

  try {
    process.kill(child.pid, 0);
  } catch {
    return;
  }

  child.kill("SIGKILL");
  await waitForExit(child, 2000).catch(() => {});
}

async function waitForHttpUp(url: string, timeoutMs = 7000): Promise<Response> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await fetch(url);
    } catch (err) {
      lastError = err;
      await sleep(100);
    }
  }

  throw new Error(`Timed out waiting for ${url} to become reachable: ${String(lastError)}`);
}

async function waitForHttpDown(url: string, timeoutMs = 7000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url);
      await sleep(100);
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
      await closeServer(server);
    }
  }
}

async function reserveRandomPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  await closeServer(server);
  return port;
}

describe("dashboard daemon (MCP decoupled)", { concurrency: 1 }, () => {
  it("starts only dashboard by default (no --with-mcp), MCP port is NOT reachable", async (t) => {
    if (!(await canBind(DASHBOARD_PORT))) {
      t.skip(`Port ${DASHBOARD_PORT} is already in use in this environment`);
      return;
    }

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-daemon-home-"));
    const { child } = spawnDaemon(DASHBOARD_PORT, tempHome);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);
      assert.equal(health.status, 200);

      // MCP should NOT be reachable
      let mcpReachable = true;
      try {
        await fetch(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
      } catch {
        mcpReachable = false;
      }
      assert.equal(mcpReachable, false, "MCP port should NOT be reachable without --with-mcp");

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("starts dashboard + MCP with --with-mcp flag and shuts down both on SIGTERM", async (t) => {
    if (!(await canBind(DASHBOARD_PORT))) {
      t.skip(`Port ${DASHBOARD_PORT} is already in use in this environment`);
      return;
    }
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use in this environment`);
      return;
    }

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-daemon-home-"));
    const { child } = spawnDaemon(DASHBOARD_PORT, tempHome, ["--with-mcp"]);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);
      assert.equal(health.status, 200);

      const mcp = await waitForHttpUp(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);
      assert.equal(mcp.status, 400);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);
      await waitForHttpDown(`http://127.0.0.1:${DEFAULT_MCP_PORT}/mcp`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("--with-mcp --mcp-port N starts MCP on custom port", async (t) => {
    const customMcpPort = await reserveRandomPort();

    if (!(await canBind(DASHBOARD_PORT))) {
      t.skip(`Port ${DASHBOARD_PORT} is already in use in this environment`);
      return;
    }

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-daemon-home-"));
    const { child } = spawnDaemon(DASHBOARD_PORT, tempHome, [
      "--with-mcp",
      "--mcp-port",
      String(customMcpPort),
    ]);

    try {
      const health = await waitForHttpUp(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);
      assert.equal(health.status, 200);

      const mcp = await waitForHttpUp(`http://127.0.0.1:${customMcpPort}/mcp`);
      assert.equal(mcp.status, 400);

      process.kill(child.pid!, "SIGTERM");
      const exitCode = await waitForExit(child);
      assert.equal(exitCode, 0);

      await waitForHttpDown(`http://127.0.0.1:${DASHBOARD_PORT}/api/health`);
      await waitForHttpDown(`http://127.0.0.1:${customMcpPort}/mcp`);
    } finally {
      await forceKillIfAlive(child);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("fails startup when MCP port is occupied and --with-mcp is used, dashboard is also stopped", async (t) => {
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use in this environment`);
      return;
    }

    const dashboardPort = await reserveRandomPort();
    const blocker = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("occupied");
    });

    await new Promise<void>((resolve) => blocker.listen(DEFAULT_MCP_PORT, "127.0.0.1", () => resolve()));

    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-daemon-home-"));
    const { child, getOutput } = spawnDaemon(dashboardPort, tempHome, ["--with-mcp"]);

    try {
      const exitCode = await waitForExit(child);
      assert.notEqual(exitCode, 0);

      const output = getOutput();
      assert.match(output, /MCP server on port/i);
      assert.match(output, /already in use|in use/i);

      await waitForHttpDown(`http://127.0.0.1:${dashboardPort}/api/health`);

      const pidFile = path.join(tempHome, ".tamandua", "tamandua.pid");
      assert.equal(fs.existsSync(pidFile), false);
    } finally {
      await forceKillIfAlive(child);
      await closeServer(blocker);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});
