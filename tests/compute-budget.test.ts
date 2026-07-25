/**
 * Unit tests for compute budget derivation (RF-#90, issue #90).
 *
 * The budget is derived from the dataset's complexity tier and imposes
 * enforceable limits (timeout + RLIMIT_CPU) so a modeler can't run a
 * runaway grid (run c682204f: 32.400 fits on 150-row Iris despite the
 * textual "TINY: <=15 trials" gate).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveComputeBudget } from "../dist/arena/dataset-context.js";

describe("deriveComputeBudget (RF-#90)", () => {
  it("tiny tier → tight budget (small dataset, e.g. Iris 150 rows)", () => {
    const b = deriveComputeBudget("tiny");
    assert.equal(b.tier, "tiny");
    assert.equal(b.maxFitSeconds, 30);
    assert.equal(b.maxTrials, 15);
    assert.equal(b.maxCombinations, 50);
    assert.equal(b.maxModelComplexity, "low");
  });

  it("small tier → moderate budget", () => {
    const b = deriveComputeBudget("small");
    assert.equal(b.tier, "small");
    assert.equal(b.maxFitSeconds, 60);
    assert.equal(b.maxTrials, 30);
    assert.equal(b.maxCombinations, 200);
    assert.equal(b.maxModelComplexity, "medium");
  });

  it("medium tier → full budget", () => {
    const b = deriveComputeBudget("medium");
    assert.equal(b.maxFitSeconds, 120);
    assert.equal(b.maxTrials, 50);
    assert.equal(b.maxCombinations, 1000);
    assert.equal(b.maxModelComplexity, "high");
  });

  it("large tier → max budget", () => {
    const b = deriveComputeBudget("large");
    assert.equal(b.maxFitSeconds, 180);
    assert.equal(b.maxTrials, 50);
    assert.equal(b.maxCombinations, 2000);
    assert.equal(b.maxModelComplexity, "high");
  });

  it("monotonic: budget relaxes as tier grows (tiny → large)", () => {
    const tiers = ["tiny", "small", "medium", "large"] as const;
    const budgets = tiers.map((t) => deriveComputeBudget(t));
    for (let i = 1; i < budgets.length; i++) {
      assert.ok(
        budgets[i].maxFitSeconds >= budgets[i - 1].maxFitSeconds,
        `${tiers[i]} should allow >= fit-seconds than ${tiers[i - 1]}`,
      );
      assert.ok(
        budgets[i].maxCombinations >= budgets[i - 1].maxCombinations,
        `${tiers[i]} should allow >= combinations than ${tiers[i - 1]}`,
      );
    }
  });

  it("tiny budget would kill the c682204f grid (6480 combos > 50)", () => {
    const b = deriveComputeBudget("tiny");
    assert.ok(6480 > b.maxCombinations, "the runaway grid exceeds the tiny budget");
    assert.ok(b.maxFitSeconds < 60, "tiny budget kills the script in well under a minute");
  });
});
