import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseOutputKeyValues, resolveTemplate, buildStoryPlanSection, mergeStoryPlanIntoProgress } from "../dist/installer/step-ops.js";

describe("parseOutputKeyValues", () => {
  it("parses simple KEY: value pairs", () => {
    const result = parseOutputKeyValues("STATUS: done\nCHANGES: fixed bug\nTESTS: ran suite");
    assert.equal(result.status, "done");
    assert.equal(result.changes, "fixed bug");
    assert.equal(result.tests, "ran suite");
  });

  it("last value wins for duplicate keys", () => {
    const result = parseOutputKeyValues("STATUS: first\nSTATUS: second\nSTATUS: final");
    assert.equal(result.status, "final");
  });

  it("handles multi-line values", () => {
    const result = parseOutputKeyValues(
      "STATUS: done\nCHANGES: fixed bug\n  - item 1\n  - item 2\nTESTS: all pass"
    );
    assert.equal(result.changes, "fixed bug\n  - item 1\n  - item 2");
  });

  it("skips STORIES_JSON keys", () => {
    const result = parseOutputKeyValues("STORIES_JSON: [{...}]\nSTATUS: done");
    assert.equal(result.status, "done");
    assert.ok(!result.stories_json);
  });

  it("returns empty object for empty input", () => {
    const result = parseOutputKeyValues("");
    assert.deepEqual(result, {});
  });

  it("handles KEY with empty value", () => {
    const result = parseOutputKeyValues("STATUS:\nCHANGES: something");
    assert.equal(result.status, "");
    assert.equal(result.changes, "something");
  });
});

describe("resolveTemplate", () => {
  it("replaces {{key}} with context values", () => {
    const result = resolveTemplate("Hello {{name}}", { name: "world" });
    assert.equal(result, "Hello world");
  });

  it("replaces multiple placeholders", () => {
    const result = resolveTemplate("{{greeting}} {{name}} from {{place}}", {
      greeting: "Hi",
      name: "Igor",
      place: "Brazil",
    });
    assert.equal(result, "Hi Igor from Brazil");
  });

  it("uses case-insensitive lookup", () => {
    const result = resolveTemplate("{{task}} and {{TASK}}", { task: "fix bug" });
    assert.equal(result, "fix bug and fix bug");
  });

  it("shows [missing: key] for unresolved keys", () => {
    const result = resolveTemplate("Hello {{missing}}", {});
    assert.equal(result, "Hello [missing: missing]");
  });

  it("passes through text without placeholders", () => {
    const result = resolveTemplate("plain text", {});
    assert.equal(result, "plain text");
  });
});

describe("buildStoryPlanSection", () => {
  it("builds a Story Plan section from stories", () => {
    const stories = [
      {
        storyId: "US-001",
        title: "Add login",
        description: "Implement user login flow",
        acceptanceCriteria: ["User can log in", "Invalid creds show error"],
      },
      {
        storyId: "US-002",
        title: "Add dashboard",
        description: "Create user dashboard",
        acceptanceCriteria: ["Shows user stats", "Responsive design"],
      },
    ];

    const result = buildStoryPlanSection(stories);

    assert.ok(result.includes("## Story Plan"));
    assert.ok(result.includes("### US-001: Add login"));
    assert.ok(result.includes("**Description:** Implement user login flow"));
    assert.ok(result.includes("**Acceptance Criteria:**"));
    assert.ok(result.includes("- User can log in"));
    assert.ok(result.includes("- Invalid creds show error"));
    assert.ok(result.includes("### US-002: Add dashboard"));
    assert.ok(result.includes("**Description:** Create user dashboard"));
    assert.ok(result.includes("- Shows user stats"));
    assert.ok(result.includes("- Responsive design"));
  });

  it("returns just the heading for empty array", () => {
    const result = buildStoryPlanSection([]);
    assert.equal(result, "## Story Plan\n\n");
  });

  it("handles stories with single acceptance criterion", () => {
    const stories = [
      {
        storyId: "US-001",
        title: "Fix bug",
        description: "Fix the crash",
        acceptanceCriteria: ["App does not crash"],
      },
    ];

    const result = buildStoryPlanSection(stories);
    assert.ok(result.includes("- App does not crash"));
    assert.ok(!result.includes("\n\n\n")); // No double blank lines from missing ACs
  });
});

describe("mergeStoryPlanIntoProgress", () => {
  const storySection = "## Story Plan\n\n### US-001: Do thing\n\n**Description:** A thing to do\n\n**Acceptance Criteria:**\n- It works\n";

  it("creates new progress file with Story Plan when content is empty", () => {
    const result = mergeStoryPlanIntoProgress("", storySection);
    assert.ok(result.startsWith("# Progress Log"));
    assert.ok(result.includes(storySection));
  });

  it("inserts Story Plan after header when content has no Story Plan", () => {
    const existing = "# Progress Log\n\n## Codebase Patterns\n- Uses SQLite\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);
    assert.ok(result.startsWith("# Progress Log\n\n"));
    assert.ok(result.includes(storySection.trim()));
    assert.ok(result.includes("## Codebase Patterns"));
    assert.ok(result.includes("- Uses SQLite"));
    // Story Plan should come before Codebase Patterns
    const storyIdx = result.indexOf("## Story Plan");
    const patternsIdx = result.indexOf("## Codebase Patterns");
    assert.ok(storyIdx < patternsIdx, "Story Plan should appear before Codebase Patterns");
  });

  it("replaces existing Story Plan section while preserving other content", () => {
    const oldStorySection = "## Story Plan\n\n### OLD-001: Old story\n\n**Description:** Outdated\n\n**Acceptance Criteria:**\n- Old AC\n";
    const existing = "# Progress Log\n\n## Codebase Patterns\n- Pattern A\n\n" + oldStorySection + "\n## Other Section\n- Note\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);

    // Should keep Codebase Patterns
    assert.ok(result.includes("## Codebase Patterns"));
    assert.ok(result.includes("- Pattern A"));
    // Should keep Other Section
    assert.ok(result.includes("## Other Section"));
    assert.ok(result.includes("- Note"));
    // Should have new Story Plan
    assert.ok(result.includes("### US-001: Do thing"));
    // Should NOT have old Story Plan
    assert.ok(!result.includes("### OLD-001: Old story"));
    assert.ok(!result.includes("Old AC"));
  });

  it("replaces Story Plan when it is the only content", () => {
    const oldStorySection = "## Story Plan\n\n### OLD-001: Old story\n\n**Description:** Outdated\n\n**Acceptance Criteria:**\n- Old AC\n";
    const result = mergeStoryPlanIntoProgress("# Progress Log\n\n" + oldStorySection, storySection);
    assert.ok(result.includes("### US-001: Do thing"));
    assert.ok(!result.includes("### OLD-001: Old story"));
  });

  it("inserts Story Plan at top when content has no heading", () => {
    const existing = "Just some notes\nno heading here\n";
    const result = mergeStoryPlanIntoProgress(existing, storySection);
    assert.ok(result.includes(storySection.trim()));
    assert.ok(result.includes("Just some notes"));
  });
});
