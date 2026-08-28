// ══════════════════════════════════════════════════════════════════════
// arena-workflow-parse.test.ts — Tests for A2: JSON-envelope-first parsing
// of arena agent output, with the legacy marker/path format preserved.
// ══════════════════════════════════════════════════════════════════════

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArenaAgentOutput } from "./arena-workflow.js";

const tmpDirs: string[] = [];

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arena-parse-"));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── JSON envelope (precedence 1 & 2) ────────────────────────────────────

describe("parseArenaAgentOutput — JSON envelope", () => {
  it("parses a ```json fence with escaped newlines in the script", () => {
    const ws = makeWorkspace();
    // Inside the JSON string, `\n` is a 2-char escape that JSON.parse turns
    // into a real newline — exactly what a well-behaved agent emits.
    const stdout = [
      "Trabalho de análise concluído.",
      "",
      "```json",
      '{ "script": "import numpy as np\\nprint(\\\"hi\\\")\\n", "hypothesis": "mais features", "learned": "gbm ganha", "nextFocus": "tuning" }',
      "```",
      "",
      "fim.",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, 'import numpy as np\nprint("hi")\n');
    assert.equal(parsed.hypothesis, "mais features");
    assert.equal(parsed.learned, "gbm ganha");
    assert.equal(parsed.nextFocus, "tuning");
  });

  it("parses a JSON fence without a language tag", () => {
    const ws = makeWorkspace();
    const stdout = [
      "```",
      '{"script":"print(1)","hypothesis":"h"}',
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print(1)");
    assert.equal(parsed.hypothesis, "h");
  });

  it("falls back to the LAST valid fence when an earlier one is malformed", () => {
    const ws = makeWorkspace();
    const stdout = [
      "```json",
      "{ oops not json }",
      "```",
      "```json",
      '{"script":"print(2)","hypothesis":"segundo"}',
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print(2)");
    assert.equal(parsed.hypothesis, "segundo");
  });

  it("fills missing JSON keys with empty strings", () => {
    const ws = makeWorkspace();
    const stdout = [
      "```json",
      '{"script":"print(3)"}',
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print(3)");
    assert.equal(parsed.hypothesis, "");
    assert.equal(parsed.learned, "");
    assert.equal(parsed.nextFocus, "");
  });

  it("parses a bare JSON object with no fence", () => {
    const ws = makeWorkspace();
    const stdout = 'prefix\n{"script":"print(4)","hypothesis":"bare"}';
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print(4)");
    assert.equal(parsed.hypothesis, "bare");
  });

  it("caps insight fields that contain a runaway source-code dump", () => {
    const ws = makeWorkspace();
    // Regression: a modeler pasted ~43KB of arena-engine.ts into `hypothesis`.
    const dump = "src/arena/arena-engine.ts".repeat(5000); // ~100KB
    const stdout = [
      "```json",
      JSON.stringify({
        script: "print(5)",
        hypothesis: dump,
        learned: dump,
        nextFocus: dump,
      }),
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print(5)");
    assert.ok(parsed.hypothesis.length <= 2000, `hypothesis capped (${parsed.hypothesis.length})`);
    assert.ok(parsed.learned.length <= 2000, `learned capped (${parsed.learned.length})`);
    assert.ok(parsed.nextFocus.length <= 2000, `nextFocus capped (${parsed.nextFocus.length})`);
    // The cap keeps the head, not the tail — the beginning still identifies it.
    assert.ok(parsed.hypothesis.startsWith("src/arena/arena-engine.ts"));
  });
});

// ── Legacy fallback (precedence 3) ──────────────────────────────────────

describe("parseArenaAgentOutput — legacy fallback", () => {
  it("reads the script from SCRIPT_PATH when the agent wrote a file", () => {
    const ws = makeWorkspace();
    const scriptPath = path.join(ws, "model_script.py");
    fs.writeFileSync(scriptPath, "print('from file')");
    const stdout = [
      "HIPOTESE: testar gradientes",
      "SCRIPT_PATH: model_script.py",
      "APRENDIZADO: xgboost forte",
      "PROXIMO_FOCO: mais folds",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print('from file')");
    assert.equal(parsed.hypothesis, "testar gradientes");
    assert.equal(parsed.learned, "xgboost forte");
    assert.equal(parsed.nextFocus, "mais folds");
  });

  it("supports the English HYPOTHESIS/NEXT_FOCUS spellings", () => {
    const ws = makeWorkspace();
    const stdout = [
      "HYPOTHESIS: normalize first",
      "NEXT_FOCUS: feature selection",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.hypothesis, "normalize first");
    assert.equal(parsed.nextFocus, "feature selection");
  });

  it("extracts a ```python block when no SCRIPT_PATH file exists", () => {
    const ws = makeWorkspace();
    const stdout = [
      "HIPOTESE: h",
      "```python",
      "print('inline')",
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "print('inline')");
  });

  it("returns an empty script when the SCRIPT_PATH file does not exist", () => {
    const ws = makeWorkspace();
    const stdout = "SCRIPT_PATH: does_not_exist.py";
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "");
  });
});

// ── Degenerate inputs ───────────────────────────────────────────────────

describe("parseArenaAgentOutput — degenerate", () => {
  it("returns empty strings for empty output", () => {
    const parsed = parseArenaAgentOutput("", makeWorkspace());
    assert.deepEqual(parsed, { script: "", hypothesis: "", learned: "", nextFocus: "" });
  });

  it("returns empty strings for malformed JSON with no legacy markers", () => {
    const ws = makeWorkspace();
    const stdout = [
      "```json",
      "{ unclosed",
      "```",
    ].join("\n");
    const parsed = parseArenaAgentOutput(stdout, ws);
    assert.equal(parsed.script, "");
    assert.equal(parsed.hypothesis, "");
  });
});
