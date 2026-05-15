import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getPidFile,
  getPortFile,
  getLogFile,
  isRunning,
  getDaemonStatus,
  stopDaemon,
} from "../../dist/server/daemonctl.js";

describe("daemonctl dashboard helpers", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-dctl-"));
    process.env.HOME = tempHome;
    fs.mkdirSync(path.join(tempHome, ".tamandua"), { recursive: true });
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try { stopDaemon(); } catch {}
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  describe("path helpers", () => {
    it("getPidFile returns path ending with tamandua.pid", () => {
      const p = getPidFile();
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("tamandua.pid"));
    });

    it("getPortFile returns path ending with port", () => {
      const p = getPortFile();
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("port"));
    });

    it("getLogFile returns path ending with dashboard.log", () => {
      const p = getLogFile();
      assert.ok(p.includes(".tamandua"));
      assert.ok(p.endsWith("dashboard.log"));
    });
  });

  describe("isRunning / getDaemonStatus (no daemon running)", () => {
    it("isRunning returns false when no PID file", () => {
      const result = isRunning();
      assert.equal(result.running, false);
    });

    it("getDaemonStatus returns not running state", () => {
      const status = getDaemonStatus();
      assert.equal(status.running, false);
      assert.equal(status.pid, null);
    });
  });
});
