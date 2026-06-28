import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";

describe("StatusBadge", () => {
  it("renders the status label from STATUS_CONFIG by default", () => {
    render(<StatusBadge status="running" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-status")).toBe("running");
    // STATUS_CONFIG maps "running" to label "RUNNING"
    expect(badge.textContent).toContain("RUNNING");
  });

  it("renders the STATUS_CONFIG label for promoted", () => {
    render(<StatusBadge status="promoted" />);
    // STATUS_CONFIG maps "promoted" to label "PROMOTED"
    expect(screen.getByText("PROMOTED")).toBeTruthy();
  });

  it("supports the lg size variant", () => {
    render(<StatusBadge status="approved" size="lg" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge.className).toMatch(/text-base/);
  });

  it("renders for extended decision states without crashing", () => {
    for (const s of ["promoted", "rejected", "approved", "pending", "overfitted"] as const) {
      const { unmount } = render(<StatusBadge status={s} />);
      expect(screen.getByTestId("status-badge").getAttribute("data-status")).toBe(s);
      unmount();
    }
  });

  it("renders emoji by default", () => {
    render(<StatusBadge status="failed" />);
    // STATUS_CONFIG maps "failed" to emoji "❌"
    const badge = screen.getByTestId("status-badge");
    expect(badge.textContent).toContain("❌");
  });

  it("allows custom content via children render prop", () => {
    render(
      <StatusBadge status="running">
        {({ emoji, label }) => <span>{emoji} custom {label}</span>}
      </StatusBadge>,
    );
    expect(screen.getByText(/custom RUNNING/)).toBeTruthy();
  });

  it("falls back to idle config for unknown status", () => {
    render(<StatusBadge status="unknown_status" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge.getAttribute("data-status")).toBe("unknown_status");
    // Falls back to idle config → label "PENDING"
    expect(badge.textContent).toContain("PENDING");
  });
});