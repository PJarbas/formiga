import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InteractiveChecklist } from "./InteractiveChecklist.js";
import type { ChecklistItem } from "@shared/dashboard-types";

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const ITEMS: ChecklistItem[] = [
  { id: "split", label: "Train/val split documented", checked: false, required: true },
  { id: "leakage", label: "No data leakage", checked: true, required: true },
];

describe("InteractiveChecklist", () => {
  it("renders all items with checked state", () => {
    render(wrap(<InteractiveChecklist runId="r1" phase="feat-eng" items={ITEMS} />));
    expect((screen.getByTestId("checkbox-split") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("checkbox-leakage") as HTMLInputElement).checked).toBe(true);
  });

  it("optimistically toggles and calls the mutation override", async () => {
    const onMutate = vi.fn(async (items: ChecklistItem[]) => items);
    render(
      wrap(
        <InteractiveChecklist
          runId="r1"
          phase="feat-eng"
          items={ITEMS}
          onMutate={onMutate}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("checkbox-split"));
    await waitFor(() => {
      expect(onMutate).toHaveBeenCalled();
    });
    expect((screen.getByTestId("checkbox-split") as HTMLInputElement).checked).toBe(true);
  });

  it("rolls back when the mutation fails", async () => {
    const onMutate = vi.fn(async () => {
      throw new Error("Save failed");
    });
    render(
      wrap(
        <InteractiveChecklist
          runId="r1"
          phase="feat-eng"
          items={ITEMS}
          onMutate={onMutate}
        />,
      ),
    );
    fireEvent.click(screen.getByTestId("checkbox-split"));
    await waitFor(() => {
      expect(screen.getByTestId("checklist-error").textContent).toMatch(/Save failed/);
    });
    expect((screen.getByTestId("checkbox-split") as HTMLInputElement).checked).toBe(false);
  });

  it("shows empty state when no items", () => {
    render(wrap(<InteractiveChecklist runId="r1" phase="feat-eng" items={[]} />));
    expect(screen.getByText(/No checklist items/)).toBeTruthy();
  });
});
