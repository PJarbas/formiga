import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActionBar } from "./ActionBar.js";
import type { Action } from "@shared/dashboard-types";

const ACTIONS: Action[] = [
  { id: "promote", label: "Promote", primary: true, variant: "success" },
  { id: "reject", label: "Reject", variant: "destructive" },
  { id: "compare", label: "Compare" },
];

describe("ActionBar", () => {
  it("renders one button per action", () => {
    render(<ActionBar actions={ACTIONS} onAction={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("fires onAction with the action id when clicked", () => {
    const onAction = vi.fn();
    render(<ActionBar actions={ACTIONS} onAction={onAction} />);
    fireEvent.click(screen.getByText("Reject"));
    expect(onAction).toHaveBeenCalledWith("reject");
  });

  it("disables every button when disabled=true", () => {
    render(<ActionBar actions={ACTIONS} onAction={() => {}} disabled />);
    for (const btn of screen.getAllByRole("button")) {
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("returns null for empty actions array", () => {
    const { container } = render(<ActionBar actions={[]} onAction={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
