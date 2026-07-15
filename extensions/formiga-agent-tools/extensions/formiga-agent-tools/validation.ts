/**
 * validation.ts — Runtime validation helpers for tool parameters
 *
 * TypeBox does JSON-schema-level validation of shape/types when pi
 * dispatches a tool call. These functions do the domain-specific checks
 * TypeBox can't express (regex patterns for keys, size limits, enum
 * membership for internal categories).
 *
 * Extracted from tool handlers so they can be unit-tested in isolation.
 */

const ARTIFACT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_ARTIFACT_BYTES = 500 * 1024; // 500KB
const MAX_DESCRIPTION_LEN = 500;
const MAX_REASONING_LEN = 1000;
const MAX_ALTERNATIVES = 10;
const MAX_TAGS = 10;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

export const VALID_DECISION_TYPES = [
  "model_selection",
  "feature_drop",
  "hyperparameter",
  "early_stop",
  "error_recovery",
] as const;

export type DecisionType = (typeof VALID_DECISION_TYPES)[number];

export interface SaveArtifactArgs {
  key: string;
  data: Record<string, unknown>;
}

export interface LogDecisionArgs {
  decision_type: string;
  description: string;
  reasoning?: string;
  alternatives_considered?: string[];
}

export interface ReportMetricArgs {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

export interface QueryLeaderboardArgs {
  limit?: number;
}

/**
 * Validate arguments for save_artifact.
 * @throws Error with a user-facing message if invalid.
 */
export function validateSaveArtifact(args: SaveArtifactArgs): void {
  const { key, data } = args;

  if (!key || typeof key !== "string") {
    throw new Error("Missing required field: key");
  }
  if (!ARTIFACT_KEY_PATTERN.test(key)) {
    throw new Error(
      `Invalid artifact key "${key}". Use lowercase letters/digits/underscore, start with a letter, 2-31 chars.`,
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Field 'data' must be a JSON object");
  }

  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_ARTIFACT_BYTES) {
    throw new Error(
      `Artifact too large: ${Math.round(serialized.length / 1024)}KB (max ${MAX_ARTIFACT_BYTES / 1024}KB)`,
    );
  }
}

/**
 * Validate arguments for log_decision.
 */
export function validateLogDecision(args: LogDecisionArgs): void {
  const { decision_type, description, reasoning, alternatives_considered } = args;

  if (
    !decision_type ||
    !(VALID_DECISION_TYPES as readonly string[]).includes(decision_type)
  ) {
    throw new Error(
      `Invalid decision_type "${decision_type}". Must be one of: ${VALID_DECISION_TYPES.join(", ")}`,
    );
  }

  if (!description || typeof description !== "string") {
    throw new Error("Missing required field: description");
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new Error(
      `description too long: ${description.length} chars (max ${MAX_DESCRIPTION_LEN})`,
    );
  }

  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== "string") {
      throw new Error("reasoning must be a string");
    }
    if (reasoning.length > MAX_REASONING_LEN) {
      throw new Error(
        `reasoning too long: ${reasoning.length} chars (max ${MAX_REASONING_LEN})`,
      );
    }
  }

  if (alternatives_considered !== undefined && alternatives_considered !== null) {
    if (!Array.isArray(alternatives_considered)) {
      throw new Error("alternatives_considered must be an array of strings");
    }
    if (alternatives_considered.length > MAX_ALTERNATIVES) {
      throw new Error(
        `Too many alternatives: ${alternatives_considered.length} (max ${MAX_ALTERNATIVES})`,
      );
    }
    for (const alt of alternatives_considered) {
      if (typeof alt !== "string") {
        throw new Error("Each alternative must be a string");
      }
    }
  }
}

/**
 * Validate arguments for report_metric.
 */
export function validateReportMetric(args: ReportMetricArgs): void {
  const { name, value, tags } = args;

  if (!name || typeof name !== "string") {
    throw new Error("Missing required field: name");
  }
  if (!METRIC_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid metric name "${name}". Use lowercase letters/digits/underscore, start with a letter, 2-31 chars.`,
    );
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid metric value "${value}". Must be a finite number.`);
  }

  if (tags !== undefined && tags !== null) {
    if (typeof tags !== "object" || Array.isArray(tags)) {
      throw new Error("tags must be an object");
    }
    const keys = Object.keys(tags);
    if (keys.length > MAX_TAGS) {
      throw new Error(`Too many tags: ${keys.length} (max ${MAX_TAGS})`);
    }
    for (const [k, v] of Object.entries(tags)) {
      if (typeof v !== "string") {
        throw new Error(`Tag value for "${k}" must be a string`);
      }
    }
  }
}

/**
 * Validate arguments for query_leaderboard.
 * Returns the effective limit (default: 5) once validation passes.
 */
export function validateQueryLeaderboard(args: QueryLeaderboardArgs): number {
  const { limit } = args ?? {};
  if (limit === undefined || limit === null) return 5;
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    throw new Error(`Invalid limit "${limit}". Must be an integer.`);
  }
  if (limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new Error(`Limit out of range: ${limit}. Must be ${MIN_LIMIT}-${MAX_LIMIT}.`);
  }
  return limit;
}
