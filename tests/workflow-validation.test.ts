import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadWorkflowSpec } from "../dist/installer/workflow-spec.js";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const workflowsDir = resolveBundledWorkflowsDir();
const workflowIds = readdirSync(workflowsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

function wfDir(id: string): string {
  return resolve(workflowsDir, id);
}

describe("workflow parsing", () => {
  it("bundles the surviving workflows", () => {
    assert.ok(workflowIds.includes("ml-autoresearch"));
    assert.ok(workflowIds.includes("ml-pipeline"));
  });

  for (const id of workflowIds) {
    it(`parses ${id} workflow YAML without errors`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
      assert.ok(spec.agents.length > 0);
      assert.ok(spec.steps.length > 0);
    });

    it(`${id} has valid polling config`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      if (spec.polling) {
        assert.ok(typeof spec.polling === "object");
      }
    });

    it(`${id} agents have valid roles if specified`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      const validRoles = new Set(["analysis", "coding", "verification", "testing", "pr", "scanning"]);
      for (const agent of spec.agents) {
        if (agent.role) assert.ok(validRoles.has(agent.role), `${agent.id}: "${agent.role}" is valid`);
      }
    });

    it(`${id} has a non-empty description`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.ok(typeof spec.description === "string", `${id}: description must be a string`);
      assert.ok(spec.description.trim().length > 0, `${id}: description must not be empty`);
    });

    it(`${id} agent workspace files exist`, async () => {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
          const resolved = resolve(wfDir(id), relativePath);
          assert.ok(existsSync(resolved),
            `${id}/${agent.id}: ${relativePath} should exist (for ${fileName})`);
        }
      }
    });
  }
});

describe("workflow structure", () => {
  it("shared agent personas exist", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const sharedDir = resolve(repoRoot, "agents", "shared");
    for (const persona of ["setup", "verifier"]) {
      const d = resolve(sharedDir, persona);
      if (!existsSync(d)) continue;
      for (const f of ["AGENTS.md", "SOUL.md", "IDENTITY.md"]) {
        assert.ok(existsSync(resolve(d, f)), `shared/${persona}/${f}`);
      }
    }
  });

  it("formiga-agents skill exists with required frontmatter", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "formiga-agents", "SKILL.md");
    assert.ok(existsSync(skillPath));

    const content = readFileSync(skillPath, "utf-8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "missing YAML frontmatter");

    const fm = frontmatter![1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descriptionMatch = fm.match(/^description:\s*(.+)$/m);

    assert.ok(nameMatch, "frontmatter must include name");
    assert.ok(descriptionMatch, "frontmatter must include description");
    assert.equal(nameMatch![1].trim(), "formiga-agents");
    assert.match(nameMatch![1].trim(), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("bundled workflow agents declare formiga-agents skill", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("formiga-agents"),
          `${id}/${agent.id}: workspace.skills must include formiga-agents`,
        );
      }
    }
  });

  it("all steps reference valid agents", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      const agentIds = new Set(spec.agents.map((a) => a.id));
      for (const step of spec.steps) {
        assert.ok(agentIds.has(step.agent),
          `${id}: step "${step.id}" references unknown agent "${step.agent}"`);
      }
    }
  });

  it("workflow IDs match directory names", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      assert.equal(spec.id, id);
    }
  });
});
