/**
 * Regression tests for the run 367d0f4e failure (RF-1 + RF-2, spec §1).
 *
 * RF-1: prompts must NOT wrap the CLI in `node` — `resolveFormigaCli()`
 *       returns the `bin/formiga` shell launcher (`#!/bin/sh`), so
 *       `node bin/formiga` raised `SyntaxError: Invalid or unexpected token`
 *       and drove the feature-engineer into a heartbeat loop.
 *
 * RF-2: the polling prompt must NOT instruct the agent to run `step peek`.
 *       Work discovery is done by the scheduler's pre-check
 *       (polling-round.ts:494-518), so the agent only claims + executes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkPrompt, buildPollingPrompt, buildAgentPrompt } from "../dist/installer/agent-scheduler.js";

const RUN_ID = "7aeb4da9-1111-4222-8333-abcdefabcdef";

describe("RF-1: prompts never invoke the CLI with `node`", () => {
  it("buildAgentPrompt does not wrap cli in node", () => {
    const prompt = buildAgentPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes('node "'), "prompt must not contain `node \"<cli>\"`");
    assert.ok(!/\bnode\s+"[^"]*formiga/.test(prompt), "prompt must not invoke node on the formiga cli");
  });

  it("buildWorkPrompt does not wrap cli in node", () => {
    const prompt = buildWorkPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes('node "'), "prompt must not contain `node \"<cli>\"`");
  });

  it("buildPollingPrompt does not wrap cli in node", async () => {
    const prompt = await buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes('node "'), "prompt must not contain `node \"<cli>\"`");
    assert.ok(!/\bnode\s+"[^"]*formiga/.test(prompt), "prompt must not invoke node on the formiga cli");
  });
});

describe("RF-2: polling prompt does not instruct the agent to peek", () => {
  it("buildPollingPrompt has no step peek instruction", async () => {
    const prompt = await buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(!prompt.includes("step peek"), "polling prompt must not instruct step peek");
    assert.ok(!prompt.includes("HAS_WORK"), "polling prompt must not reference HAS_WORK");
  });

  it("buildPollingPrompt still instructs claim + complete + fail", async () => {
    const prompt = await buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("step claim"), "polling prompt must instruct step claim");
    assert.ok(prompt.includes("step complete"), "polling prompt must instruct step complete");
    assert.ok(prompt.includes("step fail"), "polling prompt must instruct step fail");
  });

  it("buildPollingPrompt keeps a HEARTBEAT_OK fallback for the claim race", async () => {
    const prompt = await buildPollingPrompt("feature-dev", "developer", RUN_ID);
    assert.ok(prompt.includes("HEARTBEAT_OK"), "polling prompt must keep HEARTBEAT_OK fallback for NO_WORK claim");
    assert.ok(prompt.includes("NO_WORK"), "polling prompt must mention NO_WORK claim fallback");
  });
});
