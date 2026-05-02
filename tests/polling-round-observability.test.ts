import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executePollingRound } from "../dist/installer/agent-scheduler.js";
import { logger } from "../dist/lib/logger.js";

type CapturedLog = {
  level: "info" | "warn" | "error";
  message: string;
  extra?: Record<string, unknown>;
};

function captureLoggerCalls(): {
  calls: CapturedLog[];
  restore: () => void;
} {
  const calls: CapturedLog[] = [];
  const mutableLogger = logger as unknown as {
    info: (message: string, extra?: Record<string, unknown>) => void;
    warn: (message: string, extra?: Record<string, unknown>) => void;
    error: (message: string, extra?: Record<string, unknown>) => void;
  };

  const originalInfo = mutableLogger.info;
  const originalWarn = mutableLogger.warn;
  const originalError = mutableLogger.error;

  mutableLogger.info = (message: string, extra?: Record<string, unknown>) => {
    calls.push({ level: "info", message, extra });
  };
  mutableLogger.warn = (message: string, extra?: Record<string, unknown>) => {
    calls.push({ level: "warn", message, extra });
  };
  mutableLogger.error = (message: string, extra?: Record<string, unknown>) => {
    calls.push({ level: "error", message, extra });
  };

  return {
    calls,
    restore: () => {
      mutableLogger.info = originalInfo;
      mutableLogger.warn = originalWarn;
      mutableLogger.error = originalError;
    },
  };
}

describe("executePollingRound observability", () => {
  it("logs skip/start/complete with bounded output summaries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-polling-round-success-"));
    const fakePi = path.join(tempDir, "pi");
    const longOutput = `STATUS: done\n${"A".repeat(320)}::TAIL_MARKER::`;
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write(${JSON.stringify(longOutput)}); }, 120);\n`,
      "utf-8",
    );
    fs.chmodSync(fakePi, 0o755);

    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    process.env.TAMANDUA_PI_BINARY = fakePi;

    const { calls, restore } = captureLoggerCalls();

    const job = {
      id: "job-observability-success",
      name: "wf/dev",
      workflowId: "wf",
      agentId: "wf_developer",
      intervalMinutes: 5,
      timeoutSeconds: 3,
      workdir: tempDir,
      createdAt: new Date().toISOString(),
    };

    const agent = {
      id: "developer",
      role: "coding" as const,
      pollingModel: "anthropic/claude-sonnet-4-20250514",
      workspace: {
        baseDir: tempDir,
        files: {},
      },
    };

    try {
      const firstRound = executePollingRound(job, agent);
      await executePollingRound(job, agent);
      await firstRound;

      const skipLog = calls.find((entry) => entry.level === "info" && entry.message === "Polling round skipped — previous pi still in flight");
      const startLog = calls.find((entry) => entry.level === "info" && entry.message === "Polling round start");
      const completeLog = calls.find((entry) => entry.level === "info" && entry.message === "Polling round complete");

      assert.ok(skipLog, "expected skip log");
      assert.ok(startLog, "expected start log");
      assert.ok(completeLog, "expected complete log");

      assert.equal(skipLog?.extra?.jobId, job.id);
      assert.equal(skipLog?.extra?.agentId, job.agentId);
      assert.equal(skipLog?.extra?.timeoutSeconds, 3);
      assert.equal(skipLog?.extra?.workdir, tempDir);
      assert.equal(skipLog?.extra?.model, agent.pollingModel);

      assert.equal(startLog?.extra?.jobId, job.id);
      assert.equal(startLog?.extra?.agentId, job.agentId);
      assert.equal(startLog?.extra?.timeoutSeconds, 3);
      assert.equal(startLog?.extra?.workdir, tempDir);
      assert.equal(startLog?.extra?.model, agent.pollingModel);

      assert.equal(completeLog?.extra?.jobId, job.id);
      assert.equal(completeLog?.extra?.agentId, job.agentId);
      assert.equal(completeLog?.extra?.outcome, "work_done");
      assert.equal(completeLog?.extra?.outputTruncated, true);

      const outputPreview = completeLog?.extra?.outputPreview;
      assert.equal(typeof outputPreview, "string");
      assert.ok((outputPreview as string).length <= 241, "output preview should be bounded");
      assert.ok(!(outputPreview as string).includes("::TAIL_MARKER::"), "output preview should not include truncated tail");
      assert.ok((completeLog?.extra?.outputBytes as number) > (outputPreview as string).length);
    } finally {
      restore();
      if (originalPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies heartbeat rounds in completion summary", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-polling-round-heartbeat-"));
    const fakePi = path.join(tempDir, "pi");
    fs.writeFileSync(fakePi, "#!/usr/bin/env node\nprocess.stdout.write('HEARTBEAT_OK');\n", "utf-8");
    fs.chmodSync(fakePi, 0o755);

    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    process.env.TAMANDUA_PI_BINARY = fakePi;

    const { calls, restore } = captureLoggerCalls();

    const job = {
      id: "job-observability-heartbeat",
      name: "wf/dev",
      workflowId: "wf",
      agentId: "wf_developer",
      intervalMinutes: 5,
      timeoutSeconds: 3,
      workdir: tempDir,
      createdAt: new Date().toISOString(),
    };

    const agent = {
      id: "developer",
      role: "coding" as const,
      workspace: {
        baseDir: tempDir,
        files: {},
      },
    };

    try {
      await executePollingRound(job, agent);

      const completeLog = calls.find((entry) => entry.level === "info" && entry.message === "Polling round complete");
      assert.ok(completeLog, "expected completion log");
      assert.equal(completeLog?.extra?.outcome, "heartbeat");
      assert.equal(completeLog?.extra?.outputTruncated, false);
      assert.equal(completeLog?.extra?.outputPreview, "HEARTBEAT_OK");
    } finally {
      restore();
      if (originalPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("logs fail path with bounded error preview and context", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-polling-round-fail-"));
    const fakePi = path.join(tempDir, "pi");
    const longStderr = `${"E".repeat(400)}::ERR_TAIL_MARKER::`;
    fs.writeFileSync(
      fakePi,
      `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(longStderr)});\nprocess.exit(9);\n`,
      "utf-8",
    );
    fs.chmodSync(fakePi, 0o755);

    const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
    process.env.TAMANDUA_PI_BINARY = fakePi;

    const { calls, restore } = captureLoggerCalls();

    const job = {
      id: "job-observability-fail",
      name: "wf/dev",
      workflowId: "wf",
      agentId: "wf_developer",
      intervalMinutes: 5,
      timeoutSeconds: 3,
      workdir: tempDir,
      createdAt: new Date().toISOString(),
    };

    const agent = {
      id: "developer",
      role: "coding" as const,
      model: "anthropic/claude-sonnet-4-20250514",
      workspace: {
        baseDir: tempDir,
        files: {},
      },
    };

    try {
      await executePollingRound(job, agent);

      const startLog = calls.find((entry) => entry.level === "info" && entry.message === "Polling round start");
      const failLog = calls.find((entry) => entry.level === "error" && entry.message === "Polling round failed");

      assert.ok(startLog, "expected start log");
      assert.ok(failLog, "expected fail log");

      assert.equal(failLog?.extra?.jobId, job.id);
      assert.equal(failLog?.extra?.agentId, job.agentId);
      assert.equal(failLog?.extra?.timeoutSeconds, 3);
      assert.equal(failLog?.extra?.workdir, tempDir);
      assert.equal(failLog?.extra?.model, agent.model);
      assert.equal(failLog?.extra?.errorTruncated, true);

      const errorPreview = failLog?.extra?.errorPreview;
      assert.equal(typeof errorPreview, "string");
      assert.ok((errorPreview as string).length <= 241, "error preview should be bounded");
      assert.ok(!(errorPreview as string).includes("::ERR_TAIL_MARKER::"), "error preview should not include truncated tail");
      assert.ok((failLog?.extra?.errorBytes as number) > (errorPreview as string).length);
    } finally {
      restore();
      if (originalPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = originalPiBinary;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
