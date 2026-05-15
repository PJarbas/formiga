import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { _parseWorkflowRunArgs } from "../../dist/cli/cli.js";

describe("_parseWorkflowRunArgs", () => {
  it("parses task title from positional args (no flags)", () => {
    const result = _parseWorkflowRunArgs(["Implement", "a thing"]);
    assert.deepEqual(result, {
      taskTitle: "Implement a thing",
      workingDirectoryForHarness: undefined,
      worktreeOriginRepository: undefined,
      worktreeOriginRef: undefined,
      noHurrySaveTokensMode: undefined,
    });
  });

  it("parses --no-hurry-please-save-tokens-mode as a boolean flag", () => {
    const result = _parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "do something",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --no-hurry-please-save-tokens-mode alongside other flags", () => {
    const result = _parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--working-directory-for-harness",
      "/some/dir",
      "build the frontend",
    ]);
    assert.equal(result.taskTitle, "build the frontend");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.workingDirectoryForHarness, "/some/dir");
  });

  it("flag not set when absent", () => {
    const result = _parseWorkflowRunArgs([
      "--working-directory-for-harness",
      "/tmp",
      "task here",
    ]);
    assert.equal(result.noHurrySaveTokensMode, undefined);
    assert.equal(result.workingDirectoryForHarness, "/tmp");
    assert.equal(result.taskTitle, "task here");
  });

  it("parses all flags together with save-tokens-mode", () => {
    const result = _parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository",
      "/repo",
      "--worktree-origin-ref",
      "main",
      "--working-directory-for-harness",
      "/work",
      "do the task",
    ]);
    assert.equal(result.taskTitle, "do the task");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.worktreeOriginRepository, "/repo");
    assert.equal(result.worktreeOriginRef, "main");
    assert.equal(result.workingDirectoryForHarness, "/work");
  });

  it("save-tokens-mode at end of args", () => {
    const result = _parseWorkflowRunArgs([
      "do something",
      "--no-hurry-please-save-tokens-mode",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });
});
