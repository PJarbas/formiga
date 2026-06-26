import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SpecDiffViewer, computeLineDiff } from "./SpecDiffViewer.js";

describe("computeLineDiff", () => {
  it("returns all unchanged hunks when before === after", () => {
    const hunks = computeLineDiff("a\nb\nc", "a\nb\nc");
    expect(hunks).toHaveLength(3);
    expect(hunks.every((h) => h.type === "unchanged")).toBe(true);
  });

  it("marks pure additions as added", () => {
    const hunks = computeLineDiff("a", "a\nb");
    expect(hunks.find((h) => h.type === "added")?.content).toBe("b");
  });

  it("marks pure removals as removed", () => {
    const hunks = computeLineDiff("a\nb", "a");
    expect(hunks.find((h) => h.type === "removed")?.content).toBe("b");
  });

  it("handles full replacement", () => {
    const hunks = computeLineDiff("old", "new");
    expect(hunks.map((h) => h.type).sort()).toEqual(["added", "removed"]);
  });
});

describe("SpecDiffViewer", () => {
  it("renders in unified mode by default", () => {
    render(<SpecDiffViewer before="a\nb" after="a\nc" />);
    expect(screen.getByTestId("diff-unified")).toBeTruthy();
  });

  it("switches to split mode when the toggle is clicked", () => {
    render(<SpecDiffViewer before="a" after="b" />);
    fireEvent.click(screen.getByTestId("diff-mode-split"));
    expect(screen.getByTestId("diff-split")).toBeTruthy();
  });
});
