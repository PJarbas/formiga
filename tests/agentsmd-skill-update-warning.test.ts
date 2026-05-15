import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBundledWorkflowsDir } from "../dist/installer/paths.js";

const repoRoot = resolve(resolveBundledWorkflowsDir(), "..");
const agentsMdPath = resolve(repoRoot, "AGENTS.md");
const agentsMd = readFileSync(agentsMdPath, "utf-8");

// Extract existing section headings
const sectionHeadings = agentsMd.match(/^##\s.+/gm) ?? [];

describe("AGENTS.md skill-update warning (US-001)", () => {
  // AC 1: AGENTS.md contains a section titled "Skills and Agent Instructions"
  it("contains a 'Skills and Agent Instructions' section", () => {
    assert.ok(
      sectionHeadings.some((h) => h === "## Skills and Agent Instructions"),
      "AGENTS.md must contain section '## Skills and Agent Instructions'",
    );
  });

  // AC 2: The section warns about updating skills/tamandua-agents/SKILL.md
  it("warns about updating skills/tamandua-agents/SKILL.md", () => {
    assert.match(
      agentsMd,
      /skills\/tamandua-agents\/SKILL\.md/,
      "AGENTS.md must reference skills/tamandua-agents/SKILL.md",
    );
    assert.match(
      agentsMd,
      /check.*skills\/tamandua-agents\/SKILL\.md.*needs? updating/i,
      "AGENTS.md must warn about checking whether the skill needs updating",
    );
  });

  // AC 3: Explicitly mentions step lifecycle, CLI commands, and agent provisioning
  it("explicitly mentions step lifecycle as a trigger for skill updates", () => {
    assert.match(
      agentsMd,
      /[Ss]tep lifecycle/,
      "AGENTS.md must mention step lifecycle as trigger for skill updates",
    );
  });

  it("explicitly mentions CLI commands as a trigger for skill updates", () => {
    assert.match(
      agentsMd,
      /CLI commands?/,
      "AGENTS.md must mention CLI commands as trigger for skill updates",
    );
  });

  it("explicitly mentions agent provisioning as a trigger for skill updates", () => {
    assert.match(
      agentsMd,
      /[Aa]gent provisioning/,
      "AGENTS.md must mention agent provisioning as trigger for skill updates",
    );
  });

  // AC 4: Existing sections are unchanged
  it("preserves the Development section", () => {
    assert.match(agentsMd, /^## Development$/m);
    assert.match(agentsMd, /Build and Install/);
  });

  it("preserves the Project Structure section", () => {
    assert.match(agentsMd, /^## Project Structure$/m);
    assert.match(agentsMd, /tamandua\//);
  });

  it("preserves the Architecture section", () => {
    assert.match(agentsMd, /^## Architecture$/m);
    assert.match(agentsMd, /Runtime model/);
  });

  it("preserves the State section", () => {
    assert.match(agentsMd, /^## State$/m);
    assert.match(agentsMd, /SQLite database: `~\/\.tamandua\/tamandua\.db`/);
  });

  it("preserves the Testing section", () => {
    assert.match(agentsMd, /^## Testing$/m);
    assert.match(agentsMd, /Parallel Test Safety/);
  });

  // AC 5: The skill is provisioned as AGENTS.md/IDENTITY.md/SOUL.md
  it("documents that the skill is provisioned as persona files", () => {
    assert.match(
      agentsMd,
      /AGENTS\.md.*IDENTITY\.md.*SOUL\.md/,
      "must mention that the skill is provisioned as AGENTS.md, IDENTITY.md, SOUL.md",
    );
  });

  // Verify section ordering: Skills section comes after State and before Testing
  it("places the Skills section between State and Testing", () => {
    const stateIdx = agentsMd.indexOf("## State");
    const skillsIdx = agentsMd.indexOf("## Skills and Agent Instructions");
    const testingIdx = agentsMd.indexOf("## Testing");

    assert.ok(stateIdx >= 0, "State section must exist");
    assert.ok(skillsIdx >= 0, "Skills section must exist");
    assert.ok(testingIdx >= 0, "Testing section must exist");
    assert.ok(
      stateIdx < skillsIdx && skillsIdx < testingIdx,
      "Skills section must appear after State and before Testing",
    );
  });
});
