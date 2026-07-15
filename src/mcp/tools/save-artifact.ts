// ══════════════════════════════════════════════════════════════════════
// save-artifact.ts — Handler for save_artifact MCP tool
// ══════════════════════════════════════════════════════════════════════

import type { ToolSchema, ToolContext, IArtifactService, IBackgroundQueue } from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

const ARTIFACT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const MAX_CONTENT_SIZE = 500 * 1024; // 500KB

interface SaveArtifactArgs {
  key: string;
  data: Record<string, unknown>;
}

/**
 * Handler for save_artifact tool.
 * Saves structured JSON data to the Formiga dashboard.
 */
export class SaveArtifactHandler extends BaseToolHandler {
  readonly name = "save_artifact";

  readonly schema: ToolSchema = {
    name: "save_artifact",
    description:
      "Save structured data to the Formiga dashboard. Use this to persist EDA reports, feature metadata, model configs, and other artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Artifact identifier. Use lowercase letters, numbers, underscores. Examples: eda_report, features_metadata, arena_report",
          pattern: "^[a-z][a-z0-9_]{1,30}$",
        },
        data: {
          type: "object",
          description: "Structured JSON content to save",
        },
      },
      required: ["key", "data"],
    },
  };

  constructor(
    private readonly artifactService: IArtifactService,
    private readonly queue: IBackgroundQueue,
  ) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { key, data } = args as SaveArtifactArgs;

    if (!key || typeof key !== "string") {
      throw new Error("Missing required field: key");
    }

    if (!ARTIFACT_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid artifact key format: "${key}". Use lowercase letters, numbers, underscores. Start with letter, 2-31 chars.`,
      );
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Field 'data' must be a JSON object");
    }

    const contentSize = JSON.stringify(data).length;
    if (contentSize > MAX_CONTENT_SIZE) {
      throw new Error(
        `Artifact data too large: ${Math.round(contentSize / 1024)}KB (max ${MAX_CONTENT_SIZE / 1024}KB)`,
      );
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { key, data } = args as SaveArtifactArgs;
    const contentSize = JSON.stringify(data).length;

    // Fire-and-forget: enqueue and return immediately
    this.queue.enqueue(async () => {
      await this.artifactService.save({
        runId: context.runId,
        stepId: context.stepId,
        agentId: context.agentId,
        artifactKey: key,
        content: data,
        contentType: "json",
        sizeBytes: contentSize,
      });
    });

    return `Artifact "${key}" queued for save (${Math.round(contentSize / 1024)}KB)`;
  }
}
