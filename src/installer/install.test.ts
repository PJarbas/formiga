import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  getMaxRoleTimeoutSeconds,
  getRoleTimeoutSeconds,
  inferRole,
  installWorkflow,
} from "../../dist/installer/install.js";

describe("install exports", () => {
  describe("getMaxRoleTimeoutSeconds", () => {
    it("returns a positive number", () => {
      const max = getMaxRoleTimeoutSeconds();
      assert.ok(max > 0);
    });

    it("returns the maximum timeout (1800 for 30-min roles)", () => {
      const max = getMaxRoleTimeoutSeconds();
      // coding, testing roles are 1800; others are 1200
      assert.equal(max, 1800);
    });
  });

  describe("getRoleTimeoutSeconds", () => {
    it("returns 1800 for analysis role (30 min)", () => {
      assert.equal(getRoleTimeoutSeconds("analysis"), 1800);
    });

    it("returns 1800 for coding role (30 min)", () => {
      assert.equal(getRoleTimeoutSeconds("coding"), 1800);
    });

    it("returns 1200 for verification role (20 min)", () => {
      assert.equal(getRoleTimeoutSeconds("verification"), 1200);
    });

    it("returns 1800 for testing role (30 min)", () => {
      assert.equal(getRoleTimeoutSeconds("testing"), 1800);
    });

    it("returns 1200 for pr role (20 min)", () => {
      assert.equal(getRoleTimeoutSeconds("pr"), 1200);
    });

    it("returns 1200 for scanning role (20 min)", () => {
      assert.equal(getRoleTimeoutSeconds("scanning"), 1200);
    });
  });

  describe("inferRole", () => {
    it("returns 'analysis' for planner agent", () => {
      assert.equal(inferRole("planner"), "analysis");
    });

    it("returns 'analysis' for prioritizer agent", () => {
      assert.equal(inferRole("merge_prioritizer"), "analysis");
    });

    it("returns 'analysis' for reviewer agent", () => {
      assert.equal(inferRole("REVIEWER"), "analysis");
    });

    it("returns 'analysis' for investigator agent", () => {
      assert.equal(inferRole("investigator"), "analysis");
    });

    it("returns 'analysis' for triager agent", () => {
      assert.equal(inferRole("triager"), "analysis");
    });

    it("returns 'verification' for verifier agent", () => {
      assert.equal(inferRole("verifier"), "verification");
    });

    it("returns 'testing' for tester agent", () => {
      assert.equal(inferRole("tester"), "testing");
    });

    it("returns 'scanning' for scanner agent", () => {
      assert.equal(inferRole("security-scanner"), "scanning");
    });

    it("returns 'pr' for agent id 'pr'", () => {
      assert.equal(inferRole("pr"), "pr");
    });

    it("returns 'pr' for agent id containing '/pr'", () => {
      assert.equal(inferRole("workflow/pr"), "pr");
    });

    it("returns 'coding' for developer agent", () => {
      assert.equal(inferRole("developer"), "coding");
    });

    it("returns 'coding' for fixer agent", () => {
      assert.equal(inferRole("fixer"), "coding");
    });

    it("returns 'coding' for setup agent", () => {
      assert.equal(inferRole("setup"), "coding");
    });

    it("returns 'coding' for unknown agent id", () => {
      assert.equal(inferRole("unknown-agent"), "coding");
    });

    it("is case-insensitive", () => {
      assert.equal(inferRole("PLANNER"), "analysis");
      assert.equal(inferRole("Developer"), "coding");
      assert.equal(inferRole("VERIFIER"), "verification");
    });
  });
});

describe("installWorkflow", () => {
  let tempHome: string;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-install-"));
    process.env.HOME = tempHome;
    delete process.env.TAMANDUA_STATE_DIR;

    // Create minimal pi config so readPiConfig doesn't fail on ENOENT
    const piAgentDir = path.join(tempHome, ".pi", "agent");
    fs.mkdirSync(piAgentDir, { recursive: true });
    fs.writeFileSync(
      path.join(piAgentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4" }),
      "utf-8",
    );
  });

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalStateDir) process.env.TAMANDUA_STATE_DIR = originalStateDir;
    else delete process.env.TAMANDUA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("installs do-now workflow successfully", async () => {
    const result = await installWorkflow({ workflowId: "do-now" });

    assert.equal(result.workflowId, "do-now");
    assert.ok(result.workflowDir.includes("do-now"), "workflowDir should contain do-now");

    // Verify workflow directory exists
    assert.ok(fs.existsSync(result.workflowDir), "workflow dir should exist");

    // Verify workflow.yml was copied
    const ymlPath = path.join(result.workflowDir, "workflow.yml");
    assert.ok(fs.existsSync(ymlPath), "workflow.yml should exist");

    // Verify metadata.json was written
    const metadataPath = path.join(result.workflowDir, "metadata.json");
    assert.ok(fs.existsSync(metadataPath), "metadata.json should exist");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    assert.equal(metadata.workflowId, "do-now");
    assert.ok(metadata.installedAt, "should have installedAt timestamp");

    // Verify agents.json was created with the workflow agents
    const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
    assert.ok(fs.existsSync(agentsPath), "agents.json should exist");
    const agentsList = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
    assert.ok(Array.isArray(agentsList), "agents list should be an array");

    // Should have at least the main agent plus the workflow agents
    assert.ok(agentsList.length >= 2, `expected at least 2 agents, got ${agentsList.length}`);

    // The main agent should be marked as default
    const mainAgent = agentsList.find((a: Record<string, unknown>) => a.id === "main");
    assert.ok(mainAgent, "main agent should exist");
    assert.equal(mainAgent.default, true, "main agent should be default");

    // Workflow agents should have workspace and agentDir
    const wfAgents = agentsList.filter((a: Record<string, unknown>) =>
      typeof a.id === "string" && a.id.startsWith("do-now_")
    );
    assert.ok(wfAgents.length > 0, "should have workflow agents");
    for (const agent of wfAgents) {
      assert.ok(agent.workspace, `agent ${agent.id} should have workspace`);
      assert.ok(agent.agentDir, `agent ${agent.id} should have agentDir`);
      assert.ok(agent.config, `agent ${agent.id} should have config`);
    }
  });

  it("installs do-review-do-verify workflow successfully", async () => {
    const result = await installWorkflow({ workflowId: "do-review-do-verify" });
    assert.equal(result.workflowId, "do-review-do-verify");

    const agentsPath = path.join(tempHome, ".tamandua", "agents.json");
    const agentsList = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));

    const wfAgents = agentsList.filter((a: Record<string, unknown>) =>
      typeof a.id === "string" && a.id.startsWith("do-review-do-verify_")
    );
    assert.ok(wfAgents.length > 0, "do-review-do-verify should have agents");
  });

  it("idempotent: reinstalling same workflow does not crash", async () => {
    await installWorkflow({ workflowId: "do-now" });
    // Second install of the same workflow should work (overwrite)
    const result2 = await installWorkflow({ workflowId: "do-now" });
    assert.equal(result2.workflowId, "do-now");

    // The workflow directory should still exist and have metadata
    const metadataPath = path.join(result2.workflowDir, "metadata.json");
    assert.ok(fs.existsSync(metadataPath));
  });

  it("throws on non-existent workflow", async () => {
    await assert.rejects(
      () => installWorkflow({ workflowId: "nonexistent-wf-xyz" }),
      /not found/i,
    );
  });
});
