/**
 * Tamandua Dashboard Daemon Lifecycle Controller
 *
 * Manages the lifecycle of the tamandua dashboard daemon process.
 *
 * - PID file:    ~/.tamandua/tamandua.pid
 * - Port file:   ~/.tamandua/port
 * - Log file:    ~/.tamandua/dashboard.log
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_MCP_PORT, MCP_ENDPOINT_PATH } from "./mcp-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TAMANDUA_DIR = path.join(os.homedir(), ".tamandua");
const PID_FILE = path.join(TAMANDUA_DIR, "tamandua.pid");
const PORT_FILE = path.join(TAMANDUA_DIR, "port");
const LOG_FILE = path.join(TAMANDUA_DIR, "dashboard.log");
const STARTUP_ERROR_TAIL_LINES = 20;

// ── MCP file paths ─────────────────────────────────────────────────

export const MCP_PID_FILE = path.join(TAMANDUA_DIR, "mcp.pid");
export const MCP_PORT_FILE = path.join(TAMANDUA_DIR, "mcp-port");
const MCP_LOG_FILE = path.join(TAMANDUA_DIR, "mcp.log");

// ── File path helpers ───────────────────────────────────────────────

export function getPidFile(): string {
  return PID_FILE;
}

export function getPortFile(): string {
  return PORT_FILE;
}

export function getLogFile(): string {
  return LOG_FILE;
}

export function getMcpPidFile(): string {
  return MCP_PID_FILE;
}

export function getMcpPortFile(): string {
  return MCP_PORT_FILE;
}

function readLogTail(logPath: string = LOG_FILE, lines = STARTUP_ERROR_TAIL_LINES): string {
  try {
    if (!fs.existsSync(logPath)) return "";
    const content = fs.readFileSync(logPath, "utf-8").trim();
    if (!content) return "";
    return content.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// ── Port management ─────────────────────────────────────────────────

export function readPort(): number {
  try {
    const raw = fs.readFileSync(PORT_FILE, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return 3333; // default
}

export function writePort(port: number): void {
  fs.mkdirSync(TAMANDUA_DIR, { recursive: true });
  fs.writeFileSync(PORT_FILE, String(port), "utf-8");
}

// ── Process status ──────────────────────────────────────────────────

/**
 * Check if a process is running by reading its PID file and testing
 * with kill(0). Cleans up stale PID files on mismatch.
 */
function checkPidFile(pidFile: string): { running: true; pid: number } | { running: false } {
  if (!fs.existsSync(pidFile)) return { running: false };

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (isNaN(pid)) return { running: false };
  } catch {
    return { running: false };
  }

  try {
    // kill(pid, 0) doesn't send a signal — it just checks if the process exists
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Process doesn't exist — clean up stale PID file
    try {
      fs.unlinkSync(pidFile);
    } catch {
      // Best effort
    }
    return { running: false };
  }
}

/**
 * Check if the daemon process is running.
 * Uses PID file and kill(0) for existence check.
 */
export function isRunning(): { running: true; pid: number } | { running: false } {
  return checkPidFile(PID_FILE);
}

/**
 * Get daemon status (dashboard only — MCP is independently managed).
 */
export function getDaemonStatus(): { running: false; pid: null; port: number } | { running: true; pid: number; port: number } {
  const status = isRunning();
  if (!status.running) {
    return { running: false, pid: null, port: readPort() };
  }

  return {
    running: true,
    pid: status.pid,
    port: readPort(),
  };
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Options for startDaemon / startMcp. */
export interface StartOptions {
  /**
   * When true, skips child.unref() and includes the ChildProcess handle
   * in the return value. Callers can use child.kill() for direct cleanup.
   * Default: false (production detached/unref behavior).
   */
  keepHandle?: boolean;
  /**
   * When set, use this directory instead of ~/.tamandua for all
   * filesystem operations (PID, port, and log files). Also passed as
   * HOME to the spawned child process. Useful in tests that use
   * isolated temp directories.
   */
  homeDir?: string;
}

/**
 * Start the dashboard daemon.
 *
 * Spawns a detached node process running dist/server/daemon.js.
 * Writes the port to ~/.tamandua/port before spawning.
 *
 * If the daemon is already running, returns its info without restarting.
 *
 * @param port  Dashboard port (default 3333).
 * @param opts  When keepHandle is true, returns the ChildProcess handle.
 */
export async function startDaemon(port?: number): Promise<{ pid: number; port: number }>;
export async function startDaemon(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startDaemon(port = 3333, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = opts?.homeDir ? path.join(opts.homeDir, ".tamandua") : TAMANDUA_DIR;
  const pidFile = opts?.homeDir ? path.join(tamanduaDir, "tamandua.pid") : PID_FILE;
  const portFile = opts?.homeDir ? path.join(tamanduaDir, "port") : PORT_FILE;
  const logFile = opts?.homeDir ? path.join(tamanduaDir, "dashboard.log") : LOG_FILE;

  const status = checkPidFile(pidFile);
  if (status.running) {
    let existingPort = port;
    try {
      const raw = fs.readFileSync(portFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use the requested port
    }
    return { pid: status.pid, port: existingPort };
  }

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(portFile, String(port), "utf-8");

  const out = fs.openSync(logFile, "a");
  const errFd = fs.openSync(logFile, "a");

  const daemonScript = path.resolve(__dirname, "daemon.js");
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn("node", [daemonScript, String(port)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait briefly for the daemon to start and write its PID file
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  const check = checkPidFile(pidFile);
  if (!check.running) {
    const logTail = readLogTail(logFile);
    if (logTail) {
      throw new Error(`Daemon failed to start. Recent daemon log:\n${logTail}`);
    }

    throw new Error("Daemon failed to start. Check " + logFile);
  }

  if (opts?.keepHandle) {
    return { pid: check.pid, port, child };
  }

  return { pid: check.pid, port };
}

/**
 * Stop the dashboard daemon.
 *
 * Sends SIGTERM to the daemon process and cleans up the PID file.
 * Returns true if a daemon was stopped, false if none was running.
 */
export function stopDaemon(): boolean {
  const status = isRunning();
  if (!status.running) return false;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the daemon also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Best effort
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════
// MCP standalone lifecycle management
// ═══════════════════════════════════════════════════════════════════

/**
 * Resolve the mcp-standalone.js path.
 * In production (compiled JS), the file lives alongside daemonctl.js in dist/server/.
 * In development (tsx on-the-fly transpilation), the compiled output is in dist/server/.
 */
function resolveStandaloneScript(): string {
  // Production: same directory as daemonctl.js (dist/server/)
  const prodPath = path.resolve(__dirname, "mcp-standalone.js");
  if (fs.existsSync(prodPath)) return prodPath;

  // Development (tsx): compiled output lives in dist/server/
  const devPath = path.resolve(__dirname, "..", "..", "dist", "server", "mcp-standalone.js");
  if (fs.existsSync(devPath)) return devPath;

  // Fallback: return prodPath so the caller gets a clear error
  return prodPath;
}

/**
 * Read the MCP port from the MCP port file.
 * Returns DEFAULT_MCP_PORT (3338) when no port file exists.
 */
export function readMcpPort(): number {
  try {
    const raw = fs.readFileSync(MCP_PORT_FILE, "utf-8").trim();
    const port = parseInt(raw, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      return port;
    }
  } catch {
    // File doesn't exist or is invalid
  }
  return DEFAULT_MCP_PORT;
}

/**
 * Write the MCP port to the MCP port file.
 */
export function writeMcpPort(port: number): void {
  fs.mkdirSync(TAMANDUA_DIR, { recursive: true });
  fs.writeFileSync(MCP_PORT_FILE, String(port), "utf-8");
}

/**
 * Check if the standalone MCP server is running.
 * Uses the MCP PID file and kill(0) for existence check.
 */
export function isMcpRunning(): { running: true; pid: number } | { running: false } {
  return checkPidFile(MCP_PID_FILE);
}

/**
 * Get full MCP status.
 */
export function getMcpStatus(): {
  running: boolean;
  pid: number | null;
  port: number;
  endpoint: string;
} {
  const status = isMcpRunning();
  const port = readMcpPort();
  return {
    running: status.running,
    pid: status.running ? status.pid : null,
    port,
    endpoint: MCP_ENDPOINT_PATH,
  };
}

/**
 * Start the standalone MCP server.
 *
 * Spawns a detached node process running dist/server/mcp-standalone.js.
 * Writes PID and port files that the spawned process also updates.
 * Waits for startup and checks health.
 *
 * If the MCP server is already running, returns its info without restarting.
 */
export async function startMcp(port?: number): Promise<{ pid: number; port: number }>;
export async function startMcp(port: number, opts: StartOptions & { keepHandle: true }): Promise<{ pid: number; port: number; child: ChildProcess }>;
export async function startMcp(port?: number, opts?: StartOptions): Promise<{ pid: number; port: number } | { pid: number; port: number; child: ChildProcess }> {
  // When homeDir is set, compute isolated paths for all filesystem operations.
  const tamanduaDir = opts?.homeDir ? path.join(opts.homeDir, ".tamandua") : TAMANDUA_DIR;
  const mcpPidFile = opts?.homeDir ? path.join(tamanduaDir, "mcp.pid") : MCP_PID_FILE;
  const mcpPortFile = opts?.homeDir ? path.join(tamanduaDir, "mcp-port") : MCP_PORT_FILE;
  const mcpLogFile = opts?.homeDir ? path.join(tamanduaDir, "mcp.log") : MCP_LOG_FILE;

  const status = checkPidFile(mcpPidFile);
  if (status.running) {
    let existingPort: number = DEFAULT_MCP_PORT;
    try {
      const raw = fs.readFileSync(mcpPortFile, "utf-8").trim();
      const p = parseInt(raw, 10);
      if (!isNaN(p) && p > 0 && p < 65536) existingPort = p;
    } catch {
      // File missing or unreadable — use default
    }
    return { pid: status.pid, port: existingPort };
  }

  const mcpPort = port ?? DEFAULT_MCP_PORT;

  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(mcpPortFile, String(mcpPort), "utf-8");

  const out = fs.openSync(mcpLogFile, "a");
  const errFd = fs.openSync(mcpLogFile, "a");

  const standaloneScript = resolveStandaloneScript();
  const spawnOpts: Parameters<typeof spawn>[2] = {
    detached: true,
    stdio: ["ignore", out, errFd],
  };
  if (opts?.homeDir) {
    spawnOpts.env = { ...process.env, HOME: opts.homeDir };
  }
  const child = spawn("node", [standaloneScript, String(mcpPort)], spawnOpts);

  if (opts?.keepHandle) {
    // Caller wants the ChildProcess handle for direct cleanup (e.g. tests).
    // Don't unref — the handle keeps the event loop alive, which is fine
    // because the caller is responsible for killing the child.
  } else {
    child.unref();
  }

  // Wait briefly for the MCP server to start and write its PID file
  await new Promise<void>((resolve) => setTimeout(resolve, 1500));

  const check = checkPidFile(mcpPidFile);
  if (!check.running) {
    const logTail = readLogTail(mcpLogFile);
    if (logTail) {
      throw new Error(`MCP server failed to start. Recent MCP log:\n${logTail}`);
    }
    throw new Error("MCP server failed to start. Check " + mcpLogFile);
  }

  if (opts?.keepHandle) {
    return { pid: check.pid, port: mcpPort, child };
  }

  return { pid: check.pid, port: mcpPort };
}

/**
 * Stop the standalone MCP server.
 *
 * Sends SIGTERM to the MCP process and cleans up the PID file.
 * Returns true if an MCP server was stopped, false if none was running.
 */
export function stopMcp(): boolean {
  const status = isMcpRunning();
  if (!status.running) return false;

  try {
    process.kill(status.pid, "SIGTERM");
  } catch {
    // Process may have already exited
  }

  // Clean up PID file — the MCP process also cleans up on exit,
  // but we do it here as a safety measure
  try {
    fs.unlinkSync(MCP_PID_FILE);
  } catch {
    // Best effort
  }

  // Clean up port file so a fresh start can pick a different port
  try {
    fs.unlinkSync(MCP_PORT_FILE);
  } catch {
    // Best effort
  }

  return true;
}
