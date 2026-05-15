import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildWorkPrompt, buildPollingPrompt, buildAgentPrompt } from "../../dist/installer/agent-cron.js";

describe("agent-cron re-exports", () => {
  it("exports buildWorkPrompt as a function", () => {
    assert.equal(typeof buildWorkPrompt, "function");
  });

  it("exports buildPollingPrompt as a function", () => {
    assert.equal(typeof buildPollingPrompt, "function");
  });

  it("exports buildAgentPrompt as a function", () => {
    assert.equal(typeof buildAgentPrompt, "function");
  });
});
