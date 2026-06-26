import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TraceTimeline } from "./TraceTimeline.js";
import type { TraceEntry } from "@shared/dashboard-types";

const ENTRIES: TraceEntry[] = [
  { timestamp: "2026-01-01T00:00:00Z", event: "Started", level: "info", detail: "boot" },
  { timestamp: "2026-01-01T00:01:00Z", event: "Warn", level: "warn", detail: "watch out" },
  { timestamp: "2026-01-01T00:02:00Z", event: "Failed", level: "error" },
];

describe("TraceTimeline", () => {
  it("renders an empty state when no entries", () => {
    render(<TraceTimeline entries={[]} />);
    expect(screen.getByTestId("trace-empty")).toBeTruthy();
  });

  it("renders one row per entry", () => {
    render(<TraceTimeline entries={ENTRIES} />);
    expect(screen.getAllByText(/Started|Warn|Failed/)).toHaveLength(3);
  });

  it("expands a row when clicked to show detail", () => {
    render(<TraceTimeline entries={ENTRIES} collapsed />);
    expect(screen.queryByTestId("trace-detail-0")).toBeNull();
    fireEvent.click(screen.getByTestId("trace-row-0"));
    expect(screen.getByTestId("trace-detail-0").textContent).toMatch(/boot/);
  });

  it("tags rows with the level via data-level", () => {
    render(<TraceTimeline entries={ENTRIES} />);
    const rows = screen.getByTestId("trace-timeline").querySelectorAll("li");
    expect(rows[1].getAttribute("data-level")).toBe("warn");
    expect(rows[2].getAttribute("data-level")).toBe("error");
  });
});
