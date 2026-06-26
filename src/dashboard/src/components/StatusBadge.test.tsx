import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge.js";

describe("StatusBadge", () => {
  it("renders the status label in capitalized form by default", () => {
    render(<StatusBadge status="running" />);
    const badge = screen.getByTestId("status-badge");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-status")).toBe("running");
    expect(badge.textContent).toMatch(/running/i);
  });

  it("renders the custom label when provided", () => {
    render(<StatusBadge status="promoted" label="Promoted" />);
    expect(screen.getByText("Promoted")).toBeTruthy();
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
});
