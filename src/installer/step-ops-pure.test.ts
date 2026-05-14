import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseOutputKeyValues,
  resolveTemplate,
  findMissingTemplateKeys,
  buildStoryPlanSection,
  mergeStoryPlanIntoProgress,
  formatStoryForTemplate,
  formatCompletedStories,
} from "../../dist/installer/step-ops.js";
import type { Story } from "../../dist/installer/types.js";

describe("step-ops pure functions", () => {
  describe("parseOutputKeyValues", () => {
    it("parses single-line KEY: value pairs", () => {
      const result = parseOutputKeyValues("BRANCH: main\nFEATURE: login\n");
      assert.deepEqual(result, { branch: "main", feature: "login" });
    });

    it("lowercases keys", () => {
      const result = parseOutputKeyValues("MY_KEY: hello");
      assert.deepEqual(result, { my_key: "hello" });
    });

    it("skips STORIES_JSON keys", () => {
      const result = parseOutputKeyValues("BRANCH: main\nSTORIES_JSON: [...]\n");
      assert.deepEqual(result, { branch: "main" });
    });

    it("handles multi-line values", () => {
      const result = parseOutputKeyValues("DESC: line 1\nline 2\nNEXT: val\n");
      assert.deepEqual(result, { desc: "line 1\nline 2", next: "val" });
    });

    it("handles empty output", () => {
      assert.deepEqual(parseOutputKeyValues(""), {});
    });

    it("handles output with no KEY: lines", () => {
      assert.deepEqual(parseOutputKeyValues("just some text\nno keys here\n"), {});
    });
  });

  describe("resolveTemplate", () => {
    it("replaces {{key}} with context value", () => {
      const result = resolveTemplate("Hello {{name}}!", { name: "World" });
      assert.equal(result, "Hello World!");
    });

    it("resolves keys case-insensitively", () => {
      const result = resolveTemplate("{{BRANCH}}", { branch: "main" });
      assert.equal(result, "main");
    });

    it("substitutes [missing: key] for missing keys", () => {
      const result = resolveTemplate("{{missing_key}}", {});
      assert.equal(result, "[missing: missing_key]");
    });

    it("handles multiple placeholders", () => {
      const result = resolveTemplate("{{greeting}} {{name}}!", {
        greeting: "Hi",
        name: "Alice",
      });
      assert.equal(result, "Hi Alice!");
    });
  });

  describe("findMissingTemplateKeys", () => {
    it("returns keys not in context", () => {
      const missing = findMissingTemplateKeys("{{a}} {{b}}", { a: "1" });
      assert.deepEqual(missing, ["b"]);
    });

    it("returns empty array when all keys present", () => {
      const missing = findMissingTemplateKeys("{{a}} {{b}}", { a: "1", b: "2" });
      assert.deepEqual(missing, []);
    });

    it("handles case-insensitive matching", () => {
      const missing = findMissingTemplateKeys("{{BRANCH}}", { branch: "main" });
      assert.deepEqual(missing, []);
    });
  });

  describe("buildStoryPlanSection", () => {
    it("builds a markdown section from stories", () => {
      const stories = [{
        storyId: "US-001",
        title: "Login page",
        description: "Build a login page",
        acceptanceCriteria: ["User can enter credentials", "User sees error on failure"],
      }];
      const result = buildStoryPlanSection(stories);
      assert.ok(result.includes("## Story Plan"));
      assert.ok(result.includes("US-001: Login page"));
      assert.ok(result.includes("Build a login page"));
      assert.ok(result.includes("User can enter credentials"));
    });

    it("handles multiple stories", () => {
      const stories = [
        { storyId: "US-001", title: "Login", description: "Login flow", acceptanceCriteria: ["AC1"] },
        { storyId: "US-002", title: "Logout", description: "Logout flow", acceptanceCriteria: ["AC2"] },
      ];
      const result = buildStoryPlanSection(stories);
      assert.ok(result.includes("US-001"));
      assert.ok(result.includes("US-002"));
    });

    it("handles empty stories array", () => {
      const result = buildStoryPlanSection([]);
      assert.equal(result, "## Story Plan\n\n");
    });
  });

  describe("mergeStoryPlanIntoProgress", () => {
    it("inserts story plan after heading", () => {
      const existing = "# Progress Log\nSome existing content\n";
      const storyPlan = "## Story Plan\n\n### US-001\n";
      const result = mergeStoryPlanIntoProgress(existing, storyPlan);
      assert.ok(result.startsWith("# Progress Log\n"));
      assert.ok(result.includes("## Story Plan"));
      assert.ok(result.includes("Some existing content"));
    });

    it("replaces existing story plan section", () => {
      const existing = "# Progress Log\n## Story Plan\nold plan\n## Patterns\nsome patterns\n";
      const storyPlan = "## Story Plan\n\n### US-001: New\n";
      const result = mergeStoryPlanIntoProgress(existing, storyPlan);
      assert.ok(result.includes("### US-001: New"));
      assert.ok(!result.includes("old plan"));
      assert.ok(result.includes("## Patterns"));
    });

    it("handles empty existing content", () => {
      const storyPlan = "## Story Plan\n\n### US-001\n";
      const result = mergeStoryPlanIntoProgress("", storyPlan);
      assert.equal(result, "# Progress Log\n\n## Story Plan\n\n### US-001\n");
    });
  });

  describe("formatStoryForTemplate", () => {
    it("formats a story with acceptance criteria", () => {
      const story: Story = {
        id: "id1",
        runId: "run1",
        storyIndex: 0,
        storyId: "US-001",
        title: "Login",
        description: "Build login",
        acceptanceCriteria: ["AC1", "AC2"],
        status: "pending",
        retryCount: 0,
        maxRetries: 3,
      };
      const result = formatStoryForTemplate(story);
      assert.ok(result.includes("Story US-001: Login"));
      assert.ok(result.includes("Build login"));
      assert.ok(result.includes("Acceptance Criteria:"));
      assert.ok(result.includes("1. AC1"));
      assert.ok(result.includes("2. AC2"));
    });
  });

  describe("formatCompletedStories", () => {
    it("lists completed stories as bullets", () => {
      const stories: Story[] = [
        { id: "id1", runId: "run1", storyIndex: 0, storyId: "US-001", title: "Login", description: "", acceptanceCriteria: [], status: "done", retryCount: 0, maxRetries: 3 },
        { id: "id2", runId: "run1", storyIndex: 1, storyId: "US-002", title: "Logout", description: "", acceptanceCriteria: [], status: "done", retryCount: 0, maxRetries: 3 },
        { id: "id3", runId: "run1", storyIndex: 2, storyId: "US-003", title: "Profile", description: "", acceptanceCriteria: [], status: "pending", retryCount: 0, maxRetries: 3 },
      ];
      const result = formatCompletedStories(stories);
      assert.ok(result.includes("- US-001: Login"));
      assert.ok(result.includes("- US-002: Logout"));
      assert.ok(!result.includes("US-003"));
    });

    it("returns (none yet) when no completed stories", () => {
      const stories: Story[] = [
        { id: "id1", runId: "run1", storyIndex: 0, storyId: "US-001", title: "Login", description: "", acceptanceCriteria: [], status: "pending", retryCount: 0, maxRetries: 3 },
      ];
      assert.equal(formatCompletedStories(stories), "(none yet)");
    });
  });
});
