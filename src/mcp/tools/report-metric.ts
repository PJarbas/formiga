// ══════════════════════════════════════════════════════════════════════
// report-metric.ts — Handler for report_metric MCP tool
// ══════════════════════════════════════════════════════════════════════

import type {
  ToolSchema,
  ToolContext,
  IBackgroundQueue,
  IArtifactService,
} from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

const METRIC_NAME_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_TAGS = 10;

interface ReportMetricArgs {
  name: string;
  value: number;
  tags?: Record<string, string>;
}

/**
 * Handler for report_metric tool.
 * Reports numeric metrics for visualization and tracking.
 */
export class ReportMetricHandler extends BaseToolHandler {
  readonly name = "report_metric";

  readonly schema: ToolSchema = {
    name: "report_metric",
    description:
      "Report a numeric metric for visualization and tracking. Use this to log CV scores, training times, feature counts, etc.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Metric name. Use lowercase letters, numbers, underscores. Examples: cv_mean, train_time_seconds, feature_count",
          pattern: "^[a-z][a-z0-9_]{1,30}$",
        },
        value: {
          type: "number",
          description: "Numeric value of the metric",
        },
        tags: {
          type: "object",
          description: "Optional key-value tags for filtering (max 10)",
          additionalProperties: { type: "string" },
        },
      },
      required: ["name", "value"],
    },
  };

  constructor(
    private readonly artifactService: IArtifactService,
    private readonly queue: IBackgroundQueue,
  ) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { name, value, tags } = args as ReportMetricArgs;

    if (!name || typeof name !== "string") {
      throw new Error("Missing required field: name");
    }

    if (!METRIC_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid metric name: "${name}". Use lowercase letters, numbers, underscores. Start with letter, 2-31 chars.`,
      );
    }

    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Invalid metric value: "${value}". Must be a finite number.`);
    }

    if (tags) {
      if (typeof tags !== "object" || Array.isArray(tags)) {
        throw new Error("Tags must be an object");
      }

      const tagCount = Object.keys(tags).length;
      if (tagCount > MAX_TAGS) {
        throw new Error(`Too many tags: ${tagCount} (max ${MAX_TAGS})`);
      }

      for (const [key, val] of Object.entries(tags)) {
        if (typeof val !== "string") {
          throw new Error(`Tag value for "${key}" must be a string`);
        }
      }
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { name, value, tags } = args as ReportMetricArgs;

    const timestamp = new Date().toISOString();
    const metricRecord = {
      name,
      value,
      tags: tags ?? {},
      timestamp,
      agent_id: context.agentId,
      step_id: context.stepId,
    };

    // Fire-and-forget: save metric as an artifact
    this.queue.enqueue(async () => {
      const artifactKey = `metric_${name}`;
      await this.artifactService.save({
        runId: context.runId,
        stepId: context.stepId,
        agentId: context.agentId,
        artifactKey,
        content: metricRecord,
        contentType: "json",
      });
    });

    const tagStr = tags ? ` [${Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(", ")}]` : "";
    return `Metric reported: ${name}=${value}${tagStr}`;
  }
}
