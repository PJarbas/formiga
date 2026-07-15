// ══════════════════════════════════════════════════════════════════════
// formatters.test.mjs — Unit tests for output formatters
// ══════════════════════════════════════════════════════════════════════

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  formatLeaderboard,
  truncateForDisplay,
} from "../extensions/formiga-agent-tools/formatters.ts";

describe("formatLeaderboard", () => {
  test("returns friendly message when empty", () => {
    const out = formatLeaderboard([]);
    assert.match(out, /empty/i);
  });

  test("renders entries with rank, model, agent, metrics, gap, round", () => {
    const out = formatLeaderboard([
      {
        modelType: "lightgbm",
        agentName: "modeler-classic",
        cvMean: 0.6812,
        trainMean: 0.7912,
        roundNumber: 3,
      },
      {
        modelType: "tabpfn",
        agentName: "modeler-advanced",
        cvMean: 0.6532,
        trainMean: 0.6800,
        roundNumber: 2,
      },
    ]);
    assert.match(out, /1\. lightgbm/);
    assert.match(out, /modeler-classic/);
    assert.match(out, /CV: 0\.6812/);
    assert.match(out, /Train: 0\.7912/);
    assert.match(out, /Gap: 0\.1100/);
    assert.match(out, /R3/);

    assert.match(out, /2\. tabpfn/);
    assert.match(out, /R2/);
  });

  test("falls back to valMetric when cvMean absent", () => {
    const out = formatLeaderboard([
      {
        modelType: "ridge",
        agentName: "baseline",
        valMetric: 0.9,
        trainMetric: 0.95,
        roundNumber: 0,
      },
    ]);
    assert.match(out, /CV: 0\.9000/);
    assert.match(out, /Train: 0\.9500/);
  });

  test("renders 'n/a' when metrics are missing", () => {
    const out = formatLeaderboard([
      {
        modelType: "unknown",
        agentName: "?",
        roundNumber: 1,
      },
    ]);
    assert.match(out, /CV: n\/a/);
    assert.match(out, /Train: n\/a/);
    assert.match(out, /Gap: n\/a/);
  });

  test("counts entries in the header", () => {
    const out = formatLeaderboard([
      { modelType: "a", agentName: "x", cvMean: 1, trainMean: 1, roundNumber: 1 },
      { modelType: "b", agentName: "y", cvMean: 1, trainMean: 1, roundNumber: 1 },
    ]);
    assert.match(out, /Top 2 experiments/);
  });
});

describe("truncateForDisplay", () => {
  test("returns unchanged when shorter than max", () => {
    assert.equal(truncateForDisplay("hello", 10), "hello");
  });

  test("truncates with ellipsis when longer", () => {
    assert.equal(truncateForDisplay("hello world", 5), "hello...");
  });

  test("handles empty string", () => {
    assert.equal(truncateForDisplay("", 5), "");
  });
});
