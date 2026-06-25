// ══════════════════════════════════════════════════════════════════════
// validation.test.ts — Tests for runtime guards and path validation
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  failFast,
  requireNonEmptyString,
  requirePositiveNumber,
  requireArray,
  validatePath,
} from "./validation.js";
import { validateSchema, AGENT_RESULT_SCHEMA } from "./schemas.js";

describe("failFast", () => {
  it("does not throw when condition is true", () => {
    assert.doesNotThrow(() => failFast(true, "should not throw"));
  });

  it("throws when condition is false", () => {
    assert.throws(() => failFast(false, "expected failure"), /expected failure/);
  });
});

describe("requireNonEmptyString", () => {
  it("returns the string when valid", () => {
    assert.equal(requireNonEmptyString("hello", "label"), "hello");
  });

  it("throws on empty string", () => {
    assert.throws(() => requireNonEmptyString("", "label"), /label/);
  });

  it("throws on whitespace-only string", () => {
    assert.throws(() => requireNonEmptyString("   ", "label"), /label/);
  });

  it("throws on non-string", () => {
    assert.throws(() => requireNonEmptyString(42, "label"), /label/);
  });
});

describe("requirePositiveNumber", () => {
  it("returns the number when valid", () => {
    assert.equal(requirePositiveNumber(42, "label"), 42);
    assert.equal(requirePositiveNumber(0, "label"), 0);
  });

  it("throws on negative number", () => {
    assert.throws(() => requirePositiveNumber(-1, "label"), /label/);
  });

  it("throws on NaN", () => {
    assert.throws(() => requirePositiveNumber(NaN, "label"), /label/);
  });

  it("throws on non-number", () => {
    assert.throws(() => requirePositiveNumber("42", "label"), /label/);
  });
});

describe("requireArray", () => {
  it("returns the array when valid", () => {
    assert.deepEqual(requireArray([1, 2, 3], "label"), [1, 2, 3]);
  });

  it("throws on non-array", () => {
    assert.throws(() => requireArray("not array", "label"), /label/);
  });

  it("enforces minimum length", () => {
    assert.throws(() => requireArray([], "label", 1), /label/);
    assert.doesNotThrow(() => requireArray([1], "label", 1));
  });

  it("enforces maximum length", () => {
    assert.throws(() => requireArray([1, 2, 3], "label", 0, 2), /label/);
    assert.doesNotThrow(() => requireArray([1, 2], "label", 0, 2));
  });
});

describe("validatePath", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "formiga-validation-"));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns path for valid non-empty string", () => {
    assert.equal(validatePath(tmpDir), tmpDir);
  });

  it("throws on empty string", () => {
    assert.throws(() => validatePath(""), /Path/);
  });

  it("validates existence when mustExist is true", () => {
    const existing = path.join(tmpDir, "exists.txt");
    writeFileSync(existing, "test");
    assert.equal(validatePath(existing, true), existing);
  });

  it("throws when mustExist is true and path does not exist", () => {
    assert.throws(() => validatePath(path.join(tmpDir, "nope.txt"), true), /does not exist/);
  });
});

describe("validateSchema — AGENT_RESULT_SCHEMA", () => {
  const validResult = {
    status: "SUCCESS",
    modelId: "model_1",
    modelType: "XGBoost",
    hyperparameters: { lr: 0.01 },
    cvMean: 0.85,
    cvStd: 0.02,
    cvScores: [0.83, 0.85, 0.87],
    trainMean: 0.90,
    trainValGap: 0.05,
    artifactPath: "/tmp/model.pkl",
  };

  it("returns no errors for a valid result", () => {
    const errors = validateSchema(validResult, AGENT_RESULT_SCHEMA as any);
    assert.deepEqual(errors, []);
  });

  it("reports missing required fields", () => {
    const errors = validateSchema({}, AGENT_RESULT_SCHEMA as any);
    const missingFields = errors.map((e) => e.field);
    assert.ok(missingFields.includes("status"));
    assert.ok(missingFields.includes("modelId"));
  });

  it("reports invalid status enum", () => {
    const errors = validateSchema({ ...validResult, status: "INVALID" }, AGENT_RESULT_SCHEMA as any);
    assert.ok(errors.some((e) => e.field === "status"));
  });

  it("reports negative cvStd", () => {
    const errors = validateSchema({ ...validResult, cvStd: -0.1 }, AGENT_RESULT_SCHEMA as any);
    assert.ok(errors.some((e) => e.field === "cvStd"));
  });

  it("reports non-number for numeric fields", () => {
    const errors = validateSchema({ ...validResult, cvMean: "high" }, AGENT_RESULT_SCHEMA as any);
    assert.ok(errors.some((e) => e.field === "cvMean"));
  });

  it("reports empty cvScores array", () => {
    const errors = validateSchema({ ...validResult, cvScores: [] }, AGENT_RESULT_SCHEMA as any);
    assert.ok(errors.some((e) => e.field === "cvScores"));
  });

  it("reports non-object root", () => {
    const errors = validateSchema("not an object", AGENT_RESULT_SCHEMA as any);
    assert.ok(errors.some((e) => e.field === "$"));
  });
});
