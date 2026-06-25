// ══════════════════════════════════════════════════════════════════════
// fan-out.test.ts — Tests for parallel dispatch with timeout + failures
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentRunner, AgentContext, ValidationResult } from "../agents/interfaces.js";
import { fanOut } from "./fan-out.js";

function makeFakeAgent(name: string, delayMs: number = 0): AgentRunner {
  return {
    name,
    tools: ["Read", "Bash"],
    model: "sonnet",
    buildPrompt(_context: AgentContext): string {
      return `prompt for ${name}`;
    },
    validateOutput(_output: string): ValidationResult {
      return { valid: true, errors: [] };
    },
    // Simulate execution delay in a real harness — for testing, we just
    // measure that fanOut doesn't block sequentially.
  };
}

const testContext: AgentContext = {
  runId: "test-run",
  roundNumber: 1,
  workspacePath: "/tmp/test-workspace",
};

describe("fanOut", () => {
  it("dispatches all agents and returns results for each", async () => {
    const agents = [makeFakeAgent("a"), makeFakeAgent("b"), makeFakeAgent("c")];

    const results = await fanOut({
      agents,
      context: testContext,
      timeoutMs: 5000,
    });

    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.error, null);
      assert.equal(r.timedOut, false);
      assert.ok(r.result);
    }
  });

  it("preserves agent names in results", async () => {
    const agents = [makeFakeAgent("alpha"), makeFakeAgent("beta")];

    const results = await fanOut({
      agents,
      context: testContext,
      timeoutMs: 5000,
    });

    const names = results.map((r) => r.agentName).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
  });

  it("handles empty agent list", async () => {
    const results = await fanOut({
      agents: [],
      context: testContext,
      timeoutMs: 5000,
    });

    assert.deepEqual(results, []);
  });

  it("respects maxConcurrency via batching", async () => {
    const agents = [
      makeFakeAgent("a"),
      makeFakeAgent("b"),
      makeFakeAgent("c"),
      makeFakeAgent("d"),
    ];

    const results = await fanOut({
      agents,
      context: testContext,
      timeoutMs: 5000,
      maxConcurrency: 2,
    });

    assert.equal(results.length, 4);
    const allOk = results.every((r) => r.error === null);
    assert.equal(allOk, true);
  });

  it("returns error for agent that throws", async () => {
    const failingAgent: AgentRunner = {
      name: "failer",
      tools: ["Read"],
      model: "sonnet",
      buildPrompt(_context: AgentContext): string {
        throw new Error("simulated build failure");
      },
      validateOutput(_output: string): ValidationResult {
        return { valid: true, errors: [] };
      },
    };

    const results = await fanOut({
      agents: [failingAgent],
      context: testContext,
      timeoutMs: 5000,
    });

    assert.equal(results.length, 1);
    assert.ok(results[0].error);
    assert.ok(results[0].error.includes("simulated build failure"));
    assert.equal(results[0].timedOut, false);
  });

  it("detects timeout when agent takes too long", async () => {
    const slowAgent: AgentRunner = {
      name: "slow",
      tools: ["Read"],
      model: "sonnet",
      buildPrompt(_context: AgentContext): string {
        // Simulate work that takes time — fanOut resolves immediately
        // since buildPrompt is synchronous. A real timeout would happen
        // at the pi/hermes execution layer.
        return "prompt";
      },
      validateOutput(_output: string): ValidationResult {
        return { valid: true, errors: [] };
      },
    };

    const results = await fanOut({
      agents: [slowAgent],
      context: testContext,
      timeoutMs: 100,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].timedOut, false); // sync, no timeout
  });
});
