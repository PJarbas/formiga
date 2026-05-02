/**
 * Tamandua Dashboard Daemon
 *
 * Runs the dashboard server, optionally alongside the MCP server.
 *
 * - Reads dashboard port from ~/.tamandua/port
 * - Dashboard listens on configured port (default fallback 3333)
 * - MCP is only started when --with-mcp is passed (default port 3338)
 * - Writes PID file on start (~/.tamandua/tamandua.pid)
 * - Cleans up PID file on exit
 *
 * CLI flags:
 *   [port]          Dashboard port (positional, overridden by ~/.tamandua/port)
 *   --with-mcp      Start MCP server alongside the dashboard
 *   --mcp-port N    Custom MCP port (only meaningful with --with-mcp)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDashboardServer } from "./dashboard.js";
import {
  DEFAULT_MCP_PORT,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "./mcp-server.js";

const PID_FILE = path.join(os.homedir(), ".tamandua", "tamandua.pid");
const PORT_FILE = path.join(os.homedir(), ".tamandua", "port");

interface DaemonArgs {
  withMcp: boolean;
  mcpPort: number;
  dashboardPort: number;
}

function parseArgs(): DaemonArgs {
  const argv = process.argv.slice(2);
  let withMcp = false;
  let mcpPort = DEFAULT_MCP_PORT;
  let dashboardPort = 0; // 0 means not set via CLI

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--with-mcp") {
      withMcp = true;
    } else if (arg === "--mcp-port") {
      const portStr = argv[i + 1];
      if (!portStr) {
        console.error("--mcp-port requires a port number");
        process.exit(1);
      }
      const port = parseInt(portStr, 10);
      if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid MCP port: ${portStr}`);
        process.exit(1);
      }
      mcpPort = port;
      i++; // consume next arg
    } else if (!arg.startsWith("--")) {
      const port = parseInt(arg, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        dashboardPort = port;
      }
    }
  }

  return { withMcp, mcpPort, dashboardPort };
}

function readPort(cliPort: number): number {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid port in ${PORT_FILE}: ${raw}`);
    }
    return port;
  } catch {
    // Fallback: use CLI arg, then default
    if (cliPort > 0) return cliPort;
    return 3333;
  }
}

function writePidFile(): void {
  const dir = path.dirname(PID_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PID_FILE)) {
      const saved = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (saved === process.pid) {
        fs.unlinkSync(PID_FILE);
      }
    }
  } catch {
    // Best effort
  }
}

function closeDashboardServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function formatMcpBindError(port: number, err: unknown): string {
  const nodeErr = err as NodeJS.ErrnoException;
  if (nodeErr?.code === "EADDRINUSE") {
    return `Failed to start MCP server on port ${port}: port is already in use. Stop the conflicting process and retry.`;
  }

  return `Failed to start MCP server on port ${port}: ${
    err instanceof Error ? err.message : String(err)
  }`;
}

const args = parseArgs();
const dashboardPort = readPort(args.dashboardPort);

let dashboardServer: http.Server | undefined;
let mcpServer: TamanduaMcpServer | undefined;
let isShuttingDown = false;

async function stopListeners(): Promise<void> {
  const stops: Promise<unknown>[] = [];

  if (mcpServer) {
    const currentMcpServer = mcpServer;
    mcpServer = undefined;
    stops.push(stopTamanduaMcpServer(currentMcpServer));
  }

  if (dashboardServer) {
    const currentDashboardServer = dashboardServer;
    dashboardServer = undefined;
    stops.push(closeDashboardServer(currentDashboardServer));
  }

  if (stops.length > 0) {
    await Promise.allSettled(stops);
  }
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Tamandua daemon received ${signal}, shutting down...`);

  await stopListeners();
  cleanupPidFile();

  process.exit(exitCode);
}

async function failStartup(err: unknown): Promise<void> {
  console.error(formatMcpBindError(args.mcpPort, err));
  await stopListeners();
  cleanupPidFile();
  process.exit(1);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM", 0);
});
process.on("SIGINT", () => {
  void shutdown("SIGINT", 0);
});
process.on("SIGHUP", () => {
  void shutdown("SIGHUP", 0);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in daemon:", reason);
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in daemon:", err);
  void shutdown("uncaughtException", 1);
});

process.on("exit", cleanupPidFile);

async function bootstrap(): Promise<void> {
  writePidFile();

  dashboardServer = createDashboardServer(dashboardPort, {
    onError: (err) => {
      if (!isShuttingDown) {
        console.error(`Dashboard listener failed on port ${dashboardPort}: ${err.message}`);
      }
      void shutdown("dashboard-error", 1);
    },
  });

  if (args.withMcp) {
    try {
      mcpServer = await startTamanduaMcpServer(args.mcpPort);
    } catch (err) {
      await failStartup(err);
      return;
    }

    console.log(
      `Tamandua dashboard daemon started on port ${dashboardPort} and MCP port ${args.mcpPort} (pid ${process.pid})`,
    );
  } else {
    console.log(
      `Tamandua dashboard daemon started on port ${dashboardPort} (pid ${process.pid})`,
    );
  }
}

void bootstrap();
