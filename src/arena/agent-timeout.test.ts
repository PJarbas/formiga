// ══════════════════════════════════════════════════════════════════════
// agent-timeout.test.ts — Dynamic arena agent timeout resolution
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAgentTimeout,
  AGENT_TIMEOUT_HARD_CAP_BY_TIER,
  AGENT_TIMEOUT_STALE_DEFAULT_SECONDS,
} from "./agent-timeout.js";

/** Temporarily set env vars for the duration of `fn`, restoring afterwards. */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("resolveAgentTimeout", () => {
  it("uses the tier hard cap and default stale when no budget/env override", () => {
    const t = resolveAgentTimeout("large");
    assert.equal(t.hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.LARGE * 1000);
    assert.equal(t.staleTimeoutMs, AGENT_TIMEOUT_STALE_DEFAULT_SECONDS * 1000);
  });

  it("maps every tier to its own hard cap", () => {
    assert.equal(resolveAgentTimeout("tiny").hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.TINY * 1000);
    assert.equal(resolveAgentTimeout("small").hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.SMALL * 1000);
    assert.equal(resolveAgentTimeout("medium").hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.MEDIUM * 1000);
    assert.equal(resolveAgentTimeout("large").hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.LARGE * 1000);
  });

  it("falls back to MEDIUM for an unknown tier", () => {
    assert.equal(resolveAgentTimeout("nope").hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.MEDIUM * 1000);
  });

  it("scales the hard cap up from a heavy compute budget", () => {
    // budget.max_fit_seconds 1500 → 4× = 6000s > LARGE tier cap (3600s)
    const t = resolveAgentTimeout("large", { maxFitSeconds: 1500 });
    assert.equal(t.hardTimeoutMs, 6000 * 1000);
  });

  it("does not lower the tier cap for a small budget", () => {
    const t = resolveAgentTimeout("large", { maxFitSeconds: 30 });
    assert.equal(t.hardTimeoutMs, AGENT_TIMEOUT_HARD_CAP_BY_TIER.LARGE * 1000);
  });

  it("clamps the hard cap to the global env override (FORMIGA_ARENA_AGENT_TIMEOUT)", () => {
    withEnv({ FORMIGA_ARENA_AGENT_TIMEOUT: "600" }, () => {
      const t = resolveAgentTimeout("large", { maxFitSeconds: 1500 });
      assert.equal(t.hardTimeoutMs, 600 * 1000);
    });
  });

  it("honors FORMIGA_ARENA_AGENT_STALE_SECONDS", () => {
    withEnv({ FORMIGA_ARENA_AGENT_STALE_SECONDS: "100" }, () => {
      const t = resolveAgentTimeout("large");
      assert.equal(t.staleTimeoutMs, 100 * 1000);
    });
  });
});
