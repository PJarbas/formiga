// ══════════════════════════════════════════════════════════════════════
// humanize.ts — Human-readable model algorithm labels
//
// The modeler agent persists the algorithm in `_results.json`'s `model` field.
// Ensembles come back as concatenated class names without separators
// ("SVCKNN_QDAGNB", "SVCKNN_QDAGNB_DET"). This turns those into legible labels
// ("SVC KNN + QDA GNB + DET") while leaving well-formed names untouched
// ("LinearDiscriminantAnalysis" → "Linear Discriminant Analysis").
// Pure module — no I/O, fully unit-testable.
// ══════════════════════════════════════════════════════════════════════

// Known sklearn-style estimator acronyms, longest-first for greedy matching.
const KNOWN_ACRONYMS: readonly string[] = [
  "XGBoost",
  "LinearSVC",
  "NuSVC",
  "KNeighbors",
  "RadiusNeighbors",
  "ElasticNet",
  "AdaBoost",
  "CatBoost",
  "HistGradientBoosting",
  "HistGBM",
  "LGBM",
  "SVC",
  "SVR",
  "KNN",
  "QDA",
  "LDA",
  "GNB",
  "MNB",
  "BNB",
  "CNB",
  "XGB",
  "LGB",
  "GBC",
  "ABC",
  "RFC",
  "ETC",
  "HGB",
  "GB",
  "RF",
  "ET",
  "DT",
  "MLP",
  "SGD",
  "LR",
  "DET",
  "Ridge",
  "Lasso",
  "RIDGE",
  "LASSO",
  "CB",
];

const KNOWN_ACRONYM_SET = new Set(KNOWN_ACRONYMS);

/**
 * Greedy-tokenize a string into known estimator acronyms. Returns `null` when
 * the string isn't a pure acronym concatenation (e.g. "LinearDiscriminant
 * Analysis"), so callers fall back to camelCase splitting. "SVCKNN" → ["SVC",
 * "KNN"]; "SVC" → ["SVC"].
 */
function tokenizeKnownAcronyms(token: string): string[] | null {
  const result: string[] = [];
  let i = 0;
  while (i < token.length) {
    let matched: string | null = null;
    for (const acro of KNOWN_ACRONYMS) {
      if (token.startsWith(acro, i)) {
        matched = acro;
        break;
      }
    }
    if (matched === null) return null; // not a pure acronym run
    result.push(matched);
    i += matched.length;
  }
  return result;
}

/** Split a camelCase token into words: "LinearDiscriminantAnalysis" → ["Linear", "Discriminant", "Analysis"]. */
function camelSplit(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
}

/**
 * Render a model_algorithm string as a human-readable label.
 *
 * - Concatenated ensembles are split into their member estimators and joined
 *   with " + " ("SVCKNN_QDAGNB_DET" → "SVC KNN + QDA GNB + DET").
 * - CamelCase names get spaces ("LinearDiscriminantAnalysis" → "Linear
 *   Discriminant Analysis").
 * - Underscore-separated multi-word names keep spaces ("random_forest" →
 *   "random forest").
 *
 * Returns null for empty/whitespace input so callers can fall back cleanly.
 */
export function humanizeModelAlgorithm(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const tokens = trimmed.split(/[_\-/\\|+]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  const pieces = tokens.map((token) => {
    const acro = tokenizeKnownAcronyms(token);
    if (acro === null) return camelSplit(token).join(" ");
    if (acro.length > 1) return acro.join(" ");
    return acro[0]; // single known acronym, e.g. "SVC"
  });

  // Ensembles: when every piece is made solely of known acronyms, join the
  // members with " + " to surface the ensemble structure. Otherwise it's a
  // single multi-word name — keep spaces.
  const allAcronyms = pieces.every((piece) =>
    piece.split(" ").every((word) => KNOWN_ACRONYM_SET.has(word)),
  );
  return allAcronyms ? pieces.join(" + ") : pieces.join(" ");
}
