import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PipelineStepper } from "./PipelineStepper.js";
import type { PhaseInfo } from "@shared/dashboard-types";

const PHASES: PhaseInfo[] = [
  { id: "eda", label: "EDA", status: "done", elapsedMs: 5000, estimatedMs: 0 },
  { id: "feat-eng", label: "Feat Eng", status: "running", elapsedMs: 90000, estimatedMs: 120000 },
  { id: "modeling", label: "Modeling", status: "pending", elapsedMs: 0, estimatedMs: 0 },
];

describe("PipelineStepper", () => {
  it("renders one dot per phase", () => {
    render(<PipelineStepper phases={PHASES} currentPhase="feat-eng" />);
    expect(screen.getByTestId("phase-dot-eda")).toBeTruthy();
    expect(screen.getByTestId("phase-dot-feat-eng")).toBeTruthy();
    expect(screen.getByTestId("phase-dot-modeling")).toBeTruthy();
  });

  it("formats elapsed in mm:ss", () => {
    render(<PipelineStepper phases={PHASES} currentPhase="feat-eng" />);
    expect(screen.getByText("00:05")).toBeTruthy();
    expect(screen.getByText("01:30")).toBeTruthy();
  });

  it("renders an empty state when no phases", () => {
    render(<PipelineStepper phases={[]} currentPhase="" />);
    expect(screen.getByTestId("stepper-empty")).toBeTruthy();
  });

  it("tags dots with status via data-status", () => {
    render(<PipelineStepper phases={PHASES} currentPhase="feat-eng" />);
    expect(screen.getByTestId("phase-dot-eda").getAttribute("data-status")).toBe("done");
    expect(screen.getByTestId("phase-dot-feat-eng").getAttribute("data-status")).toBe("running");
  });
});
