// ══════════════════════════════════════════════════════════════════════
// dashboard-types.test.ts — Validation for shared dashboard types
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENT_INFO_REGISTRY } from "./dashboard-types.js";

describe("AGENT_INFO_REGISTRY", () => {
  it("contains all 5 ML agent entries", () => {
    const names = Object.keys(AGENT_INFO_REGISTRY);
    assert.equal(names.length, 5);
    assert.ok(names.includes("data-analyst"));
    assert.ok(names.includes("feature-engineer"));
    assert.ok(names.includes("modeler-classic"));
    assert.ok(names.includes("modeler-advanced"));
    assert.ok(names.includes("ml-critic"));
  });

  it("each agent has required fields", () => {
    for (const [name, info] of Object.entries(AGENT_INFO_REGISTRY)) {
      assert.equal(info.name, name, `${name}: name mismatch`);
      assert.ok(typeof info.label === "string" && info.label.length > 0, `${name}: missing label`);
      assert.ok(typeof info.description === "string" && info.description.length > 0, `${name}: missing description`);
      assert.ok(Array.isArray(info.tools) && info.tools.length > 0, `${name}: missing tools`);
      assert.ok(typeof info.model === "string" && info.model.length > 0, `${name}: missing model`);
    }
  });

  it("ml-critic has no Write tool", () => {
    const critic = AGENT_INFO_REGISTRY["ml-critic"];
    assert.ok(!critic.tools.includes("Write"), "ML Critic must not have Write tool");
  });

  it("modeler agents have Read, Write, Bash, Glob, Grep", () => {
    for (const name of ["modeler-classic", "modeler-advanced"]) {
      const agent = AGENT_INFO_REGISTRY[name];
      assert.ok(agent.tools.includes("Read"), `${name}: missing Read`);
      assert.ok(agent.tools.includes("Write"), `${name}: missing Write`);
      assert.ok(agent.tools.includes("Bash"), `${name}: missing Bash`);
    }
  });
});
