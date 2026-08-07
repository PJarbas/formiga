import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RunList } from "./RunList.js";
import type { PipelineRunRow } from "@shared/dashboard-types";

function wrap(node: React.ReactNode) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

function makeRun(overrides: Partial<PipelineRunRow> = {}): PipelineRunRow {
  const shortHash = overrides.shortHash ?? "6c6ea7b8";
  return {
    runId: `${shortHash}-0000-4000-8000-000000000000`,
    shortHash,
    workflowId: "ml-autoresearch",
    workflowType: "ml-autoresearch",
    task: "dataset_path=data/classification.csv target_column=species",
    status: "completed",
    currentPhase: "complete",
    phases: [
      { id: "eda", label: "EDA", status: "done", elapsedMs: 5000, estimatedMs: 0 },
      { id: "features", label: "Features", status: "done", elapsedMs: 5000, estimatedMs: 0 },
      { id: "modeling", label: "Modeling", status: "done", elapsedMs: 5000, estimatedMs: 0 },
      { id: "arena", label: "Arena", status: "done", elapsedMs: 5000, estimatedMs: 0 },
      { id: "report", label: "Report", status: "done", elapsedMs: 5000, estimatedMs: 0 },
    ],
    totalExperiments: 12,
    bestCvMean: 0.98,
    durationMs: 126_000,
    startedAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

describe("RunList", () => {
  it("renders one row per run", () => {
    render(
      wrap(
        <RunList
          runs={[makeRun({ shortHash: "aaaa1111" }), makeRun({ shortHash: "bbbb2222" })]}
        />,
      ),
    );
    expect(screen.getByTestId("run-row-aaaa1111")).toBeTruthy();
    expect(screen.getByTestId("run-row-bbbb2222")).toBeTruthy();
  });

  it("renders the correct status icon per run status", () => {
    render(
      wrap(
        <RunList
          runs={[
            makeRun({ shortHash: "pass0000", status: "completed" }),
            makeRun({ shortHash: "fail1111", status: "failed" }),
            makeRun({ shortHash: "run2222", status: "running" }),
            makeRun({ shortHash: "paus3333", status: "paused" }),
          ]}
        />,
      ),
    );
    expect(screen.getByLabelText("Status: passed")).toBeTruthy();
    expect(screen.getByLabelText("Status: failed")).toBeTruthy();
    expect(screen.getByLabelText("Status: running")).toBeTruthy();
    expect(screen.getByLabelText("Status: paused")).toBeTruthy();
  });

  it("shows workflow and arena tags next to the run id", () => {
    render(
      wrap(
        <RunList
          runs={[
            makeRun({
              shortHash: "arena0000",
              arenaProgress: { currentRound: 2, maxRounds: 5, status: "running" },
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByText("autoresearch")).toBeTruthy();
    expect(screen.getByText("arena")).toBeTruthy();
  });

  it("renders task parameters as key/value chips", () => {
    render(wrap(<RunList runs={[makeRun()]} />));
    const chips = screen.getByTestId("param-chips");
    expect(chips.textContent).toContain("dataset_path=");
    expect(chips.textContent).toContain("data/classification.csv");
    expect(chips.textContent).toContain("target_column=");
    expect(chips.textContent).toContain("species");
  });

  it("highlights the CV metric", () => {
    render(
      wrap(
        <RunList
          runs={[makeRun({ bestCvMean: 0.98 }), makeRun({ shortHash: "nocv0000", bestCvMean: null })]}
        />,
      ),
    );
    expect(screen.getByText("CV 0.9800")).toBeTruthy();
    expect(screen.queryByText("CV null")).toBeFalsy();
  });

  it("renders the segmented step tracker with per-phase status", () => {
    render(wrap(<RunList runs={[makeRun()]} />));
    const tracker = screen.getByTestId("step-tracker");
    const segments = tracker.querySelectorAll("[data-status]");
    expect(segments.length).toBe(5);
    expect(segments[0].getAttribute("data-status")).toBe("done");
    expect(segments[4].getAttribute("data-status")).toBe("done");
  });

  it("shows arena round chip while the arena phase is running", () => {
    render(
      wrap(
        <RunList
          runs={[
            makeRun({
              shortHash: "arun0000",
              status: "running",
              currentPhase: "arena",
              arenaProgress: { currentRound: 2, maxRounds: 5, status: "running" },
            }),
          ]}
        />,
      ),
    );
    expect(screen.getByText("R2/5")).toBeTruthy();
  });

  it("renders an empty state when there are no runs", () => {
    render(wrap(<RunList runs={[]} />));
    expect(screen.getByText("No pipeline runs")).toBeTruthy();
  });
});
