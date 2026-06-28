import { describe, it, expect } from "vitest";
import { STATUS_CONFIG, getStatusConfig, type UIStatus } from "./status-config";

describe("STATUS_CONFIG", () => {
  it("has an entry for every UIStatus key", () => {
    const keys: UIStatus[] = [
      "idle", "pending", "running", "completed", "failed",
      "timed_out", "approved", "rejected", "promoted", "overfitted", "success",
    ];
    for (const key of keys) {
      expect(STATUS_CONFIG[key]).toBeDefined();
      expect(STATUS_CONFIG[key].key).toBe(key);
    }
  });

  it("every entry has required fields", () => {
    for (const [, config] of Object.entries(STATUS_CONFIG)) {
      expect(config.label).toBeTruthy();
      expect(config.emoji).toBeTruthy();
      expect(config.colorVar).toMatch(/^--/);
      expect(config.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(config.dotClass).toBeTruthy();
      expect(config.borderClass).toBeTruthy();
      expect(config.bgClass).toBeTruthy();
      expect(typeof config.priority).toBe("number");
      expect(typeof config.isUrgent).toBe("boolean");
    }
  });

  it("urgent statuses are failed, timed_out, rejected, overfitted", () => {
    const urgentKeys = ["failed", "timed_out", "rejected", "overfitted"];
    for (const key of urgentKeys) {
      expect(STATUS_CONFIG[key as UIStatus].isUrgent).toBe(true);
    }
  });

  it("non-urgent statuses are idle, pending, running, completed, approved, promoted, success", () => {
    const nonUrgentKeys: UIStatus[] = ["idle", "pending", "running", "completed", "approved", "promoted", "success"];
    for (const key of nonUrgentKeys) {
      expect(STATUS_CONFIG[key].isUrgent).toBe(false);
    }
  });
});

describe("getStatusConfig", () => {
  it("returns matching config for known status", () => {
    expect(getStatusConfig("running")).toBe(STATUS_CONFIG.running);
  });

  it("returns idle config for unknown status", () => {
    expect(getStatusConfig("unknown_status")).toBe(STATUS_CONFIG.idle);
  });

  it("returns idle config for empty string", () => {
    expect(getStatusConfig("")).toBe(STATUS_CONFIG.idle);
  });
});