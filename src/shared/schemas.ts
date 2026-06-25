// ══════════════════════════════════════════════════════════════════════
// schemas.ts — JSON schemas and validators for agent results
// ══════════════════════════════════════════════════════════════════════

// ── Agent Result Schema ──────────────────────────────────────────────

export const AGENT_RESULT_SCHEMA = {
  type: "object",
  required: [
    "status", "modelId", "modelType", "hyperparameters",
    "cvMean", "cvStd", "cvScores", "trainMean", "trainValGap", "artifactPath",
  ],
  properties: {
    status: { type: "string", enum: ["SUCCESS", "FAILED"] },
    modelId: { type: "string", minLength: 1 },
    modelType: { type: "string", minLength: 1 },
    hyperparameters: { type: "object" },
    cvMean: { type: "number" },
    cvStd: { type: "number", minimum: 0 },
    cvScores: { type: "array", items: { type: "number" }, minItems: 1 },
    trainMean: { type: "number" },
    trainValGap: { type: "number", minimum: 0 },
    artifactPath: { type: "string", minLength: 1 },
    secondaryMetrics: { type: "object" },
    trainTimeSeconds: { type: "number", minimum: 0 },
    inferenceTimeMsPer1k: { type: "number", minimum: 0 },
    featureImportancesTop10: {
      type: "array",
      maxItems: 10,
      items: {
        type: "array",
        items: [{ type: "string" }, { type: "number" }],
        minItems: 2,
        maxItems: 2,
      },
    },
    errorMessage: { type: "string" },
  },
} as const;

// ── Simple schema validator (no external lib) ────────────────────────

interface SchemaProp {
  type: string;
  enum?: readonly string[];
  minimum?: number;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaProp;
}

interface Schema {
  type: string;
  required?: readonly string[];
  properties?: Record<string, SchemaProp>;
}

export interface ValidationError {
  field: string;
  message: string;
}

function checkProp(value: unknown, schema: SchemaProp, field: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (value === undefined || value === null) {
    return errors; // required check is separate
  }

  if (schema.type === "string" && typeof value !== "string") {
    errors.push({ field, message: `expected string, got ${typeof value}` });
    return errors;
  }

  if (schema.type === "number" && typeof value !== "number") {
    errors.push({ field, message: `expected number, got ${typeof value}` });
    return errors;
  }

  if (schema.type === "object" && (typeof value !== "object" || Array.isArray(value))) {
    errors.push({ field, message: `expected object, got ${typeof value}` });
    return errors;
  }

  if (schema.type === "array" && !Array.isArray(value)) {
    errors.push({ field, message: `expected array, got ${typeof value}` });
    return errors;
  }

  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ field, message: `string too short (min ${schema.minLength})` });
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push({ field, message: `invalid value "${value}", expected one of: ${schema.enum.join(", ")}` });
    }
  }

  if (schema.type === "number" && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ field, message: `value ${value} below minimum ${schema.minimum}` });
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ field, message: `array too short (min ${schema.minItems} items)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ field, message: `array too long (max ${schema.maxItems} items)` });
    }
  }

  return errors;
}

/** Validate an object against a simple JSON schema. Returns array of validation errors (empty = valid). */
export function validateSchema(obj: unknown, schema: Schema): ValidationError[] {
  const errors: ValidationError[] = [];

  if (schema.type !== "object" || typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    errors.push({ field: "$", message: "root value must be an object" });
    return errors;
  }

  const record = obj as Record<string, unknown>;

  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in record) || record[req] === undefined || record[req] === null) {
        errors.push({ field: req, message: "required field missing" });
      }
    }
  }

  if (schema.properties) {
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (key in record && record[key] !== undefined && record[key] !== null) {
        errors.push(...checkProp(record[key], prop, key));
      }
    }
  }

  return errors;
}
