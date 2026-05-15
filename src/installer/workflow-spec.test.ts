import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadWorkflowSpec } from "../../dist/installer/workflow-spec.js";

function createTempWorkflow(ymlContent: string): string {
  const dir = mkdtempSync("/tmp/tamandua-test-workflow-spec-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workflow.yml"),
    ymlContent,
    "utf-8",
  );
  return dir;
}

const MINIMAL_VALID_YML = `
id: test-workflow
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;

describe("loadWorkflowSpec run.workspace validation", () => {
  it("missing run section defaults to direct (no error)", async () => {
    const dir = createTempWorkflow(MINIMAL_VALID_YML);
    try {
      const spec = await loadWorkflowSpec(dir);
      assert.equal(spec.id, "test-workflow");
      // run.workspace should not throw when missing
      const workspace = spec.run?.workspace ?? "direct";
      assert.equal(workspace, "direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.workspace: direct is valid and parses correctly", async () => {
    const yml = `
id: test-workflow
run:
  workspace: direct
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      assert.equal(spec.id, "test-workflow");
      assert.equal(spec.run?.workspace, "direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.workspace: worktree is valid and parses correctly", async () => {
    const yml = `
id: test-workflow
run:
  workspace: worktree
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      assert.equal(spec.id, "test-workflow");
      assert.equal(spec.run?.workspace, "worktree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.workspace with invalid value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: bananas
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      await assert.rejects(
        () => loadWorkflowSpec(dir),
        /invalid run\.workspace value.*bananas.*"direct" or "worktree"/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.workspace with numeric value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: 42
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      await assert.rejects(
        () => loadWorkflowSpec(dir),
        /invalid run\.workspace value.*"42".*"direct" or "worktree"/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.workspace with boolean value throws descriptive error", async () => {
    const yml = `
id: test-workflow
run:
  workspace: true
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      await assert.rejects(
        () => loadWorkflowSpec(dir),
        /invalid run\.workspace value.*"true".*"direct" or "worktree"/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run section without workspace field defaults to direct", async () => {
    const yml = `
id: test-workflow
run:
  other_field: value
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      const workspace = spec.run?.workspace ?? "direct";
      assert.equal(workspace, "direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WorkflowSpec type allows run.workspace access for direct", async () => {
    const yml = `
id: test-workflow
run:
  workspace: direct
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      // TypeScript level: spec.run.workspace should compile as "direct" | "worktree" | undefined
      const mode: "direct" | "worktree" = spec.run?.workspace ?? "direct";
      assert.equal(mode, "direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WorkflowSpec type allows run.workspace access for worktree", async () => {
    const yml = `
id: test-workflow
run:
  workspace: worktree
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      // TypeScript level: spec.run.workspace should compile as "direct" | "worktree" | undefined
      const mode: "direct" | "worktree" = spec.run?.workspace ?? "direct";
      assert.equal(mode, "worktree");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workflow without run field at all parses correctly", async () => {
    const yml = `
id: test-workflow-no-run
agents:
  - id: dev
    workspace:
      baseDir: agents/dev
steps:
  - id: step1
    agent: dev
    input: "hello"
    expects: "world"
`;
    const dir = createTempWorkflow(yml);
    try {
      const spec = await loadWorkflowSpec(dir);
      assert.equal(spec.id, "test-workflow-no-run");
      assert.equal(spec.run?.workspace ?? "direct", "direct");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
