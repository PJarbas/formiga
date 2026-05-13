import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseOutputKeyValues, resolveTemplate, buildStoryPlanSection, mergeStoryPlanIntoProgress, validateExpects, completeStep, resolveStepContext, failStep, claimStep } from "../dist/installer/step-ops.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

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

describe("validateExpects", () => {
  it("returns null for empty expects", () => {
    assert.equal(validateExpects("any output", ""), null);
    assert.equal(validateExpects("any output", "  \n "), null);
  });

  it("passes when literal substring is present", () => {
    const result = validateExpects("STATUS: done\nPR: https://github.com/org/repo/pull/42", "STATUS: done");
    assert.equal(result, null);
  });

  it("fails when literal substring is missing", () => {
    const result = validateExpects("STATUS: fail\nError: something", "STATUS: done");
    assert.ok(result !== null);
    assert.ok(result!.includes("Output missing expects string"));
  });

  it("passes when regex matches output", () => {
    const result = validateExpects(
      "STATUS: done\nPR: https://github.com/org/repo/pull/42",
      "regex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+"
    );
    assert.equal(result, null);
  });

  it("rejects pull/new/<branch> placeholder URL", () => {
    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/bugfix-branch";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null);
    assert.ok(result!.includes("does not match expects regex"));
  });

  it("rejects pull/compare/<branch> URLs", () => {
    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/compare/main...feature";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null);
  });

  it("passes with valid HTTPS PR URL with number suffix", () => {
    const output = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/999";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("validates multi-line expects — all lines must pass", () => {
    const output = "STATUS: done\nPR: https://github.com/org/repo/pull/1";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("fails on multi-line expects when literal line is missing", () => {
    const output = "STATUS: retry\nPR: https://github.com/org/repo/pull/1";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.ok(result !== null);
    assert.ok(result!.includes("missing expects string"));
  });

  it("returns error for invalid regex pattern", () => {
    const result = validateExpects("any output", "regex:[invalid\\");
    assert.ok(result !== null);
    assert.ok(result!.includes("Invalid expects regex pattern"));
  });

  it("passes with http (non-https) PR URL", () => {
    const output = "STATUS: done\nPR: http://github.com/org/repo/pull/42";
    const expects = "STATUS: done\nregex:PR:\\s*https?://github\\.com/[^/]+/[^/]+/pull/\\d+";
    const result = validateExpects(output, expects);
    assert.equal(result, null);
  });

  it("treats blank lines in expects as ignored", () => {
    const result = validateExpects(
      "STATUS: done",
      "STATUS: done\n\n"
    );
    assert.equal(result, null);
  });
});

describe("PR agent persona regression", () => {
  const personaPath = path.join(repoRoot, "agents", "shared", "pr", "AGENTS.md");

  it("contains step fail guidance for gh pr create failure", () => {
    const content = fs.readFileSync(personaPath, "utf-8");
    assert.ok(content.includes("step fail"), "Persona must mention step fail");
    assert.ok(
      content.includes("gh pr create failed") || content.includes("gh pr create fails"),
      "Persona must handle gh pr create failure"
    );
    assert.ok(content.includes("Failure Handling"), "Persona must have a Failure Handling section");
    assert.ok(
      content.includes("pull/new/"),
      "Persona must explicitly forbid pull/new/ fallback URLs"
    );
    assert.ok(
      content.includes("Do not fall back") || content.includes("Do NOT fall back") || content.includes("Do NOT report a \\`pull/new/\\`"),
      "Persona must explicitly forbid falling back to manual URL"
    );
  });
});

describe("Workflow YAML PR step expects validation", () => {
  const bugFixPath = path.join(repoRoot, "workflows", "bug-fix-github-pr", "workflow.yml");
  const featureDevPath = path.join(repoRoot, "workflows", "feature-dev-github-pr", "workflow.yml");

  function extractPrStepExpects(yamlPath: string): string | null {
    const content = fs.readFileSync(yamlPath, "utf-8");
    const spec = parseYaml(content);
    const prStep = spec.steps?.find((s: any) => s.id === "pr");
    return prStep?.expects ?? null;
  }

  it("bug-fix-github-pr pr step expects rejects pull/new/<branch> URL", () => {
    const expects = extractPrStepExpects(bugFixPath);
    assert.ok(expects, "pr step must have an expects field");

    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/bugfix-branch";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null, "pull/new/<branch> URL should be rejected: " + expects);
  });

  it("bug-fix-github-pr pr step expects accepts valid pull/NNN URL", () => {
    const expects = extractPrStepExpects(bugFixPath);
    assert.ok(expects, "pr step must have an expects field");

    const validOutput = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/42";
    const result = validateExpects(validOutput, expects);
    assert.equal(result, null, "Valid pull/NNN URL should be accepted: " + expects);
  });

  it("feature-dev-github-pr pr step expects rejects pull/new/<branch> URL", () => {
    const expects = extractPrStepExpects(featureDevPath);
    assert.ok(expects, "pr step must have an expects field");

    const fakeOutput = "STATUS: done\nPR: https://github.com/org/repo/pull/new/feature-x";
    const result = validateExpects(fakeOutput, expects);
    assert.ok(result !== null, "pull/new/<branch> URL should be rejected: " + expects);
  });

  it("feature-dev-github-pr pr step expects accepts valid pull/NNN URL", () => {
    const expects = extractPrStepExpects(featureDevPath);
    assert.ok(expects, "pr step must have an expects field");

    const validOutput = "STATUS: done\nPR: https://github.com/igorhvr/tamandua/pull/42";
    const result = validateExpects(validOutput, expects);
    assert.equal(result, null, "Valid pull/NNN URL should be accepted: " + expects);
  });
});

describe("Reserved context key protection", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-reserved-keys-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("completeStep does not overwrite reserved keys (repo, working_directory_for_harness, task, run_id)", async () => {
    // Import getDb lazily so TAMANDUA_DB_PATH is already set
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    // Seed run with repo = /tmp/harness-a
    const seededContext = JSON.stringify({
      task: "fix bug",
      repo: "/tmp/harness-a",
      working_directory_for_harness: "/tmp/harness-a",
      run_id: runId,
    });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    // Planner step output includes REPO: /tmp/harness-b (exploit attempt)
    const maliciousOutput = "STATUS: done\nREPO: /tmp/harness-b\nWORKING_DIRECTORY_FOR_HARNESS: /tmp/harness-b\nTASK: evil task\nRUN_ID: fake-run-id\nBRANCH: bugfix/x";

    completeStep(stepId, maliciousOutput);

    // Verify run context was NOT overwritten for reserved keys
    const run = db.prepare("SELECT context FROM runs WHERE id = ?").get(runId) as { context: string };
    const context = JSON.parse(run.context);

    assert.equal(context.repo, "/tmp/harness-a", "repo must not be overwritten by step output");
    assert.equal(context.working_directory_for_harness, "/tmp/harness-a", "working_directory_for_harness must not be overwritten");
    assert.equal(context.task, "fix bug", "task must not be overwritten by step output");
    assert.equal(context.run_id, runId, "run_id must not be overwritten by step output");

    // Non-reserved keys like BRANCH should still be merged
    assert.equal(context.branch, "bugfix/x", "non-reserved keys like branch should still be merged");
  });

  it("resolveStepContext does not overwrite reserved keys from previous step outputs", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    // Seed run with repo = /tmp/harness-a
    const seededContext = JSON.stringify({
      task: "fix bug",
      repo: "/tmp/harness-a",
      working_directory_for_harness: "/tmp/harness-a",
      run_id: runId,
    });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Planner step (index 0) — done, with malicious REPO output
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', '', 'done', ?, 0, 4, 'single', ?, ?)"
    ).run(planStepId, runId, "STATUS: done\nREPO: /tmp/harness-b\nWORKING_DIRECTORY_FOR_HARNESS: /tmp/harness-b\nBRANCH: bugfix/x", now, now);

    // Fixer step (index 1) — being claimed
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'test-wf_fixer', 1, 'Fix {{repo}} on {{branch}}', '', 'pending', 0, 4, 'single', ?, ?)"
    ).run(fixStepId, runId, now, now);

    // Resolve context for the fixer step (step index 1)
    const context = resolveStepContext(runId, 1);

    // Reserved keys must NOT be overwritten by previous step outputs
    assert.equal(context.repo, "/tmp/harness-a", "resolveStepContext: repo must not be overwritten by previous step output");
    assert.equal(context.working_directory_for_harness, "/tmp/harness-a", "resolveStepContext: working_directory_for_harness must not be overwritten");
    assert.equal(context.task, "fix bug", "resolveStepContext: task must not be overwritten");
    assert.equal(context.run_id, runId, "resolveStepContext: run_id must not be overwritten");

    // Non-reserved keys should still flow through from previous steps
    assert.equal(context.branch, "bugfix/x", "resolveStepContext: non-reserved keys like branch should come through");
  });
});

describe("completeStep STORIES_JSON guard — only blocks when loop-step is immediately next", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-stories-guard-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("allows scan step to complete without STORIES_JSON when a later intermediate step produces stories (security-audit shape)", async () => {
    // Simulate: scan(idx 0, single) -> prioritize(idx 1, single) -> setup(idx 2, single) -> fix(idx 3, loop over stories)
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const scanStepId = crypto.randomUUID();
    const prioritizeStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "audit security" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'security-audit', 'audit security', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // scan step (index 0, single) — the step we are completing
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'sec-audit_scanner', 0, 'Scan codebase', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(scanStepId, runId, now, now);

    // prioritize step (index 1, single)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'prioritize', 'sec-audit_prioritizer', 1, 'Prioritize', '', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(prioritizeStepId, runId, now, now);

    // setup step (index 2, single)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'sec-audit_setup', 2, 'Setup', '', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    // fix step (index 3, loop over stories)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'sec-audit_fixer', 3, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete scan with STATUS: done and no STORIES_JSON — should succeed (not retry)
    const result = completeStep(scanStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: sec-audit-2025-01-01\nVULNERABILITY_COUNT: 11\nFINDINGS: detailed findings here");

    assert.notEqual(result.status, "retrying", "scan should not be retried when loop step is not immediately next");
    assert.notEqual(result.status, "failed", "scan should not be failed when loop step is not immediately next");

    // scan should be marked done
    const scanStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(scanStepId) as { status: string };
    assert.equal(scanStep.status, "done", "scan should be marked done");

    // prioritize should be advanced to pending
    const prioritizeStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(prioritizeStepId) as { status: string };
    assert.equal(prioritizeStep.status, "pending", "prioritize should be advanced to pending");
  });

  it("retries planner step without STORIES_JSON when loop-step is immediately next", async () => {
    // Simulate: plan(idx 0, single) -> fix(idx 1, loop over stories)
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — the step we are completing
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // fix step (index 1, loop over stories) — immediately next
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan with STATUS: done but no STORIES_JSON — should be retried because fix(loop) is immediately next
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x\nCHANGES: analyzed");

    assert.equal(result.status, "retrying", "plan should be retried when immediately-following step is loop-over-stories and no stories exist");

    // plan should be back to pending (not done, not failed)
    const planStep = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number };
    assert.equal(planStep.status, "pending", "plan should be reset to pending for retry");
    assert.equal(planStep.retry_count, 1, "retry_count should be incremented to 1");

    // fix should still be waiting (not advanced)
    const fixStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(fixStepId) as { status: string };
    assert.equal(fixStep.status, "waiting", "fix step should still be waiting");
  });

  it("fails planner step when max_retries exhausted for missing STORIES_JSON", async () => {
    // Simulate: plan(idx 0, single) -> fix(idx 1, loop over stories)
    // plan already at max_retries-1, one more failure should exhaust
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — already at retry_count=2, max_retries=2
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 2, 2, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // fix step (index 1, loop over stories) — immediately next
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan without STORIES_JSON — should fail because retries exhausted
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x");

    assert.equal(result.status, "failed", "plan should fail when retries exhausted for missing STORIES_JSON");

    // plan should be marked failed
    const planStep = db.prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number };
    assert.equal(planStep.status, "failed", "plan should be failed");
    assert.equal(planStep.retry_count, 3, "retry_count should be incremented to 3");

    // run should also be failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be failed");
  });
});

describe("completeStep STORIES_JSON guard — story-producer blamed across intermediate steps", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-stories-guard-intermediate-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("blames planner (not setup) when planner omits STORIES_JSON and there is an intermediate step before the loop", async () => {
    // Simulates e49c370d failure mode: plan(idx 0) -> setup(idx 1) -> implement(idx 2, loop-over-stories)
    // Planner is the story producer (input mentions STORIES_JSON).
    // When planner completes without STORIES_JSON, the guard should blame planner,
    // NOT setup — even though setup sits between planner and the loop step.
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const implementStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0, single) — input_template mentions STORIES_JSON
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'fdm_planner', 0, 'Plan {{task}}\
Reply with:\
STORIES_JSON: [...]', 'STATUS: done', 'running', 0, 4, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // setup step (index 1, single) — input_template does NOT mention STORIES_JSON
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 1, 'Setup {{task}}\
RETRY FEEDBACK: {{retry_feedback}}\
Instructions:', 'STATUS: done', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    // implement step (index 2, loop over stories) — two steps away from planner
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 2, 'Implement story', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(implementStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan with STATUS: done but NO STORIES_JSON
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: feature/x\nCHANGES: planned");

    // Planner should be blamed (retried) — NOT setup
    assert.equal(result.status, "retrying", "planner should be retried when it omits STORIES_JSON, even with intermediate setup step");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STORIES_JSON"), `detail should mention STORIES_JSON, got: ${result.detail}`);

    // Planner should be reset to pending
    const planStep = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(planStepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(planStep.status, "pending", "planner should be reset to pending for retry");
    assert.equal(planStep.retry_count, 1, "planner retry_count should be incremented");
    assert.ok(planStep.output?.includes("STORIES_JSON"), "planner output should contain retry feedback about STORIES_JSON");

    // Setup should remain waiting — NOT reset to pending
    const setupStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(setupStepId) as { status: string };
    assert.equal(setupStep.status, "waiting", "setup should remain waiting (not blamed)");

    // Implement should also stay waiting
    const implementStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(implementStepId) as { status: string };
    assert.equal(implementStep.status, "waiting", "implement should remain waiting");
  });

  it("does not blame planner across intermediate steps when stories already exist", async () => {
    // After planner produces STORIES_JSON, completing planner should succeed
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const implementStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // plan step (index 0) — already retried once
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'fdm_planner', 0, 'Plan {{task}}\
Reply with:\
STORIES_JSON: [...]', 'STATUS: done', 'running', 1, 4, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 1, 'Setup', 'STATUS: done', 'waiting', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'implement', 'fdm_developer', 2, 'Implement', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(implementStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // This time the planner output INCLUDES valid STORIES_JSON
    const outputWithStories = 'STATUS: done\nREPO: /tmp/repo\nBRANCH: feature/x\nSTORIES_JSON: [{"id":"US-001","title":"Add feature","description":"Add the feature","acceptanceCriteria":["Feature works","Typecheck passes"]}]';
    const result = completeStep(planStepId, outputWithStories);

    // Should succeed (not retry) — stories now exist
    assert.notEqual(result.status, "retrying", "planner should succeed when STORIES_JSON is present");
    assert.notEqual(result.status, "failed", "planner should not fail");

    // Planner should be marked done
    const planStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(planStepId) as { status: string };
    assert.equal(planStep.status, "done", "planner should be done");

    // Setup should be advanced to pending
    const setupStep = db.prepare("SELECT status FROM steps WHERE id = ?").get(setupStepId) as { status: string };
    assert.equal(setupStep.status, "pending", "setup should advance to pending");
  });
});

describe("failStep retry feedback persistence", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-failstep-retry-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("failStep non-final retry writes error to steps.output", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Single step with retry_count=0, max_retries=3, currently running
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const errorMsg = "Build failed: type errors in src/foo.ts";

    const result = await failStep(stepId, errorMsg);

    assert.equal(result.status, "retrying", "should return retrying status");

    // Verify step.output now contains the error message
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "pending", "step should be reset to pending");
    assert.equal(step.retry_count, 1, "retry_count should be incremented to 1");
    assert.equal(step.output, errorMsg, "step.output should contain the error message");

    // Verify run is still running (not failed)
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "running", "run should still be running after non-final retry");
  });

  it("failStep final retry (exhausted) writes error to output and marks step failed", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Single step already at retry_count=2 with max_retries=2 — next failure exhausts
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}', '', 'running', 2, 2, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const errorMsg = "Persistent build failure: cannot resolve imports";

    const result = await failStep(stepId, errorMsg);

    assert.equal(result.status, "failed", "should return failed status when retries exhausted");

    // Verify step is failed with error in output
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(stepId) as { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "failed", "step should be marked failed");
    assert.equal(step.retry_count, 3, "retry_count should be incremented to 3");
    assert.equal(step.output, errorMsg, "step.output should contain the error message even on final failure");

    // Verify run is failed
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string };
    assert.equal(run.status, "failed", "run should be marked failed when retries exhausted");
  });

  it("claimStep surfaces retry_feedback from persisted output when retry_count > 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 3, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step that has been retried once, with output containing prior failure reason
    const priorError = "Timeout: step took too long to complete";
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, output, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}\\n\\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 1, 3, ?, 'single', ?, ?)"
    ).run(stepId, runId, priorError, now, now);

    const result = claimStep("bf_fixer", runId);

    assert.ok(result.found, "claimStep should find the pending retry step");
    assert.equal(result!.stepId, stepId, "should claim the fix step by its row id");

    // The resolved input should contain the retry_feedback
    assert.ok(result!.resolvedInput!.includes(priorError), `resolved input should contain the retry_feedback text "${priorError}", got: ${result!.resolvedInput}`);
    assert.ok(result!.resolvedInput!.includes("RETRY FEEDBACK:"), "resolved input should contain the RETRY FEEDBACK section label");
  });

  it("claimStep sets retry_feedback to empty string when retry_count is 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 4, 'bug-fix', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // First attempt step (retry_count=0), output is null
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'fix', 'bf_fixer', 0, 'Fix {{task}}\\n\\nRETRY FEEDBACK: {{retry_feedback}}', '', 'pending', 0, 3, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = claimStep("bf_fixer", runId);

    assert.ok(result.found, "claimStep should find the first-attempt step");
    assert.equal(result!.stepId, stepId, "should claim the fix step by its row id");

    // The resolved input should have retry_feedback as empty (not "[missing: retry_feedback]")
    assert.ok(!result!.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should not be missing-key");
    assert.ok(!result!.resolvedInput!.includes("Timeout"), "retry_feedback should be empty on first attempt");
  });
});

describe("setup-specific retry_feedback rendering", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-setup-retry-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("claimStep resolves setup input with retry_feedback when retry_count > 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X", repo: "/tmp/repo", branch: "feature/x" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Setup step that has been retried once, with output containing prior failure reason
    const priorError = "Setup rejected: STORIES_JSON guard — planner produced no stories";
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, output, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, 'Prepare env for {{task}}\
\
RETRY FEEDBACK: {{retry_feedback}}\
\
Instructions:', 'STATUS: done', 'pending', 1, 4, ?, 'single', ?, ?)"
    ).run(setupStepId, runId, priorError, now, now);

    const result = claimStep("fdm_setup", runId);

    assert.ok(result.found, "claimStep should find the pending retry setup step");
    assert.equal(result!.stepId, setupStepId, "should claim the setup step by its row id");

    // The resolved input should contain the retry_feedback text
    assert.ok(result!.resolvedInput!.includes(priorError), `resolved setup input should contain the retry_feedback text "${priorError}", got: ${result!.resolvedInput}`);
    assert.ok(result!.resolvedInput!.includes("RETRY FEEDBACK:"), "resolved setup input should contain the RETRY FEEDBACK section label");
  });

  it("claimStep resolves setup input with empty retry_feedback when retry_count is 0", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const setupStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "implement feature X", repo: "/tmp/repo", branch: "feature/x" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'feature-dev-merge', 'implement feature X', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // First-attempt setup step (retry_count=0, output is null)
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'setup', 'fdm_setup', 0, 'Prepare env for {{task}}\
\
RETRY FEEDBACK: {{retry_feedback}}\
\
Instructions:', 'STATUS: done', 'pending', 0, 4, 'single', ?, ?)"
    ).run(setupStepId, runId, now, now);

    const result = claimStep("fdm_setup", runId);

    assert.ok(result.found, "claimStep should find the first-attempt setup step");
    assert.equal(result!.stepId, setupStepId, "should claim the setup step by its row id");

    // The resolved input should have retry_feedback as empty (not "[missing: retry_feedback]")
    assert.ok(!result!.resolvedInput!.includes("[missing: retry_feedback]"), "retry_feedback should not be missing-key on first attempt");
    assert.ok(!result!.resolvedInput!.includes("STORIES_JSON guard"), "retry_feedback should be empty on first attempt");
  });
});

describe("completeStep retry response includes detail field", () => {
  const _savedStateDir = process.env.TAMANDUA_STATE_DIR;
  const _savedDbPath = process.env.TAMANDUA_DB_PATH;
  let _testIsolationDir: string;

  before(() => {
    _testIsolationDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-completestep-detail-test-"));
    process.env.TAMANDUA_STATE_DIR = _testIsolationDir;
    process.env.TAMANDUA_DB_PATH = path.join(_testIsolationDir, "tamandua.db");
  });

  after(() => {
    if (_savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = _savedStateDir;
    if (_savedDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = _savedDbPath;
    try { fs.rmSync(_testIsolationDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function ts(): string {
    return new Date().toISOString();
  }

  it("expects validation retry response includes detail with the validation error", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug", repo: "/tmp/repo", branch: "fix/example" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Step with expects='STATUS: done' — output will fail validation
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'test-wf_planner', 0, '{{task}}', 'STATUS: done', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = completeStep(stepId, "missing status line");

    assert.equal(result.status, "retrying", "should retry when expects validation fails");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STATUS: done"), `detail should mention the missing expects key, got: ${result.detail}`);

    // Verify the detail was also written to step.output
    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(stepId) as { output: string };
    assert.equal(step.output, result.detail, "step.output should match the detail field");
  });

  it("STORIES_JSON guard retry response includes detail with the guard reason", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const planStepId = crypto.randomUUID();
    const fixStepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 1, 'bug-fix-merge', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Plan step (index 0, single) — the step being completed
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'plan', 'bfm_planner', 0, 'Plan fix', '', 'running', 0, 3, 'single', ?, ?)"
    ).run(planStepId, runId, now, now);

    // Fix step (index 1, loop over stories) — immediately next step
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at) VALUES (?, ?, 'fix', 'bfm_fixer', 1, 'Fix', '', 'waiting', 0, 4, 'loop', ?, ?, ?)"
    ).run(fixStepId, runId, JSON.stringify({ over: "stories" }), now, now);

    // Complete plan without STORIES_JSON — should trigger guard retry
    const result = completeStep(planStepId, "STATUS: done\nREPO: /tmp/repo\nBRANCH: bugfix/x\nCHANGES: analyzed");

    assert.equal(result.status, "retrying", "should retry when STORIES_JSON guard fires");
    assert.ok(result.detail, "retry response should include detail field");
    assert.ok(result.detail!.includes("STORIES_JSON"), `detail should mention STORIES_JSON, got: ${result.detail}`);
    assert.ok(result.detail!.includes("fix"), `detail should mention the downstream step id, got: ${result.detail}`);

    // Verify the detail was also written to step.output
    const planStep = db.prepare("SELECT output FROM steps WHERE id = ?").get(planStepId) as { output: string };
    assert.equal(planStep.output, result.detail, "step.output should match the detail field");
  });

  it("success path does not include detail field", async () => {
    const { getDb } = await import("../dist/db.js");
    const db = getDb();
    const runId = crypto.randomUUID();
    const stepId = crypto.randomUUID();
    const now = ts();

    const seededContext = JSON.stringify({ task: "fix bug" });

    db.prepare(
      "INSERT INTO runs (id, run_number, workflow_id, task, status, context, tokens_spent, created_at, updated_at) VALUES (?, 2, 'test-wf', 'fix bug', 'running', ?, 0, ?, ?)"
    ).run(runId, seededContext, now, now);

    // Simple single step with no next loop step — success path
    db.prepare(
      "INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at) VALUES (?, ?, 'scan', 'test-wf_scanner', 0, 'Scan codebase', '', 'running', 0, 4, 'single', ?, ?)"
    ).run(stepId, runId, now, now);

    const result = completeStep(stepId, "STATUS: done\nREPO: /tmp/repo\nCHANGES: scanned");

    assert.notEqual(result.status, "retrying", "success path should not retry");
    assert.notEqual(result.status, "failed", "success path should not fail");
    assert.equal(result.detail, undefined, "success path should not include detail field");
  });
});
