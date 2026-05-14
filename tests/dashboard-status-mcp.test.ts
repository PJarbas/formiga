import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { once } from "node:events";
import { describe, it, after } from "node:test";

const cliPath = path.resolve(process.cwd(), "dist", "cli", "cli.js");
const DEFAULT_MCP_PORT = 3338;

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function createTempEnv(): { root: string; stateDir: string; homeDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dashboard-status-"));
  const stateDir = path.join(root, "state");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  return { root, stateDir, homeDir };
}

async function runCliOnce(args: string[], env: Record<string, string>): Promise<CliResult> {
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
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

async function reserveRandomPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("tamandua dashboard status MCP visibility", () => {
  // Belt-and-suspenders: kill any leaked mcp-standalone/daemon orphans
  after(() => {
    try {
      const pids = execSync(
        "pgrep -f 'mcp-standalone\\.js|daemon\\.js'",
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);

      for (const pid of pids) {
        try {
          const env = execSync(
            `cat /proc/${pid}/environ 2>/dev/null | tr '\\0' '\\n' | grep '^HOME='`,
            { encoding: "utf8" },
          );
          if (env.includes("tamandua-mcp-lifecycle") || env.includes("tamandua-dashboard-status")) {
            process.kill(Number(pid), "SIGKILL");
          }
        } catch {
          // Process may have exited between pgrep and /proc read
        }
      }
    } catch {
      // pgrep may fail if no processes match — that's fine
    }
  });

  // AC 1: Dashboard status shows MCP as independently managed
  it("shows MCP as not running when dashboard is started without MCP", async (t) => {
    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Start dashboard only (without MCP)
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // Check status — MCP should be independently reported as not running
      const status = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(status.code, 0, status.stderr || status.stdout);
      assert.match(status.stdout, /Dashboard running \(PID \d+\)/);
      assert.match(status.stdout, new RegExp(`Dashboard endpoint: http://localhost:${dashboardPort}`));
      assert.match(status.stdout, /MCP server is not running/);

      const stop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(stop.code, 0, stop.stderr || stop.stdout);
    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 1: Dashboard status shows MCP running independently when started via mcp start
  it("shows MCP as independently running after tamandua mcp start", async (t) => {
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use — another test may be using it`);
      return;
    }

    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Start dashboard first
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // Dashboard status should show MCP not running
      const beforeMcp = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(beforeMcp.code, 0, beforeMcp.stderr || beforeMcp.stdout);
      assert.match(beforeMcp.stdout, /MCP server is not running/);

      // Start MCP independently
      const mcpStart = await runCliOnce(["mcp", "start"], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);
      assert.match(mcpStart.stdout, /MCP server started/);

      // Dashboard status should now show MCP as running independently
      const afterMcp = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.equal(afterMcp.code, 0, afterMcp.stderr || afterMcp.stdout);
      assert.match(afterMcp.stdout, /Dashboard running \(PID \d+\)/);
      assert.match(afterMcp.stdout, /MCP server running \(PID \d+\)/);
      assert.match(afterMcp.stdout, new RegExp(`MCP endpoint: http://localhost:${DEFAULT_MCP_PORT}/mcp`));

      // MCP should still be running after dashboard stop
      const dashStop = await runCliOnce(["dashboard", "stop"], cliEnv);
      assert.equal(dashStop.code, 0, dashStop.stderr || dashStop.stdout);

      const afterDashStop = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.match(afterDashStop.stdout, /Dashboard is not running/);
      assert.match(afterDashStop.stdout, /MCP server running \(PID \d+\)/);

      // Stop MCP
      const mcpStop = await runCliOnce(["mcp", "stop"], cliEnv);
      assert.equal(mcpStop.code, 0, mcpStop.stderr || mcpStop.stdout);

      // Both should show not running
      const finalStatus = await runCliOnce(["dashboard", "status"], cliEnv);
      assert.match(finalStatus.stdout, /Dashboard is not running/);
      assert.match(finalStatus.stdout, /MCP server is not running/);
    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 2 & 3: Dashboard HTML shows MCP status section and /api/mcp-status endpoint works
  it("dashboard HTML shows MCP status section with running/stopped state", async (t) => {
    const dashboardPort = await reserveRandomPort();
    const controlPort = await reserveRandomPort();
    const tempEnv = createTempEnv();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Start dashboard
      const start = await runCliOnce(["dashboard", "start", "--port", String(dashboardPort)], cliEnv);
      assert.equal(start.code, 0, start.stderr || start.stdout);

      // AC 2: Check that index.html contains MCP status section
      const htmlRes = await fetch(`http://localhost:${dashboardPort}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.match(html, /MCP Server/);
      assert.match(html, /mcp-status-content/);
      assert.match(html, /fetchMcpStatus/);
      assert.match(html, /fetch\("\/api\/mcp-status"\)/);

      // AC 3: /api/mcp-status returns { running, port, path }
      const apiRes = await fetch(`http://localhost:${dashboardPort}/api/mcp-status`);
      assert.equal(apiRes.status, 200);
      const apiBody = await apiRes.json() as { running: boolean; port: number; path: string };
      assert.equal(typeof apiBody.running, "boolean");
      assert.equal(apiBody.running, false); // MCP not started
      assert.equal(apiBody.port, DEFAULT_MCP_PORT);
      assert.equal(apiBody.path, "/mcp");

      // Start MCP and verify endpoint updates
      if (await canBind(DEFAULT_MCP_PORT)) {
        const mcpStart = await runCliOnce(["mcp", "start"], cliEnv);
        assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);

        const apiResRunning = await fetch(`http://localhost:${dashboardPort}/api/mcp-status`);
        assert.equal(apiResRunning.status, 200);
        const apiBodyRunning = await apiResRunning.json() as { running: boolean; port: number; path: string };
        assert.equal(apiBodyRunning.running, true);
        assert.equal(apiBodyRunning.port, DEFAULT_MCP_PORT);
        assert.equal(apiBodyRunning.path, "/mcp");
      }

    } finally {
      await runCliOnce(["dashboard", "stop"], cliEnv);
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 4: install suggests tamandua mcp start
  it("tamandua install suggests MCP start when MCP is not running", async () => {
    const tempEnv = createTempEnv();
    const controlPort = await reserveRandomPort();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      const install = await runCliOnce(["install"], cliEnv);
      assert.equal(install.code, 0, install.stderr || install.stdout);
      assert.match(install.stdout, /MCP server not started\. To start it: tamandua mcp start/);
    } finally {
      await runCliOnce(["uninstall", "--force"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });

  // AC 5: uninstall stops MCP if running
  it("tamandua uninstall stops MCP if it was running", async (t) => {
    if (!(await canBind(DEFAULT_MCP_PORT))) {
      t.skip(`Port ${DEFAULT_MCP_PORT} is already in use — another test may be using it`);
      return;
    }

    const tempEnv = createTempEnv();
    const controlPort = await reserveRandomPort();
    const cliEnv = {
      HOME: tempEnv.homeDir,
      TAMANDUA_STATE_DIR: tempEnv.stateDir,
      TAMANDUA_CONTROL_PORT: String(controlPort),
    };

    try {
      // Start MCP
      const mcpStart = await runCliOnce(["mcp", "start"], cliEnv);
      assert.equal(mcpStart.code, 0, mcpStart.stderr || mcpStart.stdout);

      // Verify MCP is running
      const mcpStatusBefore = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(mcpStatusBefore.stdout, /MCP server running/);

      // Run uninstall --force
      const uninstall = await runCliOnce(["uninstall", "--force"], cliEnv);
      assert.equal(uninstall.code, 0, uninstall.stderr || uninstall.stdout);
      assert.match(uninstall.stdout, /MCP server stopped/);

      // Verify MCP is no longer running
      const mcpStatusAfter = await runCliOnce(["mcp", "status"], cliEnv);
      assert.match(mcpStatusAfter.stdout, /MCP server is not running/);
    } finally {
      await runCliOnce(["mcp", "stop"], cliEnv);
      fs.rmSync(tempEnv.root, { recursive: true, force: true });
    }
  });
});
