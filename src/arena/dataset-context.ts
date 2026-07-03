// ══════════════════════════════════════════════════════════════════════
// dataset-context.ts — Read dataset metadata from the workspace to inform
//                      agent prompt complexity decisions.
// ══════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";

export interface DatasetContext {
  rows: number | null;
  cols: number | null;
  problemType: string | null;
  metricName: string | null;
  metricDirection: "lower" | "higher" | null;
  targetColumn: string | null;
  categoricalCount: number | null;
  numericCount: number | null;
  edaSummary: string | null;
  featuresSummary: string | null;
  complexityTier: "tiny" | "small" | "medium" | "large";
}

function computeComplexityTier(rows: number | null): DatasetContext["complexityTier"] {
  if (rows === null) return "medium";
  if (rows < 2_000) return "tiny";
  if (rows < 10_000) return "small";
  if (rows < 50_000) return "medium";
  return "large";
}

function extractReportSummary(filePath: string, maxLines: number = 20): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim() !== "");
    return lines.slice(0, maxLines).join("\n");
  } catch {
    return null;
  }
}

function readDatasetShape(workspace: string): { rows: number | null; cols: number | null } {
  const edaConfigPath = path.join(workspace, "artifacts", "eda_config.json");
  if (fs.existsSync(edaConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(edaConfigPath, "utf-8"));
      const rows = raw.n_rows ?? raw.rows ?? raw.shape?.[0] ?? null;
      const cols = raw.n_cols ?? raw.cols ?? raw.n_features ?? raw.shape?.[1] ?? null;
      if (rows !== null) return { rows, cols };
    } catch { /* continue to fallback */ }
  }

  const contextFiles = [
    path.join(workspace, "artifacts", "dataset_meta.json"),
    path.join(workspace, "artifacts", "features_meta.json"),
  ];
  for (const p of contextFiles) {
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
        const rows = raw.rows ?? raw.n_samples ?? null;
        const cols = raw.cols ?? raw.n_features ?? null;
        if (rows !== null) return { rows, cols };
      } catch { /* continue */ }
    }
  }

  // Parse from EDA report
  const edaReport = path.join(workspace, "reports", "01_eda.md");
  if (fs.existsSync(edaReport)) {
    try {
      const content = fs.readFileSync(edaReport, "utf-8");
      const shapeMatch = content.match(/shape[:\s]*\(?(\d+)[,x\s]+(\d+)\)?/i);
      if (shapeMatch) {
        return { rows: parseInt(shapeMatch[1], 10), cols: parseInt(shapeMatch[2], 10) };
      }
      const rowsMatch = content.match(/(\d{2,})\s*(?:rows|samples|observations)/i);
      const colsMatch = content.match(/(\d+)\s*(?:columns|features|variables)/i);
      if (rowsMatch) {
        return {
          rows: parseInt(rowsMatch[1], 10),
          cols: colsMatch ? parseInt(colsMatch[1], 10) : null,
        };
      }
    } catch { /* ignore */ }
  }

  return { rows: null, cols: null };
}

function readFeatureTypes(workspace: string): { categorical: number | null; numeric: number | null } {
  const edaConfigPath = path.join(workspace, "artifacts", "eda_config.json");
  if (fs.existsSync(edaConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(edaConfigPath, "utf-8"));
      return {
        categorical: raw.n_categorical ?? raw.categorical_count ?? null,
        numeric: raw.n_numeric ?? raw.numeric_count ?? null,
      };
    } catch { /* ignore */ }
  }
  return { categorical: null, numeric: null };
}

function readBenchmarkMeta(workspace: string): {
  problemType: string | null;
  metricName: string | null;
  metricDirection: "lower" | "higher" | null;
  targetColumn: string | null;
} {
  const candidates = [
    path.join(workspace, "benchmark_config.json"),
    path.join(workspace, "artifacts", "benchmark_config.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
      const problemType = raw.problemType ?? raw.type ?? null;
      let metricName: string | null = null;
      let metricDirection: "lower" | "higher" | null = null;
      if (typeof raw.metric === "string") {
        metricName = raw.metric;
        const dir = raw.direction ?? raw.metric_direction;
        metricDirection = dir === "lower" || dir === "minimize" ? "lower" :
          dir === "higher" || dir === "maximize" ? "higher" : null;
      } else if (raw.metric && typeof raw.metric === "object") {
        metricName = raw.metric.name ?? null;
        const dir = raw.metric.direction;
        metricDirection = dir === "lower" || dir === "minimize" ? "lower" :
          dir === "higher" || dir === "maximize" ? "higher" : null;
      }
      const targetColumn = raw.data?.targetColumn ?? raw.target_column ?? null;
      return { problemType, metricName, metricDirection, targetColumn };
    } catch { /* continue */ }
  }
  return { problemType: null, metricName: null, metricDirection: null, targetColumn: null };
}

export function readDatasetContext(workspace: string): DatasetContext {
  const { rows, cols } = readDatasetShape(workspace);
  const { categorical, numeric } = readFeatureTypes(workspace);
  const { problemType, metricName, metricDirection, targetColumn } = readBenchmarkMeta(workspace);

  const edaSummary = extractReportSummary(path.join(workspace, "reports", "01_eda.md"), 15);
  const featuresSummary = extractReportSummary(path.join(workspace, "reports", "02_features.md"), 15);

  return {
    rows,
    cols,
    problemType,
    metricName,
    metricDirection,
    targetColumn,
    categoricalCount: categorical,
    numericCount: numeric,
    edaSummary,
    featuresSummary,
    complexityTier: computeComplexityTier(rows),
  };
}

export function formatDatasetContextForPrompt(ctx: DatasetContext, agentId: string): string {
  let section = `### Dataset Context\n`;
  section += `- **Rows**: ${ctx.rows ?? "unknown"}\n`;
  section += `- **Features**: ${ctx.cols ?? "unknown"}`;
  if (ctx.categoricalCount !== null || ctx.numericCount !== null) {
    section += ` (${ctx.numericCount ?? "?"} numeric, ${ctx.categoricalCount ?? "?"} categorical)`;
  }
  section += `\n`;
  section += `- **Problem type**: ${ctx.problemType ?? "unknown"}\n`;
  section += `- **Target column**: ${ctx.targetColumn ?? "unknown"}\n`;
  section += `- **Metric**: ${ctx.metricName ?? "unknown"} (${ctx.metricDirection ?? "unknown"} is better)\n`;
  section += `- **Complexity tier**: ${ctx.complexityTier.toUpperCase()}\n`;
  section += `\n`;

  if (agentId.includes("advanced")) {
    section += formatAdvancedComplexityGates(ctx);
  }

  if (agentId.includes("classic")) {
    section += formatClassicComplexityGates(ctx);
  }

  if (ctx.edaSummary) {
    section += `\n### EDA Key Findings (from data-analyst)\n`;
    section += ctx.edaSummary + "\n";
  }
  if (ctx.featuresSummary) {
    section += `\n### Feature Engineering Summary (from feature-engineer)\n`;
    section += ctx.featuresSummary + "\n";
  }

  return section;
}

function formatAdvancedComplexityGates(ctx: DatasetContext): string {
  let gates = `### MANDATORY Complexity Gates (modeler-advanced)\n\n`;

  switch (ctx.complexityTier) {
    case "tiny":
      gates += `**TIER: TINY (<2k rows)** — Heavy NNs will overfit catastrophically.\n\n`;
      gates += `ALLOWED:\n`;
      gates += `- TabPFN (zero tuning, best small-data baseline)\n`;
      gates += `- KAN (few parameters, smooth nonlinearities)\n`;
      gates += `- Light stacking (2-3 base learners + Ridge meta)\n`;
      gates += `- AutoML with strict 5-minute cap (FLAML preferred)\n\n`;
      gates += `FORBIDDEN:\n`;
      gates += `- FT-Transformer, SAINT, TabNet (will overfit)\n`;
      gates += `- Deep MLP (>2 layers or >64 hidden units)\n`;
      gates += `- Optuna with >10 trials (not enough data for reliable CV)\n`;
      gates += `- Any architecture search (DAS)\n`;
      gates += `- Deep ensembles (5 models x overfit = 5x overfit)\n\n`;
      gates += `MAX Optuna trials: 10. Focus on regularization over architecture.\n`;
      break;

    case "small":
      gates += `**TIER: SMALL (2k-10k rows)** — NNs possible but regularize aggressively.\n\n`;
      gates += `ALLOWED:\n`;
      gates += `- TabPFN (still excellent at this scale)\n`;
      gates += `- Simple MLP (2 layers, <=128 units, dropout>=0.3)\n`;
      gates += `- KAN, SAINT (with early stopping patience<=10)\n`;
      gates += `- AutoML with 10-minute cap\n`;
      gates += `- Light stacking\n\n`;
      gates += `USE WITH CAUTION:\n`;
      gates += `- FT-Transformer (only if <50 features, heavy regularization)\n\n`;
      gates += `FORBIDDEN:\n`;
      gates += `- TabNet with n_d>64 (too many parameters)\n`;
      gates += `- Deep stacking (>L2)\n`;
      gates += `- Architecture search with >15 Optuna trials\n\n`;
      gates += `MAX Optuna trials: 15. Train/val gap must stay <8%.\n`;
      break;

    case "medium":
      gates += `**TIER: MEDIUM (10k-50k rows)** — Full NN toolkit available with discipline.\n\n`;
      gates += `ALLOWED:\n`;
      gates += `- FT-Transformer, SAINT, TabNet, MLP, KAN\n`;
      gates += `- Multi-level stacking (L2)\n`;
      gates += `- AutoML with 20-minute cap\n`;
      gates += `- Optuna up to 30 trials\n`;
      gates += `- Entity embeddings for high-cardinality categoricals\n\n`;
      gates += `USE WITH CAUTION:\n`;
      gates += `- Knowledge distillation (only if teacher is strong)\n`;
      gates += `- Deep ensembles (only 3 models max)\n\n`;
      gates += `MAX Optuna trials: 30. Train/val gap must stay <10%.\n`;
      break;

    case "large":
      gates += `**TIER: LARGE (>50k rows)** — Full arsenal, scale matters.\n\n`;
      gates += `ALLOWED: Everything. Prioritize models that scale:\n`;
      gates += `- TabNet, DCN-V2, RLN/Wide&Deep, MOE Tabular\n`;
      gates += `- Deep stacking, knowledge distillation\n`;
      gates += `- Deep ensembles (5 models), architecture search\n`;
      gates += `- Entity embeddings, SSL pretraining\n\n`;
      gates += `DEPRIORITIZE:\n`;
      gates += `- TabPFN (designed for <10k, slow at scale)\n`;
      gates += `- SAINT (O(n^2) intersample attention)\n\n`;
      gates += `MAX Optuna trials: 50. Exploit the data volume.\n`;
      break;
  }

  return gates;
}

function formatClassicComplexityGates(ctx: DatasetContext): string {
  let gates = `### Complexity Notes (modeler-classic)\n\n`;

  switch (ctx.complexityTier) {
    case "tiny":
      gates += `**TIER: TINY (<2k rows)** — Regularize heavily, avoid complex ensembles.\n`;
      gates += `- Prefer Ridge/ElasticNet or single GBM with low depth (max_depth<=4)\n`;
      gates += `- Keep Optuna <=15 trials (CV variance is high with few samples)\n`;
      gates += `- Stacking likely overfits — use only if base models are very simple\n`;
      break;
    case "small":
      gates += `**TIER: SMALL (2k-10k rows)** — Standard approach works.\n`;
      gates += `- GBM with moderate complexity, Optuna 20-30 trials\n`;
      gates += `- L1 stacking is appropriate\n`;
      break;
    case "medium":
      gates += `**TIER: MEDIUM (10k-50k rows)** — Full toolkit. Push hard.\n`;
      gates += `- All GBM variants, full Optuna budget (50 trials)\n`;
      gates += `- L1 stacking with diverse base learners\n`;
      break;
    case "large":
      gates += `**TIER: LARGE (>50k rows)** — Scale and speed matter.\n`;
      gates += `- HistGradientBoosting for speed, LightGBM for quality\n`;
      gates += `- Full Optuna budget, consider subsampling for expensive models\n`;
      break;
  }

  return gates + "\n";
}
