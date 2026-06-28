/**
 * Formiga Dashboard Daemon
 *
 * Runs the dashboard server.
 *
 * - Reads dashboard port from ~/.formiga/port
 * - Dashboard listens on configured port (default fallback 3333)
 * - Writes PID file on start (~/.formiga/formiga.pid)
 * - Cleans up PID file on exit
 *
 * CLI flags:
 *   [port]          Dashboard port (positional, overridden by ~/.formiga/port)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDashboardServer } from "./dashboard.js";
import {
  ensureDaemonSecret,
  getControlPort,
  startControlServer,
  startReconciler,
} from "./control-server.js";
import { shutdownAllCrons } from "../installer/agent-scheduler.js";
import { findPiBinary } from "../installer/scheduler/binary-discovery.js";

const PID_FILE = path.join(os.homedir(), ".formiga", "formiga.pid");
const PORT_FILE = path.join(os.homedir(), ".formiga", "port");

interface DaemonArgs {
  dashboardPort: number;
}

function parseArgs(): DaemonArgs {
  const argv = process.argv.slice(2);
  let dashboardPort = 0; // 0 means not set via CLI

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      const port = parseInt(arg, 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        dashboardPort = port;
      }
    }
  }

  return { dashboardPort };
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

const args = parseArgs();
const dashboardPort = readPort(args.dashboardPort);

let dashboardServer: http.Server | undefined;
let controlServer: http.Server | undefined;
let reconciler: { stop: () => void } | undefined;
let isShuttingDown = false;

async function stopListeners(): Promise<void> {
  const stops: Promise<unknown>[] = [];

  // Stop reconciler first so it doesn't fight teardown.
  if (reconciler) {
    reconciler.stop();
    reconciler = undefined;
  }

  try {
    shutdownAllCrons();
  } catch (err) {
    console.error("Error during scheduler shutdown:", err);
  }

  if (dashboardServer) {
    const currentDashboardServer = dashboardServer;
    dashboardServer = undefined;
    stops.push(closeDashboardServer(currentDashboardServer));
  }

  if (controlServer) {
    const currentControlServer = controlServer;
    controlServer = undefined;
    stops.push(closeDashboardServer(currentControlServer));
  }

  if (stops.length > 0) {
    await Promise.allSettled(stops);
  }
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`Formiga daemon received ${signal}, shutting down...`);

  await stopListeners();
  cleanupPidFile();

  process.exit(exitCode);
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

// --- Event Loop Watchdog ---
// Detects when the event loop is blocked (stuck daemon) and self-terminates.
const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_EVENT_LOOP_LAG_MS = 30_000;

function startEventLoopWatchdog(): void {
  let lastHeartbeat = Date.now();

  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - lastHeartbeat - HEARTBEAT_INTERVAL_MS;
    lastHeartbeat = now;

    if (lag > MAX_EVENT_LOOP_LAG_MS) {
      console.error(
        `[watchdog] Event loop blocked for ${lag}ms (threshold: ${MAX_EVENT_LOOP_LAG_MS}ms). Daemon is stuck — self-terminating.`,
      );
      cleanupPidFile();
      process.exit(2);
    }
  }, HEARTBEAT_INTERVAL_MS);

  timer.unref();
}

async function bootstrap(): Promise<void> {
  // Validate harness availability before anything else.
  // The daemon cannot function without a harness to run agents.
  try {
    const piPath = findPiBinary();
    console.log(`Harness available: ${piPath}`);
  } catch (err) {
    console.error(
      `FATAL: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(
      "Daemon cannot function without a harness (pi). Exiting.",
    );
    process.exit(1);
  }

  writePidFile();

  dashboardServer = createDashboardServer(dashboardPort, {
    onError: (err) => {
      if (!isShuttingDown) {
        console.error(`Dashboard listener failed on port ${dashboardPort}: ${err.message}`);
      }
      void shutdown("dashboard-error", 1);
    },
  });

  // Always start the run-scoped scheduling control plane. If the control
  // port can't bind, surface a clear error rather than silently degrading.
  try {
    const secret = ensureDaemonSecret();
    const controlPort = getControlPort();
    controlServer = await startControlServer({ port: controlPort, secret });
    reconciler = startReconciler();
    console.log(
      `Formiga control plane listening on http://127.0.0.1:${controlPort} (pid ${process.pid})`,
    );
  } catch (err) {
    console.error(
      `Failed to start control plane: ${err instanceof Error ? err.message : String(err)}`,
    );
    await stopListeners();
    cleanupPidFile();
    process.exit(1);
    return;
  }

  // Start event loop watchdog to detect stuck daemon.
  startEventLoopWatchdog();

  console.log(
    `Formiga dashboard daemon started on port ${dashboardPort} (pid ${process.pid})`,
  );
}

void bootstrap();
