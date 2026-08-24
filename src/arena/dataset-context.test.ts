// ══════════════════════════════════════════════════════════════════════
// dataset-context.test.ts — Tests for dataset shape parsing and complexity
//                            tier classification.
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShapeFromText, computeComplexityTier } from "./dataset-context.js";

// ── parseShapeFromText ─────────────────────────────────────────────────

describe("parseShapeFromText — shape line", () => {
  it("parses markdown bold with parentheses: **Shape**: (150, 5)", () => {
    const result = parseShapeFromText("**Shape**: (150, 5)");
    assert.equal(result.rows, 150);
    assert.equal(result.cols, 5);
  });

  it("parses markdown bold with 'x': **Shape**: 150 x 5", () => {
    const result = parseShapeFromText("**Shape**: 150 x 5");
    assert.equal(result.rows, 150);
    assert.equal(result.cols, 5);
  });

  it("parses without bold, parentheses: Shape: (1000, 20)", () => {
    const result = parseShapeFromText("Shape: (1000, 20)");
    assert.equal(result.rows, 1000);
    assert.equal(result.cols, 20);
  });

  it("parses single-asterisk bold: *Shape*: (500, 10)", () => {
    const result = parseShapeFromText("*Shape*: (500, 10)");
    assert.equal(result.rows, 500);
    assert.equal(result.cols, 10);
  });

  it("parses shape without colon: **Shape** (200, 8)", () => {
    const result = parseShapeFromText("**Shape** (200, 8)");
    assert.equal(result.rows, 200);
    assert.equal(result.cols, 8);
  });
});

describe("parseShapeFromText — fallback rows", () => {
  it("detects 'rows' keyword: 'Dataset has 500 rows and 10 columns'", () => {
    const result = parseShapeFromText("Dataset has 500 rows and 10 columns");
    assert.equal(result.rows, 500);
    assert.equal(result.cols, 10);
  });

  it("detects 'samples' keyword: 'Total: 2000 samples'", () => {
    const result = parseShapeFromText("Total: 2000 samples");
    assert.equal(result.rows, 2000);
    assert.equal(result.cols, null);
  });

  it("detects 'amostras' (Portuguese): 'Contém 150 amostras'", () => {
    const result = parseShapeFromText("Contém 150 amostras");
    assert.equal(result.rows, 150);
    assert.equal(result.cols, null);
  });
});

describe("parseShapeFromText — pt-BR thousands separators", () => {
  it("parses '3.608.050 linhas × 48 colunas' (run e5cccd51 format)", () => {
    const result = parseShapeFromText("Dataset com 3.608.050 linhas × 48 colunas");
    assert.equal(result.rows, 3_608_050);
    assert.equal(result.cols, 48);
  });

  it("parses 'linhas' keyword with pt-BR separator and no cols", () => {
    const result = parseShapeFromText("Total de registros: 1.234.567 linhas");
    assert.equal(result.rows, 1_234_567);
    assert.equal(result.cols, null);
  });

  it("parses 'colunas' keyword for column count", () => {
    const result = parseShapeFromText("Dados com 500 linhas e 12 colunas");
    assert.equal(result.rows, 500);
    assert.equal(result.cols, 12);
  });

  it("parses en-US comma thousands separators", () => {
    const result = parseShapeFromText("1,000 rows and 20 columns");
    assert.equal(result.rows, 1000);
    assert.equal(result.cols, 20);
  });
});

describe("parseShapeFromText — edge cases", () => {
  it("returns null rows/cols when no shape info present", () => {
    const result = parseShapeFromText("No shape information here");
    assert.equal(result.rows, null);
    assert.equal(result.cols, null);
  });

  it("returns null rows/cols for empty string", () => {
    const result = parseShapeFromText("");
    assert.equal(result.rows, null);
    assert.equal(result.cols, null);
  });

  it("does not match single-digit 'rows' (avoid false positives on 'row 1')", () => {
    // The regex requires \d{2,} so single digits should not match as row count
    const result = parseShapeFromText("Row 5 has a value");
    assert.equal(result.rows, null);
    assert.equal(result.cols, null);
  });
});

// ── computeComplexityTier ──────────────────────────────────────────────

describe("computeComplexityTier", () => {
  it("returns tiny for null (unknown rows)", () => {
    assert.equal(computeComplexityTier(null), "tiny");
  });

  it("returns tiny for 100 rows", () => {
    assert.equal(computeComplexityTier(100), "tiny");
  });

  it("returns tiny for 1999 rows (boundary)", () => {
    assert.equal(computeComplexityTier(1999), "tiny");
  });

  it("returns small for 2000 rows (boundary)", () => {
    assert.equal(computeComplexityTier(2000), "small");
  });

  it("returns small for 9999 rows (boundary)", () => {
    assert.equal(computeComplexityTier(9999), "small");
  });

  it("returns medium for 10000 rows (boundary)", () => {
    assert.equal(computeComplexityTier(10000), "medium");
  });

  it("returns medium for 49999 rows (boundary)", () => {
    assert.equal(computeComplexityTier(49999), "medium");
  });

  it("returns large for 50000 rows (boundary)", () => {
    assert.equal(computeComplexityTier(50000), "large");
  });

  it("returns large for 100000 rows", () => {
    assert.equal(computeComplexityTier(100000), "large");
  });

  it("is monotonic: tier never decreases as rows grow", () => {
    const tiers = ["tiny", "small", "medium", "large"] as const;
    const testRows = [null, 0, 100, 1999, 2000, 5000, 9999, 10000, 30000, 49999, 50000, 100000];
    let prevTier = -1;
    for (const rows of testRows) {
      const tier = computeComplexityTier(rows);
      const idx = tiers.indexOf(tier);
      assert.ok(idx >= prevTier, `tier should not decrease: ${prevTier} -> ${idx} at rows=${rows}`);
      prevTier = idx;
    }
  });
});
