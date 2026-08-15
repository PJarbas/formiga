// ══════════════════════════════════════════════════════════════════════
// report-builder.ts — Deterministic server-side experiment report generator
//
// C1: renders a StructuredReportTab-compatible markdown report purely from
// the experiment row (plus the workspace's benchmark_config.json for the
// dataset/target labels). The arena agents are not in AGENT_REPORT_MAP, so
// the old handler 404'd on them; this builder closes that gap and makes the
// report reproducible from the DB alone (no reading _results.json off disk).
//
// Format contract: title as `#`, header `**Key:** Value` lines in English
// (Agent/Dataset/Target/Run/Date/Model/Task) terminated by `---`, then `##`
// sections — exactly what parseReportMarkdown extracts.
// ══════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";

export interface ReportExperimentCtx {
  experiment_id: number;
  run_id: string;
  round_number: number | null;
  agent_name: string;
  model_type: string;
  model_algorithm: string | null;
  problem_type: string | null;
  metric_name: string;
  val_metric: number;
  train_metric: number;
  fold_scores: number[] | null;
  hypothesis: string | null;
  learned: string | null;
  next_focus: string | null;
  /** Parsed metrics_json — holds the metric bag + fold_scores + feature_importances. */
  metrics_json: Record<string, unknown>;
  status: string;
  error_message: string | null;
  /** ISO timestamp of the experiment row. */
  created_at: string;
}

export interface ReportBuilderContext {
  experiment: ReportExperimentCtx;
  /** Workspace root; benchmark_config.json is read here for dataset/target labels. */
  workspace: string;
  /** Pre-resolved labels (testability) — skip reading benchmark_config.json. */
  datasetLabel?: string;
  targetColumn?: string;
}

export interface BuildReportResult {
  content: string;
  filename: string;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return String(Number(n.toPrecision(4)));
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function taskLabel(problemType: string | null): string {
  const pt = problemType?.toLowerCase();
  if (pt === "classification") return "classification";
  if (pt === "regression") return "regression";
  return "unknown";
}

function computeCvStd(foldScores: number[] | null | undefined): number | null {
  if (!foldScores || foldScores.length < 2) return null;
  const mean = foldScores.reduce((a, b) => a + b, 0) / foldScores.length;
  const variance = foldScores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (foldScores.length - 1);
  return Math.sqrt(variance);
}

/**
 * Read the dataset label + target column from benchmark_config.json.
 * Best-effort — returns empty strings when the file is missing/corrupt so the
 * report still renders (graceful degradation for legacy runs).
 */
export function readDatasetLabelsFromWorkspace(workspace: string): {
  datasetLabel: string;
  targetColumn: string;
} {
  const candidates = [
    path.join(workspace, "benchmark_config.json"),
    path.join(workspace, "artifacts", "benchmark_config.json"),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      const data = (raw.data ?? {}) as Record<string, unknown>;
      const name =
        (typeof raw.dataset === "string" && raw.dataset) ||
        (typeof raw.name === "string" && raw.name) ||
        (typeof data.dataset === "string" && data.dataset) ||
        "";
      const target =
        (typeof data.targetColumn === "string" && data.targetColumn) ||
        (typeof raw.target_column === "string" && raw.target_column) ||
        (typeof data.target_column === "string" && data.target_column) ||
        "";
      return { datasetLabel: name, targetColumn: target };
    } catch {
      // corrupt — try the next candidate
    }
  }
  return { datasetLabel: "", targetColumn: "" };
}

// ── Section builders ────────────────────────────────────────────────────

/** Typed metric columns per problem type, mapped to metrics_json keys. */
const CLASSIFICATION_METRIC_ROWS: Array<[string, string]> = [
  ["F1", "f1_score"],
  ["Precision", "precision"],
  ["Recall", "recall"],
  ["ROC AUC", "roc_auc"],
  ["Log Loss", "log_loss"],
];
const REGRESSION_METRIC_ROWS: Array<[string, string]> = [
  ["RMSE", "rmse"],
  ["MAE", "mae"],
  ["R²", "r2_score"],
];

function buildMetricsSection(exp: ReportExperimentCtx): string {
  const rows: Array<[string, string]> = [
    [exp.metric_name, "__primary__"],
  ];
  const isClassification = exp.problem_type?.toLowerCase() === "classification";
  const typed = isClassification ? CLASSIFICATION_METRIC_ROWS : REGRESSION_METRIC_ROWS;
  for (const [label, key] of typed) {
    const v = exp.metrics_json[key];
    if (typeof v === "number" && Number.isFinite(v)) rows.push([label, formatNumber(v)]);
  }

  if (rows.length === 0) return "";

  const lines = [
    "## Métricas de Validação",
    "",
    "| Metric | Value |",
    "|--------|-------|",
  ];
  for (const [label, key] of rows) {
    const value = key === "__primary__" ? formatNumber(exp.val_metric) : key;
    lines.push(`| ${label} | ${value} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function buildFoldsSection(foldScores: number[] | null | undefined): string {
  if (!foldScores || foldScores.length === 0) return "";
  const lines = ["## Folds", "", "| Fold | Score |", "|------|-------|"];
  foldScores.forEach((s, i) => lines.push(`| ${i + 1} | ${formatNumber(s)} |`));
  lines.push("");
  return lines.join("\n");
}

function buildReflectionSection(exp: ReportExperimentCtx): string {
  const parts: string[] = ["## Reflexão do Agente", ""];
  parts.push("### Hipótese");
  parts.push(exp.hypothesis?.trim() || "_Não declarada._");
  parts.push("");
  parts.push("### Aprendizado");
  parts.push(exp.learned?.trim() || "_Não declarado._");
  parts.push("");
  parts.push("### Próximo Foco");
  parts.push(exp.next_focus?.trim() || "_Não declarado._");
  parts.push("");
  return parts.join("\n");
}

function buildTopFeaturesSection(metricsJson: Record<string, unknown>): string {
  const fi = metricsJson["feature_importances"];
  if (!Array.isArray(fi) || fi.length === 0) return "";
  const lines = ["## Top Features", "", "| # | Feature | Importance |", "|---|---------|-----------|"];
  fi.slice(0, 15).forEach((v, i) => {
    const value = typeof v === "number" ? formatNumber(v) : String(v ?? "—");
    lines.push(`| ${i + 1} | Feature ${i + 1} | ${value} |`);
  });
  lines.push("");
  return lines.join("\n");
}

// ── Main builder ────────────────────────────────────────────────────────

export function buildExperimentReportMarkdown(ctx: ReportBuilderContext): BuildReportResult {
  const exp = ctx.experiment;
  const labels =
    ctx.datasetLabel !== undefined || ctx.targetColumn !== undefined
      ? { datasetLabel: ctx.datasetLabel ?? "", targetColumn: ctx.targetColumn ?? "" }
      : readDatasetLabelsFromWorkspace(ctx.workspace);

  const cvStd = computeCvStd(exp.fold_scores);
  const cvStdStr = cvStd !== null ? ` ± ${formatNumber(cvStd)}` : "";
  const modelLine = exp.model_algorithm
    ? `${exp.model_type} (${exp.model_algorithm})`
    : exp.model_type;

  const header = [
    `# Relatório — ${exp.model_type} (Experimento #${exp.experiment_id})`,
    "",
    `**Agent:** ${exp.agent_name}`,
    `**Dataset:** ${labels.datasetLabel || "—"}`,
    `**Target:** ${labels.targetColumn || "—"}`,
    `**Run:** ${exp.run_id}`,
    `**Date:** ${formatDate(exp.created_at)}`,
    `**Model:** ${modelLine}`,
    `**Task:** ${taskLabel(exp.problem_type)}`,
    `**Status:** ${exp.status}`,
    exp.round_number !== null ? `**Round:** ${exp.round_number}` : "",
    "---",
    "",
  ].filter(Boolean);

  const summary = [
    "## Resumo",
    "",
    exp.hypothesis?.trim()
      ? exp.hypothesis.trim()
      : `Experimento ${exp.model_type} rodado na arena com a métrica ${exp.metric_name}.`,
    "",
  ].join("\n");

  const featureCount = Array.isArray(exp.metrics_json["feature_importances"])
    ? (exp.metrics_json["feature_importances"] as unknown[]).length
    : null;
  const baseline = [
    "## Baseline",
    "",
    `**Model type:** \`${exp.model_type}\``,
    `**CV Mean (${exp.metric_name}):** ${formatNumber(exp.val_metric)}${cvStdStr}`,
    `**Train Mean (${exp.metric_name}):** ${formatNumber(exp.train_metric)}`,
    featureCount !== null ? `- **${featureCount} features** com importância reportada` : "",
    "",
  ].filter(Boolean).join("\n");

  const notes = exp.error_message
    ? ["", "> **Nota:** experimento registrado como falha — " + exp.error_message, ""].join("\n")
    : "";

  const content =
    header.join("\n") +
    summary +
    baseline +
    buildMetricsSection(exp) +
    buildFoldsSection(exp.fold_scores) +
    buildReflectionSection(exp) +
    buildTopFeaturesSection(exp.metrics_json) +
    notes;

  return {
    content,
    filename: `report_${exp.experiment_id}.md`,
  };
}
