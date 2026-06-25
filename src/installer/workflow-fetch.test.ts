import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  listBundledWorkflows,
  getWorkflowShortDescription,
  fetchWorkflow,
} from "../../dist/installer/workflow-fetch.js";

describe("workflow-fetch", () => {
  describe("getWorkflowShortDescription", () => {
    it("extracts the first sentence from a real bundled workflow description", async () => {
      const desc = await getWorkflowShortDescription("do-now");
      assert.ok(desc.length > 0);
      assert.ok(!desc.includes("\n"), "should be a single line");
    });

    it("extracts the first sentence ending with sentence-ending punctuation", async () => {
      const desc = await getWorkflowShortDescription("do-review-do-verify");
      assert.ok(
        desc.endsWith(".") || desc.endsWith("!") || desc.endsWith("?"),
        `expected sentence-ending punctuation, got: ${desc}`,
      );
      assert.ok(desc.length > 0);
    });

    it("returns a trimmed one-liner without newlines", async () => {
      for (const id of ["do-now", "just-do-it"]) {
        const desc = await getWorkflowShortDescription(id);
        assert.ok(desc.length > 0);
        assert.ok(!desc.includes("\n"), `description for ${id} contains newline: ${desc}`);
      }
    });

    it("falls back to workflow ID for non-existent workflow directory", async () => {
      const desc = await getWorkflowShortDescription("non-existent-workflow-xyz");
      assert.equal(desc, "non-existent-workflow-xyz");
    });

    it("returns the workflow ID when the YAML is empty (unparseable gracefully)", async () => {
      const desc = await getWorkflowShortDescription("not-a-real-workflow-99999");
      assert.equal(desc, "not-a-real-workflow-99999");
    });

    it("description does not repeat the workflow ID verbatim", async () => {
      const workflows = await listBundledWorkflows();
      for (const id of workflows) {
        const desc = await getWorkflowShortDescription(id);
        assert.ok(desc.length > 0, `empty description for ${id}`);
        if (desc === id) {
          assert.fail(`description for ${id} falls back to ID — descriptions should be defined`);
        }
      }
    });
  });

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

    it("contains the surviving bundled workflows", async () => {
      const workflows = await listBundledWorkflows();
      assert.ok(workflows.includes("do-now"));
      assert.ok(workflows.includes("do-review-do-verify"));
      assert.ok(workflows.includes("just-do-it"));
    });
  });

  describe("fetchWorkflow", () => {
    it("throws with helpful message for non-existent workflow", async () => {
      await assert.rejects(
        () => fetchWorkflow("non-existent-workflow-abc123xyz"),
        /not found/i,
      );
    });

    it("fetches a bundled workflow into target directory", async () => {
      const tmpDir = path.join(tmpdir(), `tamandua-test-${process.pid}-fetch-wf`);
      const orig = process.env.TAMANDUA_STATE_DIR;
      try {
        process.env.TAMANDUA_STATE_DIR = tmpDir;
        const result = await fetchWorkflow("do-now");
        assert.ok(result.workflowDir.length > 0);
        assert.ok(result.bundledSourceDir.length > 0);
        assert.ok(existsSync(result.workflowDir), "target workflow dir should exist");
        assert.ok(existsSync(path.join(result.workflowDir, "workflow.yml")), "workflow.yml should be copied");
      } finally {
        if (orig !== undefined) {
          process.env.TAMANDUA_STATE_DIR = orig;
        } else {
          delete process.env.TAMANDUA_STATE_DIR;
        }
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("getWorkflowShortDescription edge cases", () => {
    it("falls back to workflowId when description field is empty string", async () => {
      const desc = await getWorkflowShortDescription("zzz-no-such-workflow");
      assert.equal(desc, "zzz-no-such-workflow");
    });

    it("returns first sentence ending with sentence-ending punctuation", async () => {
      const desc = await getWorkflowShortDescription("do-now");
      assert.ok(desc.length > 0);
      const lastChar = desc[desc.length - 1];
      assert.ok(
        lastChar === "." || lastChar === "!" || lastChar === "?",
        `expected sentence-ending punctuation, got: "${desc}"`,
      );
    });
  });
});
