import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listBundledWorkflows } from "../../dist/installer/workflow-fetch.js";

describe("workflow-fetch", () => {
  describe("listBundledWorkflows", () => {
    it("returns a non-empty array of workflow IDs", async () => {
      const workflows = await listBundledWorkflows();
      assert.ok(Array.isArray(workflows));
      assert.ok(workflows.length > 0, "should have at least one bundled workflow");
    });

    it("returns sorted workflow IDs", async () => {
      const workflows = await listBundledWorkflows();
      const sorted = [...workflows].sort();
      assert.deepEqual(workflows, sorted, "workflow IDs should be sorted");
    });

    it("each workflow ID is a non-empty string", async () => {
      const workflows = await listBundledWorkflows();
      for (const id of workflows) {
        assert.equal(typeof id, "string");
        assert.ok(id.length > 0);
      }
    });
  });
});
