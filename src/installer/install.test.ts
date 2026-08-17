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
    originalStateDir = process.env.FORMIGA_STATE_DIR;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "formiga-install-"));
    process.env.HOME = tempHome;
    delete process.env.FORMIGA_STATE_DIR;

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
    if (originalStateDir) process.env.FORMIGA_STATE_DIR = originalStateDir;
    else delete process.env.FORMIGA_STATE_DIR;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("idempotent: reinstalling same workflow does not crash", async () => {
    await installWorkflow({ workflowId: "ml-pipeline" });
    // Second install of the same workflow should work (overwrite)
    const result2 = await installWorkflow({ workflowId: "ml-pipeline" });
    assert.equal(result2.workflowId, "ml-pipeline");

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
