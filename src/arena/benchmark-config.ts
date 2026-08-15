// ══════════════════════════════════════════════════════════════════════
// benchmark-config.ts — Structured parsing + validation of benchmark_config.json
// Contract A5: replace the silent `null`-on-parse-failure reads with a
// structured `{ ok, value | error }` result and a metric×problemType guard.
// Pure module — no filesystem, no logger, fully unit-testable.
// ══════════════════════════════════════════════════════════════════════

export interface ParsedBenchmarkConfig {
  problemType: string | null;
  metricName: string | null;
  metricDirection: "lower" | "higher" | null;
}

export type BenchmarkConfigParseResult =
  | { ok: true; value: ParsedBenchmarkConfig }
  | { ok: false; error: string };

function normalizeDirection(dir: unknown): "lower" | "higher" | null {
  if (dir === "minimize" || dir === "lower") return "lower";
  if (dir === "maximize" || dir === "higher") return "higher";
  return null;
}

/**
 * Parse a parsed benchmark_config.json into the arena contract.
 *
 * Normalizes the two legacy shapes for `metric` (string `"rmse"` vs object
 * `{ name, direction }`) and the two spellings for problem type (`type` vs
 * `problemType`), mirroring readBenchmarkConfig/readBenchmarkMeta — but with
 * a structured error instead of a silent `null` fallback.
 *
 * A config is invalid when it isn't an object or carries no usable metric.
 */
export function parseBenchmarkConfig(json: unknown): BenchmarkConfigParseResult {
  if (typeof json !== "object" || json === null) {
    return { ok: false, error: "[benchmark_config_invalid] config não é um objeto JSON" };
  }

  const raw = json as Record<string, unknown>;

  const problemType =
    typeof raw.problemType === "string" && raw.problemType.length > 0
      ? raw.problemType
      : typeof raw.type === "string" && raw.type.length > 0
        ? raw.type
        : null;

  let metricName: string | null = null;
  let metricDirection: "lower" | "higher" | null = null;
  if (typeof raw.metric === "string") {
    metricName = raw.metric;
    metricDirection = normalizeDirection(raw.direction ?? raw.metric_direction);
  } else if (raw.metric && typeof raw.metric === "object") {
    const m = raw.metric as Record<string, unknown>;
    metricName = typeof m.name === "string" ? m.name : null;
    metricDirection = normalizeDirection(m.direction);
  }

  if (!metricName) {
    return { ok: false, error: "[benchmark_config_invalid] config sem métrica utilizável (metric string ou {name})" };
  }

  return { ok: true, value: { problemType, metricName, metricDirection } };
}

/** Canonical metrics per problem type (normalized: lowercase, [a-z0-9_]). */
export const METRICS_BY_PROBLEM_TYPE: Record<string, ReadonlySet<string>> = {
  classification: new Set([
    "accuracy",
    "f1",
    "f1_score",
    "f1_macro",
    "precision",
    "recall",
    "roc_auc",
    "auc",
    "average_precision",
    "average_precision_score",
    "log_loss",
    "logloss",
    "hamming",
    "brier",
    "brier_score",
  ]),
  regression: new Set([
    "rmse",
    "mse",
    "mae",
    "mape",
    "msle",
    "rmsle",
    "r2",
    "r2_score",
    "huber",
    "mean_squared_error",
    "mean_absolute_error",
  ]),
};

/**
 * Assert a metric name makes sense for a problem type.
 *
 * Returns a `[metric_problem_mismatch]` warning string when the metric is a
 * recognized metric of the OTHER type (e.g. regression config using
 * accuracy); null when the pairing is known-good, or when either value is
 * missing/unrecognized (no claim — don't guess on custom metrics).
 */
export function assertMetricProblemType(
  problemType: string | null | undefined,
  metricName: string | null | undefined,
): string | null {
  if (!problemType || !metricName) return null;

  const pt = problemType.toLowerCase();
  const mn = metricName.toLowerCase().replace(/[^a-z0-9_]/g, "");

  const own = METRICS_BY_PROBLEM_TYPE[pt];
  if (!own) return null; // unknown problem type — can't judge
  if (own.has(mn)) return null; // known-good pairing

  for (const [otherType, metrics] of Object.entries(METRICS_BY_PROBLEM_TYPE)) {
    if (otherType !== pt && metrics.has(mn)) {
      return `[metric_problem_mismatch] métrica "${metricName}" é típica de ${otherType}, mas o problemType é "${problemType}"`;
    }
  }

  return null; // unrecognized metric — no claim
}
