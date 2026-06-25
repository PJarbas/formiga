// ══════════════════════════════════════════════════════════════════════
// workflow-spec-parallel-group.test.ts — Validation of parallel_group field
// ══════════════════════════════════════════════════════════════════════

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";

function makeBaseSpec(steps: Array<Record<string, unknown>>): string {
  // Minimal valid spec with one agent referenced by every step.
  // We render YAML by hand to keep the fixture self-contained.
  const agents = `
agents:
  - id: a
    workspace:
      baseDir: agents/a
`;
  const stepLines = steps
    .map((s) => {
      const parts = [
        `  - id: ${s.id}`,
        `    agent: ${s.agent ?? "a"}`,
      ];
      if (s.parallel_group !== undefined) {
        const v = JSON.stringify(s.parallel_group);
        parts.push(`    parallel_group: ${v}`);
      }
      return parts.join("\n");
    })
    .join("\n");
  return `id: wf-test\nname: WF Test\nversion: 1\n${agents}steps:\n${stepLines}\n`;
}

function writeSpec(dir: string, yaml: string): void {
  fs.writeFileSync(path.join(dir, "workflow.yml"), yaml);
}

describe("workflow-spec parallel_group validation", () => {
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-wf-spec-test-"));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function freshWorkflowDir(name: string): string {
    const d = path.join(tempDir, name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it("accepts spec with no parallel_group at all", async () => {
    const dir = freshWorkflowDir("none");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1" },
        { id: "s2" },
        { id: "s3" },
      ]),
    );
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps.length, 3);
  });

  it("accepts contiguous parallel_group block", async () => {
    const dir = freshWorkflowDir("contiguous");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1" },
        { id: "s2", parallel_group: "g1" },
        { id: "s3", parallel_group: "g1" },
        { id: "s4" },
      ]),
    );
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps.length, 4);
  });

  it("accepts multiple distinct parallel_groups", async () => {
    const dir = freshWorkflowDir("multi-groups");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1", parallel_group: "g1" },
        { id: "s2", parallel_group: "g1" },
        { id: "s3", parallel_group: "g2" },
        { id: "s4", parallel_group: "g2" },
      ]),
    );
    const spec = await loadWorkflowSpec(dir);
    assert.equal(spec.steps.length, 4);
  });

  it("rejects empty parallel_group string", async () => {
    const dir = freshWorkflowDir("empty");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1", parallel_group: "" },
      ]),
    );
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /empty parallel_group/,
    );
  });

  it("rejects non-string parallel_group (number)", async () => {
    const dir = freshWorkflowDir("number");
    // Hand-write YAML so we can inject a numeric value.
    const yaml = [
      "id: wf-test",
      "name: WF",
      "version: 1",
      "agents:",
      "  - id: a",
      "    workspace:",
      "      baseDir: agents/a",
      "steps:",
      "  - id: s1",
      "    agent: a",
      "    parallel_group: 42",
    ].join("\n");
    writeSpec(dir, yaml);
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /parallel_group: must be a string/,
    );
  });

  it("rejects non-contiguous parallel_group (split by non-group step)", async () => {
    const dir = freshWorkflowDir("non-contig-split");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1", parallel_group: "g1" },
        { id: "s2" }, // breaks the group
        { id: "s3", parallel_group: "g1" },
      ]),
    );
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /non-contiguous parallel_group "g1"/,
    );
  });

  it("rejects non-contiguous parallel_group (split by different group)", async () => {
    const dir = freshWorkflowDir("non-contig-swap");
    writeSpec(
      dir,
      makeBaseSpec([
        { id: "s1", parallel_group: "g1" },
        { id: "s2", parallel_group: "g2" },
        { id: "s3", parallel_group: "g1" },
      ]),
    );
    await assert.rejects(
      () => loadWorkflowSpec(dir),
      /non-contiguous parallel_group "g1"/,
    );
  });
});
