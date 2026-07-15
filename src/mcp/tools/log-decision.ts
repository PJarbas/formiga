// ══════════════════════════════════════════════════════════════════════
// log-decision.ts — Handler for log_decision MCP tool
// ══════════════════════════════════════════════════════════════════════

import type {
  ToolSchema,
  ToolContext,
  IBackgroundQueue,
  DecisionType,
  IArtifactService,
} from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

const VALID_DECISION_TYPES: DecisionType[] = [
  "model_selection",
  "feature_drop",
  "hyperparameter",
  "early_stop",
  "error_recovery",
];

const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REASONING_LENGTH = 1000;
const MAX_ALTERNATIVES = 10;

interface LogDecisionArgs {
  decision_type: DecisionType;
  description: string;
  reasoning?: string;
  alternatives_considered?: string[];
}

/**
 * Handler for log_decision tool.
 * Logs important decisions for audit trail and explainability.
 */
export class LogDecisionHandler extends BaseToolHandler {
  readonly name = "log_decision";

  readonly schema: ToolSchema = {
    name: "log_decision",
    description:
      "Log an important decision for audit trail and explainability. Use this when making significant choices like model selection, feature dropping, or hyperparameter tuning.",
    inputSchema: {
      type: "object",
      properties: {
        decision_type: {
          type: "string",
          description: "Type of decision being made",
          enum: VALID_DECISION_TYPES,
        },
        description: {
          type: "string",
          description: "Brief description of the decision (max 500 chars)",
          maxLength: MAX_DESCRIPTION_LENGTH,
        },
        reasoning: {
          type: "string",
          description: "Explanation of why this decision was made (max 1000 chars)",
          maxLength: MAX_REASONING_LENGTH,
        },
        alternatives_considered: {
          type: "array",
          description: "Other options that were considered (max 10)",
          items: { type: "string", maxLength: 200 },
          maxItems: MAX_ALTERNATIVES,
        },
      },
      required: ["decision_type", "description"],
    },
  };

  constructor(
    private readonly artifactService: IArtifactService,
    private readonly queue: IBackgroundQueue,
  ) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { decision_type, description, reasoning, alternatives_considered } =
      args as LogDecisionArgs;

    if (!decision_type || !VALID_DECISION_TYPES.includes(decision_type)) {
      throw new Error(
        `Invalid decision_type: "${decision_type}". Must be one of: ${VALID_DECISION_TYPES.join(", ")}`,
      );
    }

    if (!description || typeof description !== "string") {
      throw new Error("Missing required field: description");
    }

    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(
        `Description too long: ${description.length} chars (max ${MAX_DESCRIPTION_LENGTH})`,
      );
    }

    if (reasoning && reasoning.length > MAX_REASONING_LENGTH) {
      throw new Error(
        `Reasoning too long: ${reasoning.length} chars (max ${MAX_REASONING_LENGTH})`,
      );
    }

    if (alternatives_considered) {
      if (!Array.isArray(alternatives_considered)) {
        throw new Error("alternatives_considered must be an array");
      }
      if (alternatives_considered.length > MAX_ALTERNATIVES) {
        throw new Error(
          `Too many alternatives: ${alternatives_considered.length} (max ${MAX_ALTERNATIVES})`,
        );
      }
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { decision_type, description, reasoning, alternatives_considered } =
      args as LogDecisionArgs;

    const timestamp = new Date().toISOString();
    const decisionRecord = {
      timestamp,
      decision_type,
      description,
      reasoning: reasoning ?? null,
      alternatives_considered: alternatives_considered ?? [],
      agent_id: context.agentId,
      step_id: context.stepId,
    };

    // Fire-and-forget: save decision as an artifact
    this.queue.enqueue(async () => {
      // Get existing decisions or create new array
      const artifactKey = "agent_decisions";
      await this.artifactService.save({
        runId: context.runId,
        stepId: context.stepId,
        agentId: context.agentId,
        artifactKey,
        content: {
          latest_decision: decisionRecord,
          logged_at: timestamp,
        },
        contentType: "json",
      });
    });

    return `Decision logged: [${decision_type}] ${description.slice(0, 50)}${description.length > 50 ? "..." : ""}`;
  }
}
