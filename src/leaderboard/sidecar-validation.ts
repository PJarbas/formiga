// ══════════════════════════════════════════════════════════════════════
// sidecar-validation.ts — Lightweight schema validation for modeler sidecar JSON
// (submitted alongside pi stdout to survive report-tool normalization)
// ══════════════════════════════════════════════════════════════════════

import path from "node:path";
import fs from "node:fs";

/** Agents whose sidecar JSON is validated before step completion is accepted. */
export const SIDECAR_VALIDATED_AGENT_SUFFIXES = [
  "feature-engineer",
  "modeler-classic",
  "modeler-advanced",
];

export function agentRequiresSidecar(agentId: string): boolean {
  return SIDECAR_VALIDATED_AGENT_SUFFIXES.some(
    (suffix) => agentId === suffix || agentId.endsWith(`_${suffix}`),
  );
}

export interface SidecarValidationError {
  valid: false;
  error: string;
  path: string;
}

export interface SidecarValidationSuccess {
  valid: true;
  modelType: string;
  cvMean: number;
  trainMean: number;
  artifactPath: string;
  metricName?: string;
  hyperparameters?: Record<string, unknown>;
}

export type SidecarValidationResult = SidecarValidationError | SidecarValidationSuccess;

function parseNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Read and validate the sidecar JSON for modeler agents.
 */
export function validateSidecar(agentId: string, workspace?: string): SidecarValidationResult {
  if (!workspace) {
    return { valid: false, error: "Missing workspace for sidecar lookup", path: "" };
  }
  if (!agentRequiresSidecar(agentId)) {
    return { valid: false, error: "Agent does not require sidecar", path: "" };
  }

  // Resolve bare suffix to build filename
  const suffix = SIDECAR_VALIDATED_AGENT_SUFFIXES.find(
    (s) => agentId === s || agentId.endsWith(`_${s}`),
  );
  if (!suffix) {
    return { valid: false, error: "Agent does not require sidecar", path: "" };
  }

  const candidate = path.join(workspace, "artifacts", `${suffix}_submission.json`);
  let raw: string;
  try {
    raw = fs.readFileSync(candidate, "utf-8");
  } catch {
    return { valid: false, error: "Sidecar file not found", path: candidate };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { valid: false, error: `Malformed JSON: ${(err as Error).message}`, path: candidate };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { valid: false, error: "Sidecar must be a JSON object", path: candidate };
  }

  const obj = parsed as Record<string, unknown>;

  const modelType = obj["model_type"];
  if (!modelType || typeof modelType !== "string" || modelType.trim().length === 0) {
    return { valid: false, error: "Missing or invalid 'model_type'", path: candidate };
  }

  const cvMean = parseNumeric(obj["cv_mean"]);
  if (cvMean === null) {
    return { valid: false, error: "Missing or invalid 'cv_mean'", path: candidate };
  }

  const trainMean = parseNumeric(obj["train_mean"]);
  if (trainMean === null) {
    return { valid: false, error: "Missing or invalid 'train_mean'", path: candidate };
  }

  const artifactPath = obj["artifact_path"];
  if (!artifactPath || typeof artifactPath !== "string" || artifactPath.trim().length === 0) {
    return { valid: false, error: "Missing or invalid 'artifact_path'", path: candidate };
  }

  const result: SidecarValidationSuccess = {
    valid: true,
    modelType: modelType.trim(),
    cvMean,
    trainMean,
    artifactPath: artifactPath.trim(),
    metricName: typeof obj["metric_name"] === "string" && obj["metric_name"].trim().length > 0
      ? obj["metric_name"].trim()
      : undefined,
  };

  const hp = obj["hyperparameters"];
  if (hp && typeof hp === "object" && !Array.isArray(hp)) {
    result.hyperparameters = hp as Record<string, unknown>;
  }

  return result;
}
