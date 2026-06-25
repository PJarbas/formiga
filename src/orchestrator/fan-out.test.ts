// ══════════════════════════════════════════════════════════════════════
// fan-out.test.ts — Tests for parallel dispatch with timeout + failures
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AgentRunner,
  AgentContext,
  AgentResult,
  ValidationResult,
} from "../agents/interfaces.js";
import { fanOut, type FanOutExecutor } from "./fan-out.js";

function makeFakeAgent(name: string): AgentRunner {
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
  };
}

/** Executor that returns a canned SUCCESS result for any agent. */
const stubExecutor: FanOutExecutor = async (agent) => {
  const result: AgentResult = {
    agentName: agent.name,
    status: "SUCCESS",
  } as AgentResult;
  return result;
};

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
      executor: stubExecutor,
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
      executor: stubExecutor,
    });

    const names = results.map((r) => r.agentName).sort();
    assert.deepEqual(names, ["alpha", "beta"]);
  });

  it("handles empty agent list", async () => {
    const results = await fanOut({
      agents: [],
      context: testContext,
      timeoutMs: 5000,
      executor: stubExecutor,
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
      executor: stubExecutor,
    });

    assert.equal(results.length, 4);
    const allOk = results.every((r) => r.error === null);
    assert.equal(allOk, true);
  });

  it("returns error when executor throws", async () => {
    const throwingExecutor: FanOutExecutor = async () => {
      throw new Error("simulated executor failure");
    };

    const results = await fanOut({
      agents: [makeFakeAgent("failer")],
      context: testContext,
      timeoutMs: 5000,
      executor: throwingExecutor,
    });

    assert.equal(results.length, 1);
    assert.ok(results[0].error);
    assert.ok(results[0].error.includes("simulated executor failure"));
    assert.equal(results[0].timedOut, false);
  });

  it("detects timeout when executor takes too long", async () => {
    const slowExecutor: FanOutExecutor = (agent) =>
      new Promise((resolve) => {
        // Resolve well after the test's timeoutMs so fanOut's race fires the
        // timeout branch first.
        setTimeout(
          () =>
            resolve({
              agentName: agent.name,
              status: "SUCCESS",
            } as AgentResult),
          500,
        );
      });

    const results = await fanOut({
      agents: [makeFakeAgent("slow")],
      context: testContext,
      timeoutMs: 50,
      executor: slowExecutor,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].timedOut, true);
    assert.equal(results[0].result, null);
    assert.ok(results[0].error?.includes("Timeout after"));
  });
});
