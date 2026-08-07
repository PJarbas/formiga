import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatTiles } from "./StatTiles.js";
import type { LeaderboardEntry } from "@shared/dashboard-types";

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    id: "entry-1",
    runId: "run-1",
    roundNumber: 1,
    agentName: "researcher",
    modelId: "model-1",
    modelType: "xgboost",
    modelAlgorithm: "xgboost",
    problemType: "classification",
    status: "SUCCESS",
    cvMean: 0.95,
    cvStd: 0.02,
    trainMean: 0.99,
    trainValGap: 0.04,
    hyperparameters: null,
    featureImportancesTop10: null,
    trainTimeSeconds: null,
    inferenceTimeMsPer1k: null,
    createdAt: "2026-01-01T00:00:00Z",
    promotedAt: null,
    rejectedAt: null,
    rejectReason: null,
    artifactPath: null,
    metrics: { classification: { f1: 0.93, rocAuc: 0.96 } },
    ...overrides,
  };
}

describe("StatTiles", () => {
  it("renders the four KPI tiles for classification", () => {
    render(<StatTiles entries={[makeEntry()]} bestCvMean={0.95} />);
    expect(screen.getByText("BEST AUC")).toBeTruthy();
    expect(screen.getByText("EXPERIMENTS")).toBeTruthy();
    expect(screen.getByText("BEST F1")).toBeTruthy();
    expect(screen.getByText("MIN OVERFIT Δ")).toBeTruthy();
  });

  it("renders the best metric value in emerald", () => {
    const { container } = render(<StatTiles entries={[makeEntry()]} bestCvMean={0.95} />);
    const bestValue = screen.getByText("0.9500");
    expect(bestValue.className).toContain("text-emerald-400");
    expect(container.querySelectorAll(".text-emerald-400").length).toBeGreaterThan(0);
  });

  it("shows the best algorithm as the tile sub-label", () => {
    render(<StatTiles entries={[makeEntry()]} bestCvMean={0.95} />);
    expect(screen.getByText("xgboost")).toBeTruthy();
  });

  it("renders regression tiles when entries are regression", () => {
    render(
      <StatTiles
        entries={[makeEntry({ problemType: "regression", metrics: { regression: { r2Score: 0.91 } } })]}
        bestCvMean={0.91}
      />,
    );
    expect(screen.getByText("BEST R²")).toBeTruthy();
    expect(screen.getByText("coefficient of det.")).toBeTruthy();
  });

  it("renders a placeholder value when there is no best metric", () => {
    render(<StatTiles entries={[]} bestCvMean={null} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});
