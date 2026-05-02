import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { logger, readRecentLogs, getLogPath } from "./logger.js";

describe("logger", () => {
  const logPath = getLogPath();

  it("creates log file on first write", () => {
    assert.doesNotThrow(() => logger.info("test message"));
  });

  it("writes messages to log file", () => {
    logger.info("hello world");
    const content = fs.readFileSync(logPath, "utf-8");
    assert.ok(content.includes("hello world"));
  });

  it("includes timestamp and level", async () => {
    logger.warn("warning test");
    const lines = await readRecentLogs(5);
    const line = lines.find((l: string) => l.includes("warning test"));
    assert.ok(line, "should find the warning line");
    assert.ok(line!.includes("WARN"), "should contain WARN level");
  });

  it("readRecentLogs returns limited lines", async () => {
    for (let i = 0; i < 10; i++) logger.info(`line ${i}`);
    const lines = await readRecentLogs(5);
    assert.ok(lines.length <= 5, "should respect limit");
  });

  it("getLogPath returns a path under .tamandua", () => {
    assert.ok(logPath.includes(".tamandua"));
  });
});
