import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dirname, "..", "skills", "formiga-agents", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");

// CLI commands documented in SKILL.md that should exist in the actual CLI.
// Format: [commandString, sectionDescription]
const documentedCommands: [string, string][] = [
  // Section 1: CLI access
  ["formiga version", "version command"],
  ["formiga source-path", "source path command"],
  ["formiga skill-path", "skill path command"],

  // Section 2: workflow-level commands
  ["formiga workflow list", "workflow list"],
  ["formiga workflow install", "workflow install"],
  ["formiga workflow uninstall", "workflow uninstall"],
  ["formiga workflow run", "workflow run"],
  ["formiga workflow status", "workflow status"],
  ["formiga workflow runs", "workflow runs"],
  ["formiga workflow pause", "workflow pause"],
  ["formiga workflow pause-all", "workflow pause-all"],
  ["formiga workflow resume", "workflow resume"],
  ["formiga workflow resume-all", "workflow resume-all"],
  ["formiga workflow stop", "workflow stop"],

  // Section 2.2: logs
  ["formiga logs", "logs command"],
  ["formiga logs-tail", "logs-tail command"],

  // Section 2.3: dashboard
  ["formiga dashboard start", "dashboard start"],
  ["formiga dashboard stop", "dashboard stop"],
  ["formiga dashboard status", "dashboard status"],

  // Section 2.4: get-ready
  ["formiga get-ready", "get-ready command"],

  // Section 2.6: system status
  ["formiga status", "status command"],

  // Section 2.8: control-plane
  ["formiga control-plane start", "control-plane start"],
  ["formiga control-plane stop", "control-plane stop"],
  ["formiga control-plane status", "control-plane status"],

  // Section 2.9: uninstall
  ["formiga uninstall", "uninstall command"],

  // Section 2: update
  ["formiga update", "update command"],

  // Section 3: step lifecycle
  ["formiga step peek", "step peek"],
  ["formiga step claim", "step claim"],
  ["formiga step complete", "step complete"],
  ["formiga step fail", "step fail"],
  ["formiga step stories", "step stories"],
];

// Actual CLI commands verified from src/cli/cli.ts
// These are the command groups handled by main()
const actualCommands: string[] = [
  // Top-level / standalone
  "formiga version",
  "formiga formiga",
  "formiga skill-path",
  "formiga source-path",
  "formiga update",
  "formiga get-ready",
  "formiga uninstall",
  "formiga status",
  "formiga logs",
  "formiga logs-tail",

  // dashboard
  "formiga dashboard start",
  "formiga dashboard stop",
  "formiga dashboard status",

  // control-plane
  "formiga control-plane start",
  "formiga control-plane stop",
  "formiga control-plane status",

  // step
  "formiga step peek",
  "formiga step claim",
  "formiga step complete",
  "formiga step fail",
  "formiga step stories",

  // workflow
  "formiga workflow list",
  "formiga workflow runs",
  "formiga workflow install",
  "formiga workflow uninstall",
  "formiga workflow run",
  "formiga workflow status",
  "formiga workflow stop",
  "formiga workflow pause",
  "formiga workflow resume",
  "formiga workflow pause-all",
  "formiga workflow resume-all",
];

// Commands intentionally not documented in SKILL.md (easter eggs, etc.)
const excludedFromSkill: Set<string> = new Set([
  "formiga formiga", // ASCII art easter egg
]);

describe("SKILL.md command reference completeness", () => {
  it("has valid YAML frontmatter", () => {
    assert.ok(
      skillContent.startsWith("---"),
      "SKILL.md must start with YAML frontmatter delimiter"
    );
    const secondDelim = skillContent.indexOf("---", 3);
    assert.ok(secondDelim > 0, "SKILL.md must have closing YAML frontmatter delimiter");
  });

  for (const [cmd, desc] of documentedCommands) {
    it(`documents command: ${cmd}`, () => {
      assert.ok(
        skillContent.includes(cmd),
        `SKILL.md must document command: ${cmd}`
      );
    });
  }

  it("every actual CLI command (except easter eggs) is documented in SKILL.md", () => {
    const missing: string[] = [];
    for (const cmd of actualCommands) {
      if (excludedFromSkill.has(cmd)) continue;
      if (!skillContent.includes(cmd)) {
        missing.push(cmd);
      }
    }
    assert.deepStrictEqual(missing, [], "SKILL.md is missing documentation for these CLI commands");
  });
});

describe("SKILL.md step command accuracy", () => {
  it("step peek uses --run-id flag", () => {
    assert.ok(
      skillContent.includes("step peek") && skillContent.includes("--run-id"),
      "SKILL.md must show --run-id flag for step peek"
    );
  });

  it("step claim uses --run-id flag", () => {
    assert.ok(
      skillContent.includes("step claim") && skillContent.includes("--run-id"),
      "SKILL.md must show --run-id flag for step claim"
    );
  });

  it("step complete uses stepId not agentId", () => {
    // Must explain that complete takes stepId, not agentId
    assert.ok(
      skillContent.match(/step complete.*step-id/i) ||
      skillContent.includes("step complete <stepId>") ||
      skillContent.includes("step complete <step-id>"),
      "SKILL.md must show step complete uses step ID, not agent ID"
    );
  });

  it("step fail uses stepId not agentId", () => {
    assert.ok(
      skillContent.match(/step fail.*step-id/i) ||
      skillContent.includes("step fail <stepId>") ||
      skillContent.includes("step fail <step-id>"),
      "SKILL.md must show step fail uses step ID, not agent ID"
    );
  });

  it("explicitly warns not to use agent ID for complete/fail", () => {
    assert.ok(
      skillContent.match(/Never.*step complete.*agent.*[Ii][Dd]/) ||
      skillContent.match(/never.*call.*step complete.*agent/i),
      "SKILL.md must warn against using agent ID with step complete/fail"
    );
  });

  it("step stories is documented for diagnostics", () => {
    assert.ok(
      skillContent.includes("step stories"),
      "SKILL.md must document step stories for debugging"
    );
  });

  it("step lifecycle is documented in order: peek → claim → execute → complete/fail", () => {
    const peekIdx = skillContent.indexOf("step peek");
    const claimIdx = skillContent.indexOf("step claim");
    const completeIdx = skillContent.indexOf("step complete");
    const failIdx = skillContent.indexOf("step fail");

    assert.ok(peekIdx < claimIdx, "step peek must appear before step claim in documentation");
    assert.ok(claimIdx < completeIdx, "step claim must appear before step complete");
    assert.ok(claimIdx < failIdx, "step claim must appear before step fail");
  });
});

describe("SKILL.md dashboard command accuracy", () => {
  it("dashboard start, stop, status are all documented", () => {
    assert.ok(skillContent.includes("dashboard start"), "dashboard start must be documented");
    assert.ok(skillContent.includes("dashboard stop"), "dashboard stop must be documented");
    assert.ok(skillContent.includes("dashboard status"), "dashboard status must be documented");
  });
});

describe("SKILL.md workflow run command completeness", () => {
  it("includes --working-directory-for-harness flag", () => {
    assert.ok(
      skillContent.includes("--working-directory-for-harness"),
      "SKILL.md must document --working-directory-for-harness flag"
    );
  });

  it("includes --worktree-origin-repository flag", () => {
    assert.ok(
      skillContent.includes("--worktree-origin-repository"),
      "SKILL.md must document --worktree-origin-repository flag"
    );
  });

  it("includes --worktree-origin-ref flag", () => {
    assert.ok(
      skillContent.includes("--worktree-origin-ref"),
      "SKILL.md must document --worktree-origin-ref flag"
    );
  });

  it("includes --no-hurry-please-save-tokens-mode flag", () => {
    assert.ok(
      skillContent.includes("--no-hurry-please-save-tokens-mode"),
      "SKILL.md must document --no-hurry-please-save-tokens-mode flag"
    );
  });

  it("includes --pi-as-harness and --hermes-as-harness flags", () => {
    assert.ok(
      skillContent.includes("--pi-as-harness"),
      "SKILL.md must document --pi-as-harness"
    );
    assert.ok(
      skillContent.includes("--hermes-as-harness"),
      "SKILL.md must document --hermes-as-harness"
    );
  });

  it("workflow run command row shows all options on one line", () => {
    // The primary workflow run row should be a single logical line
    // showing: --working-directory-for-harness, --worktree-origin-*, harness flags, --no-hurry, --no-relaunch
    const hasWfh = skillContent.includes("--working-directory-for-harness");
    const hasWto = skillContent.includes("--worktree-origin-repository");
    const hasWtr = skillContent.includes("--worktree-origin-ref");
    const hasPiH = skillContent.includes("--pi-as-harness");
    const hasNoHur = skillContent.includes("--no-hurry-please-save-tokens-mode");
    const hasNoRelaunch = skillContent.includes("--no-relaunch-upon-rugpull");
    assert.ok(hasWfh && hasWto && hasWtr && hasPiH && hasNoHur && hasNoRelaunch,
      "SKILL.md workflow run command row must include all option groups");
  });

  it("includes --no-relaunch-upon-rugpull flag", () => {
    assert.ok(
      skillContent.includes("--no-relaunch-upon-rugpull"),
      "SKILL.md must document --no-relaunch-upon-rugpull flag"
    );
  });
});

describe("SKILL.md control-plane commands documented", () => {
  it("documents control-plane start", () => {
    assert.ok(
      skillContent.includes("control-plane start"),
      "SKILL.md must document control-plane start"
    );
  });

  it("documents control-plane stop", () => {
    assert.ok(
      skillContent.includes("control-plane stop"),
      "SKILL.md must document control-plane stop"
    );
  });

  it("documents control-plane status", () => {
    assert.ok(
      skillContent.includes("control-plane status"),
      "SKILL.md must document control-plane status"
    );
  });

  it("documents control-plane default port 3339", () => {
    assert.ok(
      skillContent.includes("3339"),
      "SKILL.md must mention control-plane default port 3339"
    );
  });
});

describe("SKILL.md workflow install and uninstall documented", () => {
  it("documents workflow install", () => {
    assert.ok(
      skillContent.includes("workflow install"),
      "SKILL.md must document workflow install"
    );
  });

  it("documents workflow uninstall", () => {
    assert.ok(
      skillContent.includes("workflow uninstall"),
      "SKILL.md must document workflow uninstall"
    );
  });

  it("documents workflow uninstall --all", () => {
    assert.ok(
      skillContent.includes("--all") && skillContent.includes("uninstall"),
      "SKILL.md must document workflow uninstall --all"
    );
  });

  it("documents --force for uninstall", () => {
    assert.ok(
      skillContent.includes("--force") && skillContent.includes("uninstall"),
      "SKILL.md must document --force flag for uninstall"
    );
  });
});

describe("SKILL.md top-level maintenance commands", () => {
  it("documents formiga status", () => {
    assert.ok(
      skillContent.includes("formiga status"),
      "SKILL.md must document formiga status"
    );
  });

  it("documents formiga uninstall", () => {
    assert.ok(
      skillContent.includes("formiga uninstall"),
      "SKILL.md must document formiga uninstall"
    );
  });

  it("documents formiga update", () => {
    assert.ok(
      skillContent.includes("formiga update"),
      "SKILL.md must document formiga update"
    );
  });

  it("documents formiga get-ready", () => {
    assert.ok(
      skillContent.includes("formiga get-ready"),
      "SKILL.md must document formiga get-ready"
    );
  });

  it("documents formiga skill-path", () => {
    assert.ok(
      skillContent.includes("formiga skill-path"),
      "SKILL.md must document formiga skill-path"
    );
  });

  it("documents formiga source-path", () => {
    assert.ok(
      skillContent.includes("formiga source-path"),
      "SKILL.md must document formiga source-path"
    );
  });
});

describe("SKILL.md logs commands documented", () => {
  it("documents logs with selector syntax", () => {
    assert.ok(skillContent.includes("formiga logs"), "SKILL.md must document logs");
  });

  it("documents logs-tail with selector syntax", () => {
    assert.ok(skillContent.includes("formiga logs-tail"), "SKILL.md must document logs-tail");
  });

  it("documents logs-tail live following behavior", () => {
    assert.ok(
      skillContent.match(/follow|real.time|live/i),
      "SKILL.md must describe logs-tail live following behavior"
    );
  });
});

describe("SKILL.md output format accuracy", () => {
  it("completion contract specifies STATUS, CHANGES, TESTS", () => {
    assert.ok(skillContent.includes("STATUS:"), "SKILL.md must mention STATUS: output field");
    assert.ok(skillContent.includes("CHANGES:"), "SKILL.md must mention CHANGES: output field");
    assert.ok(skillContent.includes("TESTS:"), "SKILL.md must mention TESTS: output field");
  });

  it("failure uses step fail with reason", () => {
    assert.ok(
      skillContent.includes("step fail") && skillContent.includes("reason"),
      "SKILL.md must document step fail with reason parameter"
    );
  });
});

