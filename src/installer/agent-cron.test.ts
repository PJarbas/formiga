import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWorkPrompt, buildPollingPrompt, buildAgentPrompt } from "../../dist/installer/agent-cron.js";

describe("agent-cron re-exports", () => {
  it("exports buildWorkPrompt as a function", () => {
    assert.equal(typeof buildWorkPrompt, "function");
  });

  it("exports buildPollingPrompt as an async function", () => {
    assert.equal(typeof buildPollingPrompt, "function");
    // buildPollingPrompt is now async — returns a Promise
    const result = buildPollingPrompt("wf", "agent", "run");
    assert.ok(result instanceof Promise);
  });

  it("exports buildAgentPrompt as a function", () => {
    assert.equal(typeof buildAgentPrompt, "function");
  });
});
