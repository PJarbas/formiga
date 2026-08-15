// ══════════════════════════════════════════════════════════════════════
// arena-timeout.test.ts — Tests for A6: the 5-minute floor on script
// execution timeouts and the RLIMIT_CPU prelude, across all compute tiers.
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveScriptTimeoutMs,
  buildRlimitPrelude,
  SCRIPT_TIMEOUT_FLOOR_MS,
  TRAIN_TIMEOUT_MS,
  BENCHMARK_TIMEOUT_MS,
  SCRIPT_MISSING_EXIT_CODE,
} from "./arena-engine.js";
import { deriveComputeBudget } from "./dataset-context.js";

const FLOOR = SCRIPT_TIMEOUT_FLOOR_MS;

describe("timeout constants (A6)", () => {
  it("defines a 5-minute floor", () => {
    assert.equal(FLOOR, 300_000);
  });

  it("global train/benchmark timeouts sit at the floor", () => {
    assert.equal(TRAIN_TIMEOUT_MS, 300_000);
    assert.equal(BENCHMARK_TIMEOUT_MS, 300_000);
  });

  it("negative exit code for a broken contract stays unambiguous", () => {
    assert.equal(SCRIPT_MISSING_EXIT_CODE, -2);
  });
});

describe("effectiveScriptTimeoutMs", () => {
  it("returns the global cap when no budget is present", () => {
    assert.equal(effectiveScriptTimeoutMs(undefined, TRAIN_TIMEOUT_MS), 300_000);
    assert.equal(effectiveScriptTimeoutMs(undefined, 120_000), 120_000);
  });

  it("floors every tier at 5 minutes (tiny 30s → 300s)", () => {
    for (const tier of ["tiny", "small", "medium", "large"] as const) {
      const budget = deriveComputeBudget(tier);
      const got = effectiveScriptTimeoutMs(budget, TRAIN_TIMEOUT_MS);
      assert.ok(
        got >= FLOOR,
        `tier=${tier} maxFitSeconds=${budget.maxFitSeconds} → ${got}ms, expected >= ${FLOOR}`,
      );
      assert.equal(got, FLOOR, `tier=${tier} should land exactly on the floor`);
    }
  });

  it("the floor wins even when the global cap is below it", () => {
    const budget = deriveComputeBudget("tiny");
    assert.equal(effectiveScriptTimeoutMs(budget, 60_000), FLOOR);
  });
});

describe("buildRlimitPrelude (RLIMIT_CPU)", () => {
  it("returns null when no budget is set (no CPU cap imposed)", () => {
    assert.equal(buildRlimitPrelude(undefined), null);
  });

  it("imposes at least a 5-minute CPU soft cap even on the tiny tier", () => {
    const prelude = buildRlimitPrelude(deriveComputeBudget("tiny"));
    assert.ok(prelude, "expected a prelude for the tiny tier");
    assert.match(prelude!, /setrlimit\(_r\.RLIMIT_CPU, \(300, 302\)\)/);
  });

  it("caps CPU time on the large tier too", () => {
    const prelude = buildRlimitPrelude(deriveComputeBudget("large"));
    assert.ok(prelude);
    assert.match(prelude!, /setrlimit\(_r\.RLIMIT_CPU, \(\d+, \d+\)\)/);
  });

  it("execs the modeler script passed as argv[1]", () => {
    const prelude = buildRlimitPrelude(deriveComputeBudget("medium"));
    assert.ok(prelude);
    assert.match(prelude!, /_s\.argv\[1\]/);
    assert.match(prelude!, /exec\(compile\(/);
  });

  it("hard cap is exactly 2s above the soft cap", () => {
    for (const tier of ["tiny", "small", "medium", "large"] as const) {
      const prelude = buildRlimitPrelude(deriveComputeBudget(tier));
      assert.ok(prelude);
      const m = prelude!.match(/setrlimit\(_r\.RLIMIT_CPU, \((\d+), (\d+)\)\)/);
      assert.ok(m, `no setrlimit line for ${tier}`);
      assert.equal(Number(m![2]), Number(m![1]) + 2, `hard≠soft+2 for ${tier}`);
      assert.ok(Number(m![1]) >= 300, `soft cap below floor for ${tier}`);
    }
  });
});
