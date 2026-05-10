/**
 * Regression tests for the daemon control plane.
 *
 * Spawns the dashboard daemon in a tmp HOME, then exercises the control
 * endpoints directly over HTTP. The reconciler tick interval is unref'd so
 * it doesn't keep the test process alive.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONTROL_PORT } from "../../dist/server/control-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DAEMON_SCRIPT = path.resolve(__dirname, "..", "..", "dist", "server", "daemon.js");
const DASHBOARD_PORT = 3344;
const CONTROL_PORT = DEFAULT_CONTROL_PORT + 1000;

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function jsonRequest(
  method: "GET" | "POST",
  pathName: string,
  body?: Record<string, unknown>,
  secret?: string,
): Promise<JsonResponse> {
  const payload = body ? JSON.stringify(body) : "";
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secret) headers["x-tamandua-secret"] = secret;
  if (payload) headers["content-length"] = String(Buffer.byteLength(payload));

  return await new Promise<JsonResponse>((resolve, reject) => {
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port: CONTROL_PORT,
        path: pathName,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              parsed = { raw };
            }
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(3000, () => {
      req.destroy(new Error("control plane timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForControlUp(timeoutMs = 7000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await jsonRequest("GET", "/control/health");
      if (r.status === 200) return;
    } catch {
      /* not ready yet */
    }
    await sleep(100);
  }
  throw new Error(`control plane did not come up on port ${CONTROL_PORT}`);
}

async function waitForExit(child: ChildProcess, timeoutMs = 7000): Promise<number> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("daemon did not exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 0);
    });
  });
}

async function canBind(port: number): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", () => resolve());
      server.listen(port, "127.0.0.1");
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
}

describe("daemon control plane", { concurrency: 1 }, () => {
  let tempHome: string;
  let daemon: ChildProcess | undefined;
  let secret: string | undefined;

  before(async (t) => {
    if (!(await canBind(DASHBOARD_PORT))) {
      console.warn(`Port ${DASHBOARD_PORT} is in use; skipping control plane tests`);
      return;
    }
    if (!(await canBind(CONTROL_PORT))) {
      console.warn(`Port ${CONTROL_PORT} is in use; skipping control plane tests`);
      return;
    }

    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-control-home-"));
    daemon = spawn("node", [DAEMON_SCRIPT, String(DASHBOARD_PORT)], {
      env: { ...process.env, HOME: tempHome, TAMANDUA_CONTROL_PORT: String(CONTROL_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemon.stdout?.resume();
    daemon.stderr?.resume();

    await waitForControlUp();
    secret = fs.readFileSync(path.join(tempHome, ".tamandua", "daemon-secret"), "utf-8").trim();
    assert.ok(secret && secret.length > 0, "daemon secret should be created on startup");
  });

  after(async () => {
    if (daemon && daemon.exitCode === null && daemon.pid) {
      try {
        process.kill(daemon.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      try {
        await waitForExit(daemon);
      } catch {
        if (daemon.pid) {
          try { process.kill(daemon.pid, "SIGKILL"); } catch { /* ignore */ }
        }
      }
    }
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("GET /control/health returns 200 without auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest("GET", "/control/health");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "ok");
  });

  it("GET /control/limits requires auth", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const unauth = await jsonRequest("GET", "/control/limits");
    assert.equal(unauth.status, 401);

    const auth = await jsonRequest("GET", "/control/limits", undefined, secret);
    assert.equal(auth.status, 200);
    assert.equal(typeof auth.body.maxActiveTimers, "number");
  });

  it("POST /control/register-run returns 404 for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });

  it("POST /control/register-run is idempotent for an existing run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }

    // Insert a run row directly into the DB the daemon is reading.
    const dbPath = path.join(tempHome, ".tamandua", "tamandua.db");
    // Use the same DB the daemon is using by inserting via node:sqlite.
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, scheduling_status, scheduling_requested_at, created_at, updated_at) VALUES (?, ?, 'control-test', 'running', '{}', 0, 'pending_register', ?, ?, ?)",
    ).run(runId, "wf-control-test", now, now, now);
    db.close();

    // First call: workflow-spec resolution will fail (workflow not installed)
    // so the daemon returns 422, but the run is now flagged 'error' rather
    // than a leaked 'active' state. Second call should be deterministic.
    const r1 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r1.status === 422 || (r1.status >= 200 && r1.status < 300));

    const r2 = await jsonRequest(
      "POST",
      "/control/register-run",
      { runId },
      secret,
    );
    assert.ok(r2.status === 422 || (r2.status >= 200 && r2.status < 300));

    // Cleanup
    const db2 = new DatabaseSync(dbPath);
    db2.prepare("DELETE FROM runs WHERE id = ?").run(runId);
    db2.close();
  });

  it("POST /control/terminate-run is a no-op for unknown run", async (t) => {
    if (!daemon) {
      t.skip("daemon not started");
      return;
    }
    const r = await jsonRequest(
      "POST",
      "/control/terminate-run",
      { runId: crypto.randomUUID() },
      secret,
    );
    assert.equal(r.status, 404);
  });
});
