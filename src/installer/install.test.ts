import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getMaxRoleTimeoutSeconds,
  getRoleTimeoutSeconds,
  inferRole,
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
      assert.equal(inferRole("feature-dev-merge_prioritizer"), "analysis");
    });

    it("returns 'analysis' for reviewer agent", () => {
      assert.equal(inferRole("REVIEWER"), "analysis");
    });

    it("returns 'analysis' for investigator agent", () => {
      assert.equal(inferRole("investigator"), "analysis");
    });

    it("returns 'analysis' for triager agent", () => {
      assert.equal(inferRole("bug-fix_triager"), "analysis");
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
