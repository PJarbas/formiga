// ══════════════════════════════════════════════════════════════════════
// base-handler.ts — Abstract base class for MCP tool handlers
// Uses Template Method pattern for common validation/error handling
// ══════════════════════════════════════════════════════════════════════

import type { IToolHandler, ToolSchema, ToolResult, ToolContext } from "../types.js";

/**
 * Abstract base class for tool handlers.
 *
 * Implements Template Method pattern:
 * - handle() provides common error handling wrapper
 * - Subclasses implement validateArgs() and execute()
 */
export abstract class BaseToolHandler implements IToolHandler {
  abstract readonly name: string;
  abstract readonly schema: ToolSchema;

  /**
   * Main entry point. Wraps validation and execution with error handling.
   */
  async handle(args: unknown, context: ToolContext): Promise<ToolResult> {
    try {
      this.validateArgs(args);
      const result = await this.execute(args, context);

      return {
        content: [{ type: "text", text: result }],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  }

  /**
   * Validate input arguments. Throw on invalid input.
   * @param args Raw arguments from tool call
   */
  protected abstract validateArgs(args: unknown): void;

  /**
   * Execute the tool logic.
   * @param args Validated arguments
   * @param context Tool execution context (runId, stepId, agentId)
   * @returns Result message to return to the LLM
   */
  protected abstract execute(args: unknown, context: ToolContext): Promise<string>;

  /**
   * Helper to create a success result
   */
  protected success(message: string): ToolResult {
    return {
      content: [{ type: "text", text: message }],
    };
  }

  /**
   * Helper to create an error result
   */
  protected error(message: string): ToolResult {
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
}
