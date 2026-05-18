import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

describe("e2e test infrastructure", () => {
  it("e2e-tests/ directory exists", () => {
    assert.ok(fs.statSync(path.join(repoRoot, "e2e-tests")).isDirectory());
  });

  it("run-all-e2e-tests script exists and is executable", () => {
    const scriptPath = path.join(repoRoot, "run-all-e2e-tests");
    assert.ok(fs.existsSync(scriptPath), "run-all-e2e-tests should exist");
    fs.accessSync(scriptPath, fs.constants.X_OK); // throws if not executable
  });

  it("run-all-tests documents e2e test separation", () => {
    const content = fs.readFileSync(path.join(repoRoot, "run-all-tests"), "utf-8");
    assert.ok(
      content.includes("End-to-end tests live under e2e-tests/") &&
        content.includes("NOT included"),
      "run-all-tests should note e2e tests are separate",
    );
  });

  it("npm test does not pick up files from e2e-tests/", () => {
    // npm test runs `node --test tests/*.test.ts src/**/*.test.ts`
    // Verify that e2e-tests/ files are not part of the glob
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf-8"),
    );
    const testCmd: string = pkg.scripts.test;
    assert.ok(
      !testCmd.includes("e2e-tests"),
      `npm test command should not include e2e-tests/, got: ${testCmd}`,
    );

    // Also verify the command limits itself to tests/ and src/
    assert.ok(
      testCmd.includes("tests/*.test.ts"),
      "npm test should include tests/*.test.ts",
    );
    assert.ok(
      testCmd.includes("src/**/*.test.ts"),
      "npm test should include src/**/*.test.ts",
    );
  });

  it("e2e-tests/ is not compiled by tsconfig.json", () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "tsconfig.json"), "utf-8"),
    );
    // rootDir is "src", include is ["src/**/*.ts"] — e2e-tests/ should not be referenced
    assert.ok(
      !tsconfig.include?.some((p: string) => p.includes("e2e")),
      "tsconfig include should not reference e2e-tests/",
    );
    assert.equal(tsconfig.compilerOptions?.rootDir, "src");
  });

  it("AGENTS.md documents e2e test separation and agent guidance", () => {
    const agentsMd = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf-8");
    // Should have an E2E test section
    assert.ok(
      agentsMd.includes("End-to-End Tests") ||
        agentsMd.includes("end-to-end tests") ||
        agentsMd.includes("e2e"),
      "AGENTS.md should mention e2e tests",
    );
    // Should tell agents not to run e2e tests by default
    assert.ok(
      agentsMd.includes("NOT run e2e tests") ||
        agentsMd.includes("not run e2e tests") ||
        agentsMd.includes("not run end-to-end"),
      "AGENTS.md should instruct agents not to run e2e tests by default",
    );
  });

  it("run-all-e2e-tests contains the correct test glob", () => {
    const content = fs.readFileSync(
      path.join(repoRoot, "run-all-e2e-tests"),
      "utf-8",
    );
    assert.ok(
      content.includes("e2e-tests/*.test.ts"),
      "run-all-e2e-tests should glob e2e-tests/*.test.ts",
    );
  });
});
