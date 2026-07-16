// ══════════════════════════════════════════════════════════════════════
// sidecar-schema.ts — Validation schema for agent submission sidecar JSON
// Uses the project's built-in validateSchema (no Zod dependency needed)
// ══════════════════════════════════════════════════════════════════════

import { validateSchema, type ValidationError } from "../shared/schemas.js";

// Rich metric keys (all optional)
const RICH_METRIC_PROPERTIES: Record<string, { type: "number" }> = {
  f1_score:     { type: "number" },
  precision:    { type: "number" },
  recall:       { type: "number" },
  roc_auc:      { type: "number" },
  log_loss:     { type: "number" },
  mae:          { type: "number" },
  rmse:         { type: "number" },
  r2_score:     { type: "number" },
};

export const SUBMISSION_SIDECAR_SCHEMA = {
  type: "object",
  required: ["model_type", "cv_mean", "train_mean", "artifact_path"],
  properties: {
    model_type:         { type: "string", minLength: 1 },
    model_algorithm:    { type: "string", minLength: 1 },
    cv_mean:            { type: "number" },
    train_mean:         { type: "number" },
    cv_std:             { type: "number", minimum: 0 },
    hyperparameters:    { type: "object" },
    artifact_path:      { type: "string", minLength: 1 },
    metric_name:        { type: "string", minLength: 1 },
    train_time_seconds: { type: "number", minimum: 0 },
    problem_type:       { type: "string", enum: ["classification", "regression", "multilabel"] },
    ...RICH_METRIC_PROPERTIES,
  },
} as const;

export interface SubmissionSidecar {
  model_type: string;
  model_algorithm?: string;
  cv_mean: number;
  train_mean: number;
  cv_std?: number;
  hyperparameters?: Record<string, unknown>;
  artifact_path: string;
  metric_name?: string;
  train_time_seconds?: number;
  problem_type?: "classification" | "regression" | "multilabel";
  f1_score?: number;
  precision?: number;
  recall?: number;
  roc_auc?: number;
  log_loss?: number;
  mae?: number;
  rmse?: number;
  r2_score?: number;
}

export interface SidecarValidationResult {
  valid: boolean;
  data: SubmissionSidecar | null;
  errors: ValidationError[];
}

/** Validate and parse a sidecar JSON object. Returns null on failure. */
export function validateSubmissionSidecar(raw: unknown): SidecarValidationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { valid: false, data: null, errors: [{ field: "$", message: "root must be an object" }] };
  }

  const errors = validateSchema(raw, SUBMISSION_SIDECAR_SCHEMA);
  if (errors.length > 0) {
    return { valid: false, data: null, errors };
  }

  const obj = raw as Record<string, unknown>;
  const data: SubmissionSidecar = {
    model_type: String(obj.model_type),
    cv_mean: Number(obj.cv_mean),
    train_mean: Number(obj.train_mean),
    artifact_path: String(obj.artifact_path),
    cv_std: obj.cv_std !== undefined ? Number(obj.cv_std) : undefined,
    hyperparameters: obj.hyperparameters as Record<string, unknown> | undefined,
    metric_name: obj.metric_name !== undefined ? String(obj.metric_name) : undefined,
    train_time_seconds: obj.train_time_seconds !== undefined ? Number(obj.train_time_seconds) : undefined,
  };

  return { valid: true, data, errors: [] };
}