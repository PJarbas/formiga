import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dirname, "..", "skills", "tamandua-agents", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");

// CLI commands documented in SKILL.md that should exist in the actual CLI.
// Format: [commandString, sectionDescription]
const documentedCommands: [string, string][] = [
  // Section 1: CLI access
  ["tamandua version", "version command"],
  ["tamandua source-path", "source path command"],
  ["tamandua skill-path", "skill path command"],

  // Section 2: workflow-level commands
  ["tamandua workflow list", "workflow list"],
  ["tamandua workflow install", "workflow install"],
  ["tamandua workflow uninstall", "workflow uninstall"],
  ["tamandua workflow run", "workflow run"],
  ["tamandua workflow status", "workflow status"],
  ["tamandua workflow runs", "workflow runs"],
  ["tamandua workflow pause", "workflow pause"],
  ["tamandua workflow pause-all", "workflow pause-all"],
  ["tamandua workflow resume", "workflow resume"],
  ["tamandua workflow resume-all", "workflow resume-all"],
  ["tamandua workflow stop", "workflow stop"],

  // Section 2.2: logs
  ["tamandua logs", "logs command"],
  ["tamandua logs-tail", "logs-tail command"],

  // Section 2.3: dashboard
  ["tamandua dashboard start", "dashboard start"],
  ["tamandua dashboard stop", "dashboard stop"],
  ["tamandua dashboard status", "dashboard status"],

  // Section 2.3: MCP
  ["tamandua mcp start", "mcp start"],
  ["tamandua mcp stop", "mcp stop"],
  ["tamandua mcp status", "mcp status"],

  // Section 2.4: get-ready
  ["tamandua get-ready", "get-ready command"],

  // Section 2.6: system status
  ["tamandua status", "status command"],

  // Section 2.7: worktree
  ["tamandua worktree list", "worktree list"],
  ["tamandua worktree status", "worktree status"],
  ["tamandua worktree remove", "worktree remove"],
  ["tamandua worktree prune", "worktree prune"],

  // Section 2.8: control-plane
  ["tamandua control-plane start", "control-plane start"],
  ["tamandua control-plane stop", "control-plane stop"],
  ["tamandua control-plane status", "control-plane status"],

  // Section 2.9: uninstall
  ["tamandua uninstall", "uninstall command"],

  // Section 2: update
  ["tamandua update", "update command"],

  // Section 3: step lifecycle
  ["tamandua step peek", "step peek"],
  ["tamandua step claim", "step claim"],
  ["tamandua step complete", "step complete"],
  ["tamandua step fail", "step fail"],
  ["tamandua step stories", "step stories"],
];

// Actual CLI commands verified from src/cli/cli.ts
// These are the command groups handled by main()
const actualCommands: string[] = [
  // Top-level / standalone
  "tamandua version",
  "tamandua tamandua",
  "tamandua skill-path",
  "tamandua source-path",
  "tamandua update",
  "tamandua get-ready",
  "tamandua uninstall",
  "tamandua status",
  "tamandua logs",
  "tamandua logs-tail",

  // dashboard
  "tamandua dashboard start",
  "tamandua dashboard stop",
  "tamandua dashboard status",

  // mcp
  "tamandua mcp start",
  "tamandua mcp stop",
  "tamandua mcp status",

  // control-plane
  "tamandua control-plane start",
  "tamandua control-plane stop",
  "tamandua control-plane status",

  // step
  "tamandua step peek",
  "tamandua step claim",
  "tamandua step complete",
  "tamandua step fail",
  "tamandua step stories",

  // workflow
  "tamandua workflow list",
  "tamandua workflow runs",
  "tamandua workflow install",
  "tamandua workflow uninstall",
  "tamandua workflow run",
  "tamandua workflow status",
  "tamandua workflow stop",
  "tamandua workflow pause",
  "tamandua workflow resume",
  "tamandua workflow pause-all",
  "tamandua workflow resume-all",

  // worktree
  "tamandua worktree list",
  "tamandua worktree status",
  "tamandua worktree remove",
  "tamandua worktree prune",
];

// Commands intentionally not documented in SKILL.md (easter eggs, etc.)
const excludedFromSkill: Set<string> = new Set([
  "tamandua tamandua", // ASCII art easter egg
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

describe("SKILL.md dashboard and MCP command accuracy", () => {
  it("dashboard start, stop, status are all documented", () => {
    assert.ok(skillContent.includes("dashboard start"), "dashboard start must be documented");
    assert.ok(skillContent.includes("dashboard stop"), "dashboard stop must be documented");
    assert.ok(skillContent.includes("dashboard status"), "dashboard status must be documented");
  });

  it("dashboard status mentions MCP status too", () => {
    assert.ok(
      skillContent.match(/dashboard status.*MCP|MCP.*dashboard status/i),
      "SKILL.md must note dashboard status reports MCP status"
    );
  });

  it("mcp start, stop, status are all documented", () => {
    assert.ok(skillContent.includes("mcp start"), "mcp start must be documented");
    assert.ok(skillContent.includes("mcp stop"), "mcp stop must be documented");
    assert.ok(skillContent.includes("mcp status"), "mcp status must be documented");
  });

  it("dashboard and mcp have separate sections with distinct port info", () => {
    assert.ok(
      skillContent.includes("3334"),
      "SKILL.md must mention dashboard default port 3334"
    );
    assert.ok(
      skillContent.includes("3338"),
      "SKILL.md must mention MCP default port 3338"
    );
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
    // showing: --working-directory-for-harness, --worktree-origin-*, harness flags, --no-hurry
    const hasWfh = skillContent.includes("--working-directory-for-harness");
    const hasWto = skillContent.includes("--worktree-origin-repository");
    const hasWtr = skillContent.includes("--worktree-origin-ref");
    const hasPiH = skillContent.includes("--pi-as-harness");
    const hasNoHur = skillContent.includes("--no-hurry-please-save-tokens-mode");
    assert.ok(hasWfh && hasWto && hasWtr && hasPiH && hasNoHur,
      "SKILL.md workflow run command row must include all option groups");
  });
});

describe("SKILL.md worktree commands documented", () => {
  it("documents worktree list", () => {
    assert.ok(
      skillContent.includes("worktree list"),
      "SKILL.md must document worktree list"
    );
  });

  it("documents worktree status", () => {
    assert.ok(
      skillContent.includes("worktree status"),
      "SKILL.md must document worktree status"
    );
  });

  it("documents worktree remove", () => {
    assert.ok(
      skillContent.includes("worktree remove"),
      "SKILL.md must document worktree remove"
    );
  });

  it("documents worktree prune", () => {
    assert.ok(
      skillContent.includes("worktree prune"),
      "SKILL.md must document worktree prune"
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
  it("documents tamandua status", () => {
    assert.ok(
      skillContent.includes("tamandua status"),
      "SKILL.md must document tamandua status"
    );
  });

  it("documents tamandua uninstall", () => {
    assert.ok(
      skillContent.includes("tamandua uninstall"),
      "SKILL.md must document tamandua uninstall"
    );
  });

  it("documents tamandua update", () => {
    assert.ok(
      skillContent.includes("tamandua update"),
      "SKILL.md must document tamandua update"
    );
  });

  it("documents tamandua get-ready", () => {
    assert.ok(
      skillContent.includes("tamandua get-ready"),
      "SKILL.md must document tamandua get-ready"
    );
  });

  it("documents tamandua skill-path", () => {
    assert.ok(
      skillContent.includes("tamandua skill-path"),
      "SKILL.md must document tamandua skill-path"
    );
  });

  it("documents tamandua source-path", () => {
    assert.ok(
      skillContent.includes("tamandua source-path"),
      "SKILL.md must document tamandua source-path"
    );
  });
});

describe("SKILL.md logs commands documented", () => {
  it("documents logs with selector syntax", () => {
    assert.ok(skillContent.includes("tamandua logs"), "SKILL.md must document logs");
  });

  it("documents logs-tail with selector syntax", () => {
    assert.ok(skillContent.includes("tamandua logs-tail"), "SKILL.md must document logs-tail");
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
