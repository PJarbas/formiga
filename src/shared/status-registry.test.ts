// ══════════════════════════════════════════════════════════════════════
// status-registry.test.ts — Verify the single source of truth
// ══════════════════════════════════════════════════════════════════════

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  ENTITY_STATUSES,
  resolveDashboardStatus,
  resolveVisualStatus,
  resolveUIStatus,
  isValidStatus,
  getValidStatusValues,
  setStatusLogger,
  EXPERIMENT_TO_DASHBOARD,
  STEP_TO_VISUAL,
  STORY_TO_VISUAL,
  ARENA_DECISION_TO_VISUAL,
  PHASE_RESULT_TO_DASHBOARD,
  STATUS_TO_UI,
  type EntityName,
} from "./status-registry.js";

// ── Helpers ──────────────────────────────────────────────────────────

function collectWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = mock.fn((msg: string) => warnings.push(msg));
  setStatusLogger({ warn: original, debug: mock.fn() });
  fn();
  setStatusLogger({ warn() {}, debug() {} }); // reset
  return warnings;
}

// ── ENTITY_STATUSES completeness ─────────────────────────────────────

describe("ENTITY_STATUSES", () => {
  it("defines all 10 entity types", () => {
    const keys = Object.keys(ENTITY_STATUSES);
    assert.equal(keys.length, 10);
  });

  it("Experiment statuses match DB CHECK constraint", () => {
    assert.deepEqual([...ENTITY_STATUSES.Experiment], ["PENDING", "SUCCESS", "FAILED", "AUDITED", "OVERFITTED"]);
  });

  it("Step includes both done and completed", () => {
    assert.ok(ENTITY_STATUSES.Step.includes("done"));
    assert.ok(ENTITY_STATUSES.Step.includes("completed"));
  });

  it("Step includes both canceled and cancelled", () => {
    assert.ok(ENTITY_STATUSES.Step.includes("canceled"));
    assert.ok(ENTITY_STATUSES.Step.includes("cancelled"));
  });

  it("PhaseResult includes timed_out", () => {
    assert.ok(ENTITY_STATUSES.PhaseResult.includes("timed_out"));
  });
});

// ── Mapping table exhaustiveness ──────────────────────────────────────

describe("Mapping tables are exhaustive", () => {
  it("EXPERIMENT_TO_DASHBOARD covers all Experiment statuses", () => {
    for (const s of ENTITY_STATUSES.Experiment) {
      assert.ok(s in EXPERIMENT_TO_DASHBOARD, `Missing mapping for '${s}'`);
    }
  });

  it("STEP_TO_VISUAL covers all Step statuses", () => {
    for (const s of ENTITY_STATUSES.Step) {
      assert.ok(s in STEP_TO_VISUAL, `Missing mapping for '${s}'`);
    }
  });

  it("STORY_TO_VISUAL covers all Story statuses", () => {
    for (const s of ENTITY_STATUSES.Story) {
      assert.ok(s in STORY_TO_VISUAL, `Missing mapping for '${s}'`);
    }
  });

  it("ARENA_DECISION_TO_VISUAL covers all ArenaDecision values", () => {
    for (const s of ENTITY_STATUSES.ArenaDecision) {
      assert.ok(s in ARENA_DECISION_TO_VISUAL, `Missing mapping for '${s}'`);
    }
  });

  it("PHASE_RESULT_TO_DASHBOARD covers all PhaseResult statuses", () => {
    for (const s of ENTITY_STATUSES.PhaseResult) {
      assert.ok(s in PHASE_RESULT_TO_DASHBOARD, `Missing mapping for '${s}'`);
    }
  });
});

// ── resolveDashboardStatus ──────────────────────────────────────────

describe("resolveDashboardStatus", () => {
  it("returns identity for DashboardAgentStatus values", () => {
    assert.equal(resolveDashboardStatus("idle"), "idle");
    assert.equal(resolveDashboardStatus("running"), "running");
    assert.equal(resolveDashboardStatus("completed"), "completed");
    assert.equal(resolveDashboardStatus("failed"), "failed");
    assert.equal(resolveDashboardStatus("timed_out"), "timed_out");
  });

  it("maps Experiment UPPERCASE statuses", () => {
    assert.equal(resolveDashboardStatus("PENDING"), "running");
    assert.equal(resolveDashboardStatus("SUCCESS"), "completed");
    assert.equal(resolveDashboardStatus("FAILED"), "failed");
    assert.equal(resolveDashboardStatus("AUDITED"), "completed");
    assert.equal(resolveDashboardStatus("OVERFITTED"), "failed");
  });

  it("maps Step statuses via Visual→Dashboard", () => {
    assert.equal(resolveDashboardStatus("waiting"), "idle");
    assert.equal(resolveDashboardStatus("pending"), "idle");
    assert.equal(resolveDashboardStatus("running"), "running");
    assert.equal(resolveDashboardStatus("done"), "completed");
    assert.equal(resolveDashboardStatus("completed"), "completed");
    assert.equal(resolveDashboardStatus("failed"), "failed");
    assert.equal(resolveDashboardStatus("canceled"), "failed");
    assert.equal(resolveDashboardStatus("cancelled"), "failed");
  });

  it("maps timed_out from PhaseResult", () => {
    assert.equal(resolveDashboardStatus("timed_out"), "timed_out");
  });

  it("returns idle for null/undefined/empty", () => {
    assert.equal(resolveDashboardStatus(null), "idle");
    assert.equal(resolveDashboardStatus(undefined), "idle");
    assert.equal(resolveDashboardStatus(""), "idle");
  });

  it("logs warning for unknown values", () => {
    const warnings = collectWarnings(() => {
      const result = resolveDashboardStatus("UNKNOWN", {
        entityType: "Experiment",
        entityId: "42",
        fieldName: "status",
      });
      assert.equal(result, "idle");
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("UNKNOWN"));
    assert.ok(warnings[0].includes("Experiment"));
  });
});

// ── resolveVisualStatus ──────────────────────────────────────────────

describe("resolveVisualStatus", () => {
  it("returns identity for VisualStatus values", () => {
    assert.equal(resolveVisualStatus("todo"), "todo");
    assert.equal(resolveVisualStatus("running"), "running");
    assert.equal(resolveVisualStatus("done"), "done");
    assert.equal(resolveVisualStatus("failed"), "failed");
  });

  it("maps Step statuses", () => {
    assert.equal(resolveVisualStatus("waiting"), "todo");
    assert.equal(resolveVisualStatus("pending"), "todo");
    assert.equal(resolveVisualStatus("done"), "done");
    assert.equal(resolveVisualStatus("completed"), "done");
    assert.equal(resolveVisualStatus("canceled"), "failed");
  });

  it("maps Story statuses", () => {
    assert.equal(resolveVisualStatus("pending"), "todo");
    assert.equal(resolveVisualStatus("running"), "running");
    assert.equal(resolveVisualStatus("done"), "done");
    assert.equal(resolveVisualStatus("failed"), "failed");
  });

  it("maps Arena decisions", () => {
    assert.equal(resolveVisualStatus("keep"), "done");
    assert.equal(resolveVisualStatus("discard"), "failed");
    assert.equal(resolveVisualStatus("crash"), "failed");
    assert.equal(resolveVisualStatus("checks_failed"), "failed");
    assert.equal(resolveVisualStatus("baseline"), "done");
  });

  it("returns todo for null/undefined", () => {
    assert.equal(resolveVisualStatus(null), "todo");
    assert.equal(resolveVisualStatus(undefined), "todo");
  });

  it("logs warning for unknown values", () => {
    const warnings = collectWarnings(() => {
      const result = resolveVisualStatus("GARBAGE", {
        entityType: "Step",
        entityId: "step-1",
        fieldName: "status",
      });
      assert.equal(result, "todo");
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("GARBAGE"));
  });
});

// ── resolveUIStatus ──────────────────────────────────────────────────

describe("resolveUIStatus", () => {
  it("maps Experiment UPPERCASE to UI lowercase", () => {
    assert.equal(resolveUIStatus("PENDING"), "pending");
    assert.equal(resolveUIStatus("SUCCESS"), "success");
    assert.equal(resolveUIStatus("FAILED"), "failed");
    assert.equal(resolveUIStatus("AUDITED"), "completed");
    assert.equal(resolveUIStatus("OVERFITTED"), "overfitted");
  });

  it("maps DashboardAgentStatus identity", () => {
    assert.equal(resolveUIStatus("idle"), "idle");
    assert.equal(resolveUIStatus("running"), "running");
    assert.equal(resolveUIStatus("completed"), "completed");
    assert.equal(resolveUIStatus("failed"), "failed");
    assert.equal(resolveUIStatus("timed_out"), "timed_out");
  });

  it("maps VisualStatus aliases", () => {
    assert.equal(resolveUIStatus("todo"), "idle");
    assert.equal(resolveUIStatus("done"), "completed");
  });

  it("maps Arena decisions", () => {
    assert.equal(resolveUIStatus("keep"), "keep");
    assert.equal(resolveUIStatus("discard"), "discard");
    assert.equal(resolveUIStatus("crash"), "crash");
    assert.equal(resolveUIStatus("baseline"), "success");
  });

  it("returns idle for null/undefined", () => {
    assert.equal(resolveUIStatus(null), "idle");
    assert.equal(resolveUIStatus(undefined), "idle");
  });

  it("logs warning for unknown values", () => {
    const warnings = collectWarnings(() => {
      const result = resolveUIStatus("SUCCES", {
        entityType: "Experiment",
        entityId: "99",
        fieldName: "status",
      });
      assert.equal(result, "idle");
    });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("SUCCES"));
  });
});

// ── isValidStatus ───────────────────────────────────────────────────

describe("isValidStatus", () => {
  it("returns true for valid statuses", () => {
    assert.equal(isValidStatus("Experiment", "SUCCESS"), true);
    assert.equal(isValidStatus("Step", "running"), true);
    assert.equal(isValidStatus("ArenaSession", "converged"), true);
    assert.equal(isValidStatus("PhaseResult", "timed_out"), true);
  });

  it("returns false for cross-entity mismatches", () => {
    assert.equal(isValidStatus("Experiment", "running"), false);
    assert.equal(isValidStatus("Step", "SUCCESS"), false);
  });

  it("returns false for null/undefined", () => {
    assert.equal(isValidStatus("Experiment", null), false);
    assert.equal(isValidStatus("Experiment", undefined), false);
  });

  it("returns false for empty string", () => {
    assert.equal(isValidStatus("Experiment", ""), false);
  });
});

// ── getValidStatusValues ─────────────────────────────────────────────

describe("getValidStatusValues", () => {
  it("returns all Experiment statuses", () => {
    const values = getValidStatusValues("Experiment");
    assert.deepEqual([...values], ["PENDING", "SUCCESS", "FAILED", "AUDITED", "OVERFITTED"]);
  });

  it("returns all PhaseResult statuses including timed_out", () => {
    const values = getValidStatusValues("PhaseResult");
    assert.deepEqual([...values], ["completed", "failed", "timed_out"]);
  });
});