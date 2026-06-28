import { describe, it, expect } from "vitest";
import { getHumanStatus, type HumanStatusInput } from "./human-status";

function input(overrides: Partial<HumanStatusInput> = {}): HumanStatusInput {
  return {
    status: "idle",
    currentPhase: "idle",
    currentRound: 0,
    maxRounds: 5,
    pendingDecisions: 0,
    ...overrides,
  };
}

describe("getHumanStatus", () => {
  it("returns idle when status is idle", () => {
    const result = getHumanStatus(input());
    expect(result.label).toBe("idle");
    expect(result.description).toBe("Start a pipeline to begin");
    expect(result.isUrgent).toBe(false);
    expect(result.activePhase).toBeNull();
  });

  it("returns initializing when running + idle phase + round 0", () => {
    const result = getHumanStatus(input({ status: "running", currentPhase: "idle", currentRound: 0 }));
    expect(result.label).toBe("initializing");
    expect(result.description).toBe("Pipeline is setting up");
    expect(result.isUrgent).toBe(false);
  });

  it("returns waiting_for_input when running + idle phase + round > 0", () => {
    const result = getHumanStatus(input({ status: "running", currentPhase: "idle", currentRound: 2 }));
    expect(result.label).toBe("waiting_for_input");
    expect(result.description).toBe("Pipeline paused — awaiting decision");
    expect(result.isUrgent).toBe(true);
  });

  it("returns action_required when running + pending decisions", () => {
    const result = getHumanStatus(input({
      status: "running",
      currentPhase: "feature_engineering",
      currentRound: 2,
      pendingDecisions: 3,
    }));
    expect(result.label).toBe("action_required");
    expect(result.description).toBe("3 decisions pending");
    expect(result.isUrgent).toBe(true);
    expect(result.activePhase).toBe("feature_engineering");
  });

  it("returns action_required with singular decision", () => {
    const result = getHumanStatus(input({
      status: "running",
      currentPhase: "modeling",
      currentRound: 1,
      pendingDecisions: 1,
    }));
    expect(result.description).toBe("1 decision pending");
  });

  it("returns running when active with round > 0 and no pending decisions", () => {
    const result = getHumanStatus(input({
      status: "running",
      currentPhase: "data_analysis",
      currentRound: 2,
    }));
    expect(result.label).toBe("running");
    expect(result.description).toBe("Round 2/5");
    expect(result.isUrgent).toBe(false);
    expect(result.activePhase).toBe("data_analysis");
  });

  it("returns completed with round count", () => {
    const result = getHumanStatus(input({ status: "completed", currentRound: 5 }));
    expect(result.label).toBe("completed");
    expect(result.description).toBe("5 rounds finished");
  });

  it("returns completed with singular round", () => {
    const result = getHumanStatus(input({ status: "completed", currentRound: 1 }));
    expect(result.description).toBe("1 round finished");
  });

  it("returns failed with phase and round info", () => {
    const result = getHumanStatus(input({
      status: "failed",
      currentPhase: "modeling",
      currentRound: 3,
    }));
    expect(result.label).toBe("failed");
    expect(result.description).toBe("Failed at modeling, round 3");
    expect(result.isUrgent).toBe(true);
  });

  it("returns paused with round info", () => {
    const result = getHumanStatus(input({
      status: "paused",
      currentPhase: "feature_engineering",
      currentRound: 2,
    }));
    expect(result.label).toBe("paused");
    expect(result.description).toBe("Pipeline paused at round 2");
    expect(result.isUrgent).toBe(false);
  });

  it("always provides emoji and colorVar from STATUS_CONFIG", () => {
    const result = getHumanStatus(input({ status: "running", currentPhase: "modeling", currentRound: 1 }));
    expect(result.emoji).toBeTruthy();
    expect(result.colorVar).toMatch(/^--/);
  });

  it("action_required uses pending colorVar", () => {
    const result = getHumanStatus(input({
      status: "running",
      currentPhase: "modeling",
      currentRound: 1,
      pendingDecisions: 2,
    }));
    expect(result.colorVar).toBe("--status-pending");
  });
});