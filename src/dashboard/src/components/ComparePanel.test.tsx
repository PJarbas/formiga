import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ComparePanel } from "./ComparePanel.js";
import type { LeaderboardEntry } from "@shared/dashboard-types";

function makeEntry(over: Partial<LeaderboardEntry>): LeaderboardEntry {
  return {
    id: "1",
    runId: "r1",
    roundNumber: 1,
    agentName: "modeler-classic",
    modelId: "model-1",
    modelType: "xgboost",
    status: "SUCCESS",
    cvMean: 0.8,
    cvStd: 0.02,
    trainMean: 0.85,
    trainValGap: 0.05,
    hyperparameters: null,
    featureImportancesTop10: null,
    trainTimeSeconds: null,
    inferenceTimeMsPer1k: null,
    createdAt: "2026-01-01T00:00:00Z",
    promotedAt: null,
    rejectedAt: null,
    rejectReason: null,
    ...over,
  };
}

describe("ComparePanel", () => {
  it("shows an empty state when fewer than 2 experiments", () => {
    render(<ComparePanel experiments={[makeEntry({ id: "1" })]} />);
    expect(screen.getByTestId("compare-empty")).toBeTruthy();
  });

  it("renders one column per experiment", () => {
    render(
      <ComparePanel
        experiments={[
          makeEntry({ id: "1", modelId: "m1" }),
          makeEntry({ id: "2", modelId: "m2", cvMean: 0.9 }),
        ]}
      />,
    );
    expect(screen.getByText(/m1/)).toBeTruthy();
    expect(screen.getByText(/m2/)).toBeTruthy();
  });

  it("marks the winning value with ✓", () => {
    render(
      <ComparePanel
        experiments={[
          makeEntry({ id: "1", cvMean: 0.7 }),
          makeEntry({ id: "2", cvMean: 0.9 }),
        ]}
      />,
    );
    const marks = screen.getAllByTestId("winner-mark");
    expect(marks.length).toBeGreaterThan(0);
  });

  it("renders feature importances when provided", () => {
    render(
      <ComparePanel
        experiments={[
          makeEntry({ id: "1", featureImportancesTop10: [["feat_a", 0.5]] }),
          makeEntry({ id: "2", featureImportancesTop10: [["feat_b", 0.3]] }),
        ]}
      />,
    );
    expect(screen.getByText("feat_a")).toBeTruthy();
    expect(screen.getByText("feat_b")).toBeTruthy();
  });

  it("renders hyperparameter rows when present", () => {
    render(
      <ComparePanel
        experiments={[
          makeEntry({ id: "1", hyperparameters: { max_depth: 5 } }),
          makeEntry({ id: "2", hyperparameters: { max_depth: 10 } }),
        ]}
      />,
    );
    expect(screen.getByText("max_depth")).toBeTruthy();
  });
});
