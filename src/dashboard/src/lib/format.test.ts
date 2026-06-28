import { describe, it, expect } from "vitest";
import { formatElapsedMs, formatElapsedBetween, formatTime } from "./format";

describe("formatElapsedMs", () => {
  it("formats 0ms as 00:00", () => {
    expect(formatElapsedMs(0)).toBe("00:00");
  });

  it("formats negative as 00:00", () => {
    expect(formatElapsedMs(-100)).toBe("00:00");
  });

  it("formats NaN as 00:00", () => {
    expect(formatElapsedMs(NaN)).toBe("00:00");
  });

  it("formats 65 seconds as 01:05", () => {
    expect(formatElapsedMs(65_000)).toBe("01:05");
  });

  it("formats 45 seconds as 00:45", () => {
    expect(formatElapsedMs(45_000)).toBe("00:45");
  });

  it("formats 3600 seconds as 60:00", () => {
    expect(formatElapsedMs(3_600_000)).toBe("60:00");
  });
});

describe("formatElapsedBetween", () => {
  it("returns — when startedAt is null", () => {
    expect(formatElapsedBetween(null, null)).toBe("—");
  });

  it("computes elapsed between two ISO timestamps", () => {
    const start = "2026-01-01T10:00:00Z";
    const end = "2026-01-01T10:02:30Z";
    expect(formatElapsedBetween(start, end)).toBe("02:30");
  });

  it("uses current time when updatedAt is null", () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const result = formatElapsedBetween(start, null);
    // Should be approximately 01:00
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("formatTime", () => {
  it("formats a valid ISO string", () => {
    const result = formatTime("2026-01-01T14:30:00Z");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
  });

  it("returns raw string for invalid date", () => {
    expect(formatTime("not-a-date")).toBe("not-a-date");
  });
});