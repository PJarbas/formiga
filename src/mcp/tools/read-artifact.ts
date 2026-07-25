// ══════════════════════════════════════════════════════════════════════
// read-artifact.ts — Handler for read_artifact MCP tool
// ══════════════════════════════════════════════════════════════════════

import type { ToolSchema, ToolContext, IArtifactService } from "../types.js";
import { BaseToolHandler } from "./base-handler.js";

const ARTIFACT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;

interface ReadArtifactArgs {
  key?: string;
}

/**
 * Handler for read_artifact tool — the read counterpart to save_artifact.
 *
 * Symmetric to save_artifact: agents use this to read upstream artifacts
 * (EDA report, features report, benchmark config, modeler reports) instead
 * of hand-rolling `curl ... | jq` against the dashboard API.
 *
 * - With `key`: returns the full JSON content of that artifact.
 * - Without `key`: lists all artifact keys for the current run (newest first)
 *   so the agent can discover what's available.
 *
 * Synchronous (not fire-and-forget) — the agent needs the data to decide.
 */
export class ReadArtifactHandler extends BaseToolHandler {
  readonly name = "read_artifact";

  readonly schema: ToolSchema = {
    name: "read_artifact",
    description:
      "Read a persisted artifact from the Formiga dashboard. Pass `key` to get a specific artifact's " +
      "content (e.g. 'eda_report', 'features_report', 'benchmark_config'), or omit `key` to list all " +
      "available artifact keys for the current run. Use this instead of curl to read upstream artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Artifact key to read (e.g. 'eda_report'). Omit to list all artifacts for the run.",
          pattern: "^[a-z][a-z0-9_]{1,30}$",
        },
      },
    },
  };

  constructor(private readonly artifactService: IArtifactService) {
    super();
  }

  protected validateArgs(args: unknown): void {
    const { key } = (args ?? {}) as ReadArtifactArgs;

    if (key !== undefined) {
      if (typeof key !== "string" || !ARTIFACT_KEY_PATTERN.test(key)) {
        throw new Error(
          `Invalid artifact key format: "${key}". Use lowercase letters, numbers, underscores. Start with letter, 2-31 chars.`,
        );
      }
    }
  }

  protected async execute(args: unknown, context: ToolContext): Promise<string> {
    const { key } = (args ?? {}) as ReadArtifactArgs;

    // List mode: return all artifact keys for the run.
    if (!key) {
      const records = await this.artifactService.listByRun(context.runId);
      if (records.length === 0) {
        return "No artifacts found for this run yet.";
      }
      const lines = records.map(
        (r) => `- ${r.artifactKey} (agent: ${r.agentId}, ${Math.round((r.sizeBytes ?? 0) / 1024)}KB, ${r.createdAt})`,
      );
      return `Artifacts for this run (${records.length}):\n${lines.join("\n")}`;
    }

    // Read mode: return the full content of the requested artifact.
    const record = await this.artifactService.getByKey(context.runId, key);
    if (!record) {
      return `Artifact not found: "${key}". Call read_artifact without a key to list available artifacts.`;
    }

    return JSON.stringify(record.content, null, 2);
  }
}
