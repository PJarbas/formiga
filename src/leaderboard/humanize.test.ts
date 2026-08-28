// ══════════════════════════════════════════════════════════════════════
// humanize.test.ts — Tests for humanizeModelAlgorithm
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { humanizeModelAlgorithm } from "./humanize.js";

describe("humanizeModelAlgorithm", () => {
  it("splits concatenated ensemble acronyms into their members", () => {
    assert.equal(humanizeModelAlgorithm("SVCKNN"), "SVC KNN");
    assert.equal(humanizeModelAlgorithm("SVCKNN_QDAGNB"), "SVC KNN + QDA GNB");
    assert.equal(
      humanizeModelAlgorithm("SVCKNN_QDAGNB_DET"),
      "SVC KNN + QDA GNB + DET",
    );
  });

  it("keeps a single known acronym unchanged", () => {
    assert.equal(humanizeModelAlgorithm("SVC"), "SVC");
    assert.equal(humanizeModelAlgorithm("LGBM"), "LGBM");
  });

  it("adds spaces to camelCase model names", () => {
    assert.equal(
      humanizeModelAlgorithm("LinearDiscriminantAnalysis"),
      "Linear Discriminant Analysis",
    );
  });

  it("keeps underscore-separated multi-word names readable", () => {
    assert.equal(humanizeModelAlgorithm("random_forest"), "random forest");
  });

  it("returns null for empty or whitespace input", () => {
    assert.equal(humanizeModelAlgorithm(null), null);
    assert.equal(humanizeModelAlgorithm(undefined), null);
    assert.equal(humanizeModelAlgorithm(""), null);
    assert.equal(humanizeModelAlgorithm("   "), null);
  });
});
