/**
 * formiga-agent-tools — Pi Extension
 *
 * Exposes 4 tools that persist agent output to the Formiga dashboard:
 *   - save_artifact       Store structured JSON (EDA reports, features, model configs)
 *   - log_decision        Record a significant choice for audit/explainability
 *   - report_metric       Emit a numeric metric (CV score, timings, counts)
 *   - query_leaderboard   Read the current competition state
 *
 * All writes go through the Formiga dashboard HTTP API using env vars
 * (FORMIGA_API_URL / RUN_ID / STEP_ID / AGENT_ID) injected by the
 * scheduler. Reads (query_leaderboard) hit the same API synchronously.
 *
 * Failure mode: tool calls return a text error to the LLM but never crash
 * the pi session. Persistence errors are surfaced so the agent can decide
 * whether to retry.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { readContext, saveArtifact, queryLeaderboard } from "./http-client.ts";
import {
  validateSaveArtifact,
  validateLogDecision,
  validateReportMetric,
  validateQueryLeaderboard,
  VALID_DECISION_TYPES,
  type SaveArtifactArgs,
  type LogDecisionArgs,
  type ReportMetricArgs,
  type QueryLeaderboardArgs,
} from "./validation.ts";
import { formatLeaderboard, truncateForDisplay } from "./formatters.ts";

// ── TypeBox schemas (JSON-schema-level validation for pi) ────────────

const SaveArtifactParams = Type.Object({
  key: Type.String({
    description:
      "Artifact identifier. Lowercase letters/digits/underscore only, must start with a letter (e.g. 'eda_report', 'features_metadata', 'arena_report').",
  }),
  data: Type.Object(
    {},
    {
      description:
        "Structured JSON content to persist. Max 500KB serialized.",
      additionalProperties: true,
    },
  ),
});

const LogDecisionParams = Type.Object({
  decision_type: Type.Union(VALID_DECISION_TYPES.map((v) => Type.Literal(v)), {
    description: "Category of decision.",
  }),
  description: Type.String({
    description: "One-sentence description of the decision (max 500 chars).",
  }),
  reasoning: Type.Optional(
    Type.String({
      description: "Explanation of why this decision was made (max 1000 chars).",
    }),
  ),
  alternatives_considered: Type.Optional(
    Type.Array(Type.String(), {
      description: "Options considered but not chosen (max 10 entries).",
    }),
  ),
});

const ReportMetricParams = Type.Object({
  name: Type.String({
    description:
      "Metric name. Lowercase letters/digits/underscore only, must start with a letter (e.g. 'cv_mean', 'train_time_seconds').",
  }),
  value: Type.Number({
    description: "Metric value. Must be a finite number.",
  }),
  tags: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Optional string-valued tags for filtering (max 10 entries).",
    }),
  ),
});

const QueryLeaderboardParams = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: "Number of top entries to return (default: 5, max: 50).",
      minimum: 1,
      maximum: 50,
    }),
  ),
});

// ── Tool result helpers ──────────────────────────────────────────────

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}

function ok(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text }], details };
}

function err(text: string, details: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: `Error: ${text}` }], details: { ...details, error: true } };
}

// ── Extension entry point ────────────────────────────────────────────

export default function formigaAgentToolsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "save_artifact",
    label: "Save Artifact",
    description:
      "Persist a structured JSON artifact to the Formiga dashboard. Use for EDA reports, feature metadata, model configs, benchmark configs, and final reports. Prefer over writing to disk when the dashboard should see the data.",
    promptSnippet: "Persist structured JSON to Formiga dashboard.",
    promptGuidelines: [
      "Use save_artifact to make agent output visible in the dashboard (do NOT use bash/curl for this).",
      "Choose a stable key that matches downstream expectations (e.g. eda_report, eda_config, features_metadata, baseline_submission, arena_report).",
      "Content must be a JSON object; keep it below 500KB after serialization.",
    ],
    parameters: SaveArtifactParams,

    async execute(_toolCallId, params: SaveArtifactArgs, signal): Promise<ToolResult> {
      try {
        validateSaveArtifact(params);
      } catch (e) {
        return err(errorMessage(e));
      }

      const ctx = readContext();
      const size = JSON.stringify(params.data).length;

      try {
        const result = await saveArtifact(ctx, params.key, params.data, { signal });
        return ok(
          `Saved artifact "${params.key}" (${formatBytes(size)}, id=${result.id}).`,
          { artifactKey: params.key, artifactId: result.id, sizeBytes: size },
        );
      } catch (e) {
        return err(
          `Failed to save artifact "${params.key}": ${truncateForDisplay(errorMessage(e), 300)}`,
          { artifactKey: params.key },
        );
      }
    },
  });

  pi.registerTool({
    name: "log_decision",
    label: "Log Decision",
    description:
      "Record a significant decision (model selection, feature drop, hyperparameter choice, early stop, error recovery) for audit and explainability. Stored as an artifact and visible on the dashboard.",
    promptSnippet: "Record an important decision (audit trail).",
    promptGuidelines: [
      "Call log_decision whenever you make a choice that materially affects the pipeline (which model to keep, which feature to drop, when to stop).",
      "Include a short description AND reasoning — the audit view uses both.",
      "Prefer this over free-form comments in the response.",
    ],
    parameters: LogDecisionParams,

    async execute(_toolCallId, params: LogDecisionArgs, signal): Promise<ToolResult> {
      try {
        validateLogDecision(params);
      } catch (e) {
        return err(errorMessage(e));
      }

      const ctx = readContext();
      const record = {
        timestamp: new Date().toISOString(),
        decision_type: params.decision_type,
        description: params.description,
        reasoning: params.reasoning ?? null,
        alternatives_considered: params.alternatives_considered ?? [],
        agent_id: ctx.agentId,
        step_id: ctx.stepId,
      };

      try {
        // Append-style: each call overwrites `latest_decision` (dashboard reads history via artifact log)
        await saveArtifact(ctx, "agent_decisions", {
          latest_decision: record,
          logged_at: record.timestamp,
        }, { signal });
        return ok(
          `Logged decision [${params.decision_type}]: ${truncateForDisplay(params.description, 80)}`,
          { decisionType: params.decision_type },
        );
      } catch (e) {
        return err(
          `Failed to log decision: ${truncateForDisplay(errorMessage(e), 300)}`,
          { decisionType: params.decision_type },
        );
      }
    },
  });

  pi.registerTool({
    name: "report_metric",
    label: "Report Metric",
    description:
      "Report a numeric metric (CV score, training time, feature count, etc.) for visualization on the dashboard. Values are stored as artifacts keyed by `metric_<name>`.",
    promptSnippet: "Report a numeric metric to the dashboard.",
    promptGuidelines: [
      "Call report_metric for the primary evaluation metric of every model you evaluate (name: cv_mean, train_rmse, etc.).",
      "Add tags to distinguish variants (e.g. tags: { model: 'xgboost', fold: '3' }).",
      "Use report_metric — not save_artifact — for numeric time-series data.",
    ],
    parameters: ReportMetricParams,

    async execute(_toolCallId, params: ReportMetricArgs, signal): Promise<ToolResult> {
      try {
        validateReportMetric(params);
      } catch (e) {
        return err(errorMessage(e));
      }

      const ctx = readContext();
      const record = {
        name: params.name,
        value: params.value,
        tags: params.tags ?? {},
        timestamp: new Date().toISOString(),
        agent_id: ctx.agentId,
        step_id: ctx.stepId,
      };

      try {
        await saveArtifact(ctx, `metric_${params.name}`, record, { signal });
        const tagStr = params.tags && Object.keys(params.tags).length > 0
          ? ` [${Object.entries(params.tags).map(([k, v]) => `${k}=${v}`).join(", ")}]`
          : "";
        return ok(`Reported metric: ${params.name}=${params.value}${tagStr}`, {
          metric: params.name,
          value: params.value,
        });
      } catch (e) {
        return err(
          `Failed to report metric "${params.name}": ${truncateForDisplay(errorMessage(e), 300)}`,
          { metric: params.name },
        );
      }
    },
  });

  pi.registerTool({
    name: "query_leaderboard",
    label: "Query Leaderboard",
    description:
      "Read the current competition leaderboard for this run — model type, agent, CV metric, train metric, round. Use before selecting a new modeling approach to see what's already worked.",
    promptSnippet: "Read the current competition leaderboard.",
    promptGuidelines: [
      "Call query_leaderboard at the start of an arena round to inform your model choice.",
      "The returned entries are ordered best-first by validation metric.",
      "Prefer this over parsing artifact logs manually.",
    ],
    parameters: QueryLeaderboardParams,

    async execute(_toolCallId, params: QueryLeaderboardArgs, signal): Promise<ToolResult> {
      let limit: number;
      try {
        limit = validateQueryLeaderboard(params ?? {});
      } catch (e) {
        return err(errorMessage(e));
      }

      const ctx = readContext();
      try {
        const entries = await queryLeaderboard(ctx, limit, { signal });
        return ok(formatLeaderboard(entries), { count: entries.length });
      } catch (e) {
        return err(
          `Failed to query leaderboard: ${truncateForDisplay(errorMessage(e), 300)}`,
        );
      }
    },
  });
}

// ── Small helpers ────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  return `${(kb / 1024).toFixed(2)}MB`;
}
