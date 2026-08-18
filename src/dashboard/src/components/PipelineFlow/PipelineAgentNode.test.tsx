// ══════════════════════════════════════════════════════════════════════
// PipelineAgentNode.test.tsx — pass-rate fraction for arena modelers
// A single red ✗ (latest experiment rejected/crashed) is replaced by a
// kept/total fraction (e.g. "3/5") so passed models stay visible.
// ══════════════════════════════════════════════════════════════════════

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import PipelineAgentNode from "./PipelineAgentNode.js";
import type { PipelineFlowNode } from "@shared/dashboard-types";

vi.mock("@xyflow/react", () => ({
  Handle: () => <div data-testid="mock-handle" />,
  Position: { Top: "top", Bottom: "bottom" },
}));

function makeNode(overrides: Partial<PipelineFlowNode> = {}): PipelineFlowNode {
  return {
    agentId: "modeler-classic",
    label: "Modeler Classic",
    status: "failed",
    harness: "pi",
    phase: "arena",
    artifactsOut: [],
    messagesCount: 0,
    experiments: { kept: 3, rejected: 1, crashed: 1, total: 5 },
    ...overrides,
  };
}

function renderNode(node: PipelineFlowNode) {
  return render(
    <PipelineAgentNode data={{ node, isSelected: false, onClick: () => {} }} />,
  );
}

describe("PipelineAgentNode", () => {
  it("shows kept/total instead of a red ✗ for a modeler with mixed outcomes", () => {
    renderNode(makeNode({ status: "failed" }));
    expect(screen.getByText("3/5")).toBeTruthy();
    expect(screen.queryByText("✗")).toBeNull();
    // The breakdown stays as a secondary subtitle.
    expect(screen.getByText("✓3 ⚠1 ✗1")).toBeTruthy();
  });

  it("renders the all-passed fraction in green", () => {
    renderNode(
      makeNode({
        status: "completed",
        experiments: { kept: 5, rejected: 0, crashed: 0, total: 5 },
      }),
    );
    const badge = screen.getByText("5/5");
    expect(badge.style.color).toBe("var(--accent-green)");
  });

  it("renders the none-passed fraction in red", () => {
    renderNode(
      makeNode({
        status: "failed",
        experiments: { kept: 0, rejected: 2, crashed: 3, total: 5 },
      }),
    );
    const badge = screen.getByText("0/5");
    expect(badge.style.color).toBe("var(--accent-red)");
  });

  it("falls back to the status glyph when there are no experiment counters", () => {
    renderNode(makeNode({ experiments: undefined, status: "failed" }));
    expect(screen.getByText("✗")).toBeTruthy();
  });
});
