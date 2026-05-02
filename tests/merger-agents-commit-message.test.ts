import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const mergerAgentsPath = resolve(
  repoRoot,
  "workflows",
  "feature-dev-merge",
  "agents",
  "merger",
  "AGENTS.md",
);

const content = readFileSync(mergerAgentsPath, "utf-8");

describe("merger AGENTS.md commit message generation", () => {
  it("contains a Commit Message Generation section", () => {
    assert.match(content, /## Commit Message Generation/);
  });

  it("instructs gathering information from task description", () => {
    assert.match(content, /\{\{task\}\}/);
  });

  it("instructs gathering information from git log of feature branch", () => {
    assert.match(
      content,
      /git log \{\{original_branch\}\}\.\.\{\{branch\}\} --oneline/,
    );
  });

  it("instructs gathering information from progress file", () => {
    assert.match(content, /progress-\{\{run_id\}\}\.txt/);
  });

  it("instructs using conventional commit format for first line", () => {
    assert.match(content, /conventional commit format/);
    assert.match(content, /feat: <summary>/);
  });

  it("requires first line under 72 characters", () => {
    assert.match(content, /Under 72 characters/);
  });

  it("requires first line in imperative mood", () => {
    assert.match(content, /imperative mood/i);
  });

  it("requires a blank line between subject and body", () => {
    assert.match(content, /\*\*Blank line\*\*/);
  });

  it("instructs a detailed body listing individual changes", () => {
    assert.match(content, /Individual changes from the git log/);
  });

  it("instructs writing message to temp file and using git commit -F", () => {
    assert.match(content, /git commit -F/);
    assert.match(content, /\/tmp\/merge-commit-msg\.txt/);
  });

  it("provides an example commit message", () => {
    assert.match(content, /feat: Add user authentication with JWT support/);
    assert.match(content, /Add login\/register endpoints/);
  });

  it("does not contain the old hardcoded commit message", () => {
    assert.doesNotMatch(
      content,
      /git commit -m "feat: merge/,
    );
  });

  it("preserves guardrails section with no force push", () => {
    assert.match(content, /## Guardrails/);
    assert.match(content, /Do not force-push/);
  });

  it("preserves guardrails section with no rewrite history", () => {
    assert.match(content, /Do not rewrite history/);
  });

  it("preserves output format with STATUS/MERGE_COMMIT/MERGED_INTO", () => {
    assert.match(content, /STATUS: done/);
    assert.match(content, /MERGE_COMMIT:/);
    assert.match(content, /MERGED_INTO:/);
  });

  it("instructs NOT to use hardcoded one-line commit message", () => {
    assert.match(content, /Do NOT use a hardcoded one-line commit message/);
  });

  it("describes WHAT and WHY for future maintainers", () => {
    assert.match(content, /WHAT was done and WHY/);
    assert.match(content, /useful for future maintainers/);
  });
});
