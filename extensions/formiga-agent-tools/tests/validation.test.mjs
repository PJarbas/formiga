// ══════════════════════════════════════════════════════════════════════
// validation.test.mjs — Unit tests for parameter validation
// ══════════════════════════════════════════════════════════════════════
//
// Run with:
//   node --experimental-strip-types --test tests/validation.test.mjs
//
// The extension ships with .ts sources; we import them directly using the
// experimental TypeScript stripping feature so tests don't need a build step.
// ══════════════════════════════════════════════════════════════════════

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  validateSaveArtifact,
  validateLogDecision,
  validateReportMetric,
  validateQueryLeaderboard,
  VALID_DECISION_TYPES,
} from "../extensions/formiga-agent-tools/validation.ts";

// ── save_artifact ────────────────────────────────────────────────────

describe("validateSaveArtifact", () => {
  test("accepts valid input", () => {
    assert.doesNotThrow(() => {
      validateSaveArtifact({ key: "eda_report", data: { foo: "bar" } });
    });
  });

  test("rejects missing key", () => {
    assert.throws(
      () => validateSaveArtifact({ data: {} }),
      /Missing required field: key/,
    );
  });

  test("rejects uppercase key", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "EDA_REPORT", data: {} }),
      /Invalid artifact key/,
    );
  });

  test("rejects key starting with digit", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "1_report", data: {} }),
      /Invalid artifact key/,
    );
  });

  test("rejects key with hyphens", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "eda-report", data: {} }),
      /Invalid artifact key/,
    );
  });

  test("rejects single-char key", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "a", data: {} }),
      /Invalid artifact key/,
    );
  });

  test("accepts min-length key (2 chars)", () => {
    assert.doesNotThrow(() => {
      validateSaveArtifact({ key: "ab", data: {} });
    });
  });

  test("rejects missing data", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "eda_report" }),
      /must be a JSON object/,
    );
  });

  test("rejects array as data", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "eda_report", data: [1, 2, 3] }),
      /must be a JSON object/,
    );
  });

  test("rejects string as data", () => {
    assert.throws(
      () => validateSaveArtifact({ key: "eda_report", data: "hello" }),
      /must be a JSON object/,
    );
  });

  test("rejects oversized data (>500KB)", () => {
    const bigString = "x".repeat(600 * 1024);
    assert.throws(
      () => validateSaveArtifact({ key: "eda_report", data: { blob: bigString } }),
      /too large/,
    );
  });
});

// ── log_decision ─────────────────────────────────────────────────────

describe("validateLogDecision", () => {
  test("accepts valid model_selection", () => {
    assert.doesNotThrow(() => {
      validateLogDecision({
        decision_type: "model_selection",
        description: "Choosing LightGBM",
      });
    });
  });

  test("accepts all valid decision types", () => {
    for (const dt of VALID_DECISION_TYPES) {
      assert.doesNotThrow(() => {
        validateLogDecision({ decision_type: dt, description: "test" });
      }, `should accept ${dt}`);
    }
  });

  test("rejects unknown decision_type", () => {
    assert.throws(
      () => validateLogDecision({ decision_type: "guess", description: "test" }),
      /Invalid decision_type/,
    );
  });

  test("rejects missing description", () => {
    assert.throws(
      () => validateLogDecision({ decision_type: "model_selection" }),
      /Missing required field: description/,
    );
  });

  test("rejects overly long description", () => {
    assert.throws(
      () => validateLogDecision({
        decision_type: "model_selection",
        description: "x".repeat(600),
      }),
      /description too long/,
    );
  });

  test("rejects overly long reasoning", () => {
    assert.throws(
      () => validateLogDecision({
        decision_type: "model_selection",
        description: "ok",
        reasoning: "y".repeat(1100),
      }),
      /reasoning too long/,
    );
  });

  test("rejects too many alternatives", () => {
    assert.throws(
      () => validateLogDecision({
        decision_type: "model_selection",
        description: "ok",
        alternatives_considered: new Array(11).fill("alt"),
      }),
      /Too many alternatives/,
    );
  });

  test("accepts alternatives up to limit", () => {
    assert.doesNotThrow(() => {
      validateLogDecision({
        decision_type: "model_selection",
        description: "ok",
        alternatives_considered: new Array(10).fill("alt"),
      });
    });
  });

  test("rejects non-string alternative", () => {
    assert.throws(
      () => validateLogDecision({
        decision_type: "model_selection",
        description: "ok",
        alternatives_considered: ["ok", 42],
      }),
      /must be a string/,
    );
  });
});

// ── report_metric ────────────────────────────────────────────────────

describe("validateReportMetric", () => {
  test("accepts valid input", () => {
    assert.doesNotThrow(() => {
      validateReportMetric({ name: "cv_mean", value: 0.723 });
    });
  });

  test("rejects invalid name", () => {
    assert.throws(
      () => validateReportMetric({ name: "CV_MEAN", value: 1 }),
      /Invalid metric name/,
    );
  });

  test("rejects NaN value", () => {
    assert.throws(
      () => validateReportMetric({ name: "cv_mean", value: NaN }),
      /Must be a finite number/,
    );
  });

  test("rejects Infinity value", () => {
    assert.throws(
      () => validateReportMetric({ name: "cv_mean", value: Infinity }),
      /Must be a finite number/,
    );
  });

  test("rejects too many tags", () => {
    const tags = {};
    for (let i = 0; i < 11; i++) tags[`t${i}`] = "v";
    assert.throws(
      () => validateReportMetric({ name: "cv", value: 1, tags }),
      /Too many tags/,
    );
  });

  test("rejects non-string tag value", () => {
    assert.throws(
      () => validateReportMetric({
        name: "cv",
        value: 1,
        tags: { fold: 3 },
      }),
      /must be a string/,
    );
  });

  test("accepts negative and zero values", () => {
    assert.doesNotThrow(() => validateReportMetric({ name: "delta", value: -0.5 }));
    assert.doesNotThrow(() => validateReportMetric({ name: "zero", value: 0 }));
  });
});

// ── query_leaderboard ────────────────────────────────────────────────

describe("validateQueryLeaderboard", () => {
  test("returns default limit when omitted", () => {
    assert.equal(validateQueryLeaderboard({}), 5);
  });

  test("returns supplied limit", () => {
    assert.equal(validateQueryLeaderboard({ limit: 10 }), 10);
  });

  test("rejects non-integer limit", () => {
    assert.throws(
      () => validateQueryLeaderboard({ limit: 5.5 }),
      /Must be an integer/,
    );
  });

  test("rejects limit below 1", () => {
    assert.throws(
      () => validateQueryLeaderboard({ limit: 0 }),
      /out of range/,
    );
  });

  test("rejects limit above 50", () => {
    assert.throws(
      () => validateQueryLeaderboard({ limit: 100 }),
      /out of range/,
    );
  });

  test("accepts limit at boundaries", () => {
    assert.equal(validateQueryLeaderboard({ limit: 1 }), 1);
    assert.equal(validateQueryLeaderboard({ limit: 50 }), 50);
  });
});
