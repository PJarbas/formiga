import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowRunArgs } from "../../dist/cli/workflow-run-args.js";

describe("parseWorkflowRunArgs", () => {
  it("parses task title from positional args (no flags)", () => {
    const result = parseWorkflowRunArgs(["Implement", "a thing"]);
    assert.deepEqual(result, {
      taskTitle: "Implement a thing",
      workingDirectoryForHarness: undefined,
      worktreeOriginRepository: undefined,
      worktreeOriginRef: undefined,
      noHurrySaveTokensMode: undefined,
    });
  });

  it("parses --no-hurry-please-save-tokens-mode as a boolean flag", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "do something",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });

  it("parses --no-hurry-please-save-tokens-mode alongside other flags", () => {
    const result = parseWorkflowRunArgs([
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
    const result = parseWorkflowRunArgs([
      "--working-directory-for-harness",
      "/tmp",
      "task here",
    ]);
    assert.equal(result.noHurrySaveTokensMode, undefined);
    assert.equal(result.workingDirectoryForHarness, "/tmp");
    assert.equal(result.taskTitle, "task here");
  });

  it("parses all flags together with save-tokens-mode", () => {
    const result = parseWorkflowRunArgs([
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
    const result = parseWorkflowRunArgs([
      "do something",
      "--no-hurry-please-save-tokens-mode",
    ]);
    assert.equal(result.taskTitle, "do something");
    assert.equal(result.noHurrySaveTokensMode, true);
  });
});

describe("CLI entrypoint", () => {
  it("runs when invoked through a symlink", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-cli-test-"));
    const stateDir = path.join(tmpDir, "state");
    const homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(homeDir);

    try {
      const cliPath = path.resolve("dist/cli/cli.js");
      const symlinkPath = path.join(tmpDir, "tamandua");
      fs.symlinkSync(cliPath, symlinkPath);

      const output = execFileSync(symlinkPath, ["version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: homeDir,
          TAMANDUA_STATE_DIR: stateDir,
        },
      });

      assert.match(output, /^tamandua v/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
