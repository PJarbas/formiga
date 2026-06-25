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
    assert.ok(workflowIds.includes("do-now"));
    assert.ok(workflowIds.includes("do-review-do-verify"));
    assert.ok(workflowIds.includes("just-do-it"));
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

  it("tamandua-agents skill exists with required frontmatter", () => {
    const repoRoot = resolve(workflowsDir, "..");
    const skillPath = resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md");
    assert.ok(existsSync(skillPath));

    const content = readFileSync(skillPath, "utf-8");
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "missing YAML frontmatter");

    const fm = frontmatter![1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descriptionMatch = fm.match(/^description:\s*(.+)$/m);

    assert.ok(nameMatch, "frontmatter must include name");
    assert.ok(descriptionMatch, "frontmatter must include description");
    assert.equal(nameMatch![1].trim(), "tamandua-agents");
    assert.match(nameMatch![1].trim(), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("bundled workflow agents declare tamandua-agents skill", async () => {
    for (const id of workflowIds) {
      const spec = await loadWorkflowSpec(wfDir(id));
      for (const agent of spec.agents) {
        const skills = agent.workspace.skills ?? [];
        assert.ok(
          skills.includes("tamandua-agents"),
          `${id}/${agent.id}: workspace.skills must include tamandua-agents`,
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

describe("US-002: doer agent persona", () => {
  const doerDir = resolve(wfDir("do-review-do-verify"), "agents", "doer");
  const doerAgentsMd = resolve(doerDir, "AGENTS.md");

  it("doer persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(doerDir, f);
      assert.ok(existsSync(path), `doer/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `doer/${f} should be non-empty`);
    }
  });

  it("AGENTS.md describes both initial execution and refinement modes", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /Initial Execution/);
    assert.match(content, /step "do"/);
    assert.match(content, /Refinement/);
    assert.match(content, /step "do-again"/);
  });

  it("AGENTS.md mandates STATUS: done|failed and CHANGES: output fields", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /STATUS:\s*done\|failed/);
    assert.match(content, /CHANGES:/);
    assert.match(content, /done.*success/i);
    assert.match(content, /failed.*not.*complete/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous attempt.*reject/i);
  });

  it("AGENTS.md output format includes REPORT field", () => {
    const content = readFileSync(doerAgentsMd, "utf-8");
    assert.match(content, /REPORT:/);
    assert.match(content, /detailed report/);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(doerDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Doer/);
    assert.match(content, /Role:\s*Executes arbitrary tasks/);
  });

  it("SOUL.md describes doer personality", () => {
    const content = readFileSync(resolve(doerDir, "SOUL.md"), "utf-8");
    assert.match(content, /get things done/i);
    assert.match(content, /honest/i);
    assert.match(content, /feedback/i);
  });
});

describe("US-003: reviewer agent persona", () => {
  const reviewerDir = resolve(wfDir("do-review-do-verify"), "agents", "reviewer");
  const reviewerAgentsMd = resolve(reviewerDir, "AGENTS.md");

  it("reviewer persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(reviewerDir, f);
      assert.ok(existsSync(path), `reviewer/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `reviewer/${f} should be non-empty`);
    }
  });

  it("AGENTS.md mandates STATUS: done, FEEDBACK:, and ISSUES: output fields", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    assert.match(content, /STATUS:\s*done/);
    assert.match(content, /FEEDBACK:/);
    assert.match(content, /ISSUES:/);
    assert.match(content, /what was done well/i);
    assert.match(content, /specific problems/i);
  });

  it("AGENTS.md handles perfect-work case (no issues found)", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    assert.match(content, /perfect/i);
    assert.match(content, /ISSUES:\s*none/);
    assert.match(content, /no changes/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous.*review.*reject/i);
  });

  it("AGENTS.md describes review process against original task", () => {
    const content = readFileSync(reviewerAgentsMd, "utf-8");
    assert.match(content, /\{\{task\}\}/);
    assert.match(content, /\{\{changes\}\}/);
    assert.match(content, /\{\{report\}\}/);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(reviewerDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Reviewer/);
    assert.match(content, /Role:\s*Reviews completed work/);
  });

  it("SOUL.md describes reviewer personality as thorough, constructive, specific", () => {
    const content = readFileSync(resolve(reviewerDir, "SOUL.md"), "utf-8");
    assert.match(content, /thorough/i);
    assert.match(content, /constructive/i);
    assert.match(content, /specific/i);
    assert.match(content, /feedback/i);
  });
});

describe("US-004: verifier agent persona", () => {
  const verifierDir = resolve(wfDir("do-review-do-verify"), "agents", "verifier");
  const verifierAgentsMd = resolve(verifierDir, "AGENTS.md");

  it("verifier persona files exist and are non-empty", () => {
    for (const f of ["AGENTS.md", "IDENTITY.md", "SOUL.md"]) {
      const path = resolve(verifierDir, f);
      assert.ok(existsSync(path), `verifier/${f} should exist`);
      const content = readFileSync(path, "utf-8");
      assert.ok(content.length > 0, `verifier/${f} should be non-empty`);
    }
  });

  it("AGENTS.md mandates STATUS: done, VERDICT:, and DETAILS: output fields", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /STATUS:\s*done/);
    assert.match(content, /VERDICT:\s*(accomplished\|not_accomplished|not_accomplished\|accomplished)/);
    assert.match(content, /DETAILS:/);
    assert.match(content, /accomplished/i);
    assert.match(content, /not.?accomplished/i);
    assert.match(content, /detailed reasoning/i);
  });

  it("AGENTS.md describes comparing output against original task description", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /\{\{task\}\}/);
    assert.match(content, /original task/i);
    assert.match(content, /\{\{changes\}\}/);
    assert.match(content, /\{\{report\}\}/);
  });

  it("AGENTS.md requires detailed feedback regardless of accomplishment", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /regardless.*verdict|verdict.*regardless/i);
    assert.match(content, /evidence/i);
    assert.match(content, /accomplished.*explain|explain.*why/);
  });

  it("AGENTS.md considers both initial work and reviewer feedback", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /\{\{issues\}\}/);
    assert.match(content, /reviewer.*feedback|feedback.*reviewer/i);
    assert.match(content, /refinement|do.?again/i);
  });

  it("AGENTS.md references {{retry_feedback}} handling", () => {
    const content = readFileSync(verifierAgentsMd, "utf-8");
    assert.match(content, /\{\{retry_feedback\}\}/);
    assert.match(content, /retry_feedback/i);
    assert.match(content, /previous.*verification.*reject/i);
  });

  it("IDENTITY.md has correct name and role", () => {
    const content = readFileSync(resolve(verifierDir, "IDENTITY.md"), "utf-8");
    assert.match(content, /Name:\s*Verifier/);
    assert.match(content, /Role:\s*Judges task accomplishment/);
  });

  it("SOUL.md describes verifier as fair, objective, evidence-based judge", () => {
    const content = readFileSync(resolve(verifierDir, "SOUL.md"), "utf-8");
    assert.match(content, /fair/i);
    assert.match(content, /objective/i);
    assert.match(content, /evidence/i);
    assert.match(content, /judge/i);
  });
});

describe("US-005: do-review-do-verify workflow structure", () => {
  const loadSpec = () => loadWorkflowSpec(wfDir("do-review-do-verify"));

  it("has 3 agents: doer, reviewer, verifier", async () => {
    const spec = await loadSpec();
    assert.equal(spec.agents.length, 3);
    const agentIds = spec.agents.map((a) => a.id);
    assert.deepEqual(agentIds, ["doer", "reviewer", "verifier"]);
  });

  it("has 4 steps in correct order: do → review → do-again → verify", async () => {
    const spec = await loadSpec();
    assert.equal(spec.steps.length, 4);
    const stepIds = spec.steps.map((s) => s.id);
    assert.deepEqual(stepIds, ["do", "review", "do-again", "verify"]);
  });

  it("all agents have tamandua-agents skill", async () => {
    const spec = await loadSpec();
    for (const agent of spec.agents) {
      const skills = agent.workspace.skills ?? [];
      assert.ok(
        skills.includes("tamandua-agents"),
        `do-review-do-verify/${agent.id}: workspace.skills must include tamandua-agents`,
      );
    }
  });

  it("all agent workspace files exist", async () => {
    const spec = await loadSpec();
    for (const agent of spec.agents) {
      for (const [fileName, relativePath] of Object.entries(agent.workspace.files)) {
        const resolved = resolve(wfDir("do-review-do-verify"), relativePath);
        assert.ok(existsSync(resolved),
          `do-review-do-verify/${agent.id}: ${relativePath} should exist (for ${fileName})`);
      }
    }
  });

  it("all steps reference valid agent ids", async () => {
    const spec = await loadSpec();
    const agentIds = new Set(spec.agents.map((a) => a.id));
    for (const step of spec.steps) {
      assert.ok(agentIds.has(step.agent),
        `step "${step.id}" references unknown agent "${step.agent}"`);
    }
  });

  it("steps have correct agent assignments", async () => {
    const spec = await loadSpec();
    assert.equal(spec.steps[0].agent, "doer");
    assert.equal(spec.steps[1].agent, "reviewer");
    assert.equal(spec.steps[2].agent, "doer");
    assert.equal(spec.steps[3].agent, "verifier");
  });

  it("do step input passes task context", async () => {
    const spec = await loadSpec();
    const doStep = spec.steps.find((s) => s.id === "do");
    assert.ok(doStep);
    assert.match(doStep!.input, /\{\{task\}\}/);
    assert.match(doStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("review step input passes task, changes, report, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const reviewStep = spec.steps.find((s) => s.id === "review");
    assert.ok(reviewStep);
    assert.match(reviewStep!.input, /\{\{task\}\}/);
    assert.match(reviewStep!.input, /\{\{changes\}\}/);
    assert.match(reviewStep!.input, /\{\{report\}\}/);
    assert.match(reviewStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("do-again step input passes task, feedback, issues, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const doAgainStep = spec.steps.find((s) => s.id === "do-again");
    assert.ok(doAgainStep);
    assert.match(doAgainStep!.input, /\{\{task\}\}/);
    assert.match(doAgainStep!.input, /\{\{feedback\}\}/);
    assert.match(doAgainStep!.input, /\{\{issues\}\}/);
    assert.match(doAgainStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("verify step input passes task, changes, report, issues, and retry_feedback context", async () => {
    const spec = await loadSpec();
    const verifyStep = spec.steps.find((s) => s.id === "verify");
    assert.ok(verifyStep);
    assert.match(verifyStep!.input, /\{\{task\}\}/);
    assert.match(verifyStep!.input, /\{\{changes\}\}/);
    assert.match(verifyStep!.input, /\{\{report\}\}/);
    assert.match(verifyStep!.input, /\{\{issues\}\}/);
    assert.match(verifyStep!.input, /\{\{retry_feedback\}\}/);
  });

  it("is a linear pipeline (no loop wiring)", async () => {
    const spec = await loadSpec();
    for (const step of spec.steps) {
      assert.equal(step.type, undefined, `step "${step.id}" should not have loop wiring`);
    }
  });

  it("has no merge or finalize_merge step", async () => {
    const spec = await loadSpec();
    const stepIds = spec.steps.map((s) => s.id);
    assert.ok(!stepIds.includes("merge"));
    assert.ok(!stepIds.includes("finalize_merge"));
  });
});
