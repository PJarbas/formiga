import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowSpec } from "./types.js";

/**
 * Load and parse a workflow.yml file from a workflow directory.
 * Returns a validated WorkflowSpec.
 */
export async function loadWorkflowSpec(
  workflowDir: string,
): Promise<WorkflowSpec> {
  const ymlPath = path.join(workflowDir, "workflow.yml");
  let raw: string;
  try {
    raw = await fs.readFile(ymlPath, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      throw new Error(
        `No workflow.yml found in ${workflowDir}. Expected a workflow specification file.`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse workflow.yml in ${workflowDir}: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(
      `workflow.yml in ${workflowDir} did not parse to an object`,
    );
  }

  const spec = parsed as Record<string, unknown>;

  // Validate required fields
  if (typeof spec.id !== "string" || !spec.id) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: id`);
  }
  if (!Array.isArray(spec.agents) || spec.agents.length === 0) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: agents (must be a non-empty array)`);
  }
  if (!Array.isArray(spec.steps)) {
    throw new Error(`workflow.yml in ${workflowDir} is missing required field: steps (must be an array)`);
  }

  // Validate each agent has required fields
  for (let i = 0; i < spec.agents.length; i++) {
    const agent = spec.agents[i] as Record<string, unknown>;
    if (typeof agent.id !== "string" || !agent.id) {
      throw new Error(
        `workflow.yml agent[${i}] in ${workflowDir} is missing required field: id`,
      );
    }
    if (!agent.workspace || typeof agent.workspace !== "object") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") in ${workflowDir} is missing required field: workspace`,
      );
    }
    const ws = agent.workspace as Record<string, unknown>;
    if (typeof ws.baseDir !== "string") {
      throw new Error(
        `workflow.yml agent[${i}] ("${agent.id}") workspace in ${workflowDir} is missing required field: baseDir`,
      );
    }
  }

  // Validate each step has required fields
  const stepsArr = spec.steps as Array<Record<string, unknown>>;
  for (let i = 0; i < stepsArr.length; i++) {
    const step = stepsArr[i];
    if (typeof step.id !== "string" || !step.id) {
      throw new Error(
        `workflow.yml step[${i}] in ${workflowDir} is missing required field: id`,
      );
    }
    if (typeof step.agent !== "string" || !step.agent) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} is missing required field: agent`,
      );
    }
    if (step.parallel_group !== undefined && typeof step.parallel_group !== "string") {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} has invalid parallel_group: must be a string`,
      );
    }
  }

  // Validate parallel_group steps are contiguous and use a non-empty id.
  // Two groups with the same id separated by a non-group step is rejected
  // because the prev-step filter in claim.ts assumes one contiguous block
  // per group.
  const seenGroups = new Set<string>();
  let currentGroup: string | null = null;
  for (let i = 0; i < stepsArr.length; i++) {
    const step = stepsArr[i];
    const grp = typeof step.parallel_group === "string" ? step.parallel_group : null;
    if (grp !== null && grp.length === 0) {
      throw new Error(
        `workflow.yml step[${i}] ("${step.id}") in ${workflowDir} has empty parallel_group string`,
      );
    }
    if (grp !== currentGroup) {
      if (grp !== null) {
        if (seenGroups.has(grp)) {
          throw new Error(
            `workflow.yml in ${workflowDir} has non-contiguous parallel_group "${grp}" — steps sharing a parallel_group must be adjacent in the steps list`,
          );
        }
        seenGroups.add(grp);
      }
      currentGroup = grp;
    }
  }

  // Validate run.workspace if present
  if (spec.run && typeof spec.run === "object") {
    const runCfg = spec.run as Record<string, unknown>;
    if (runCfg.workspace !== undefined) {
      if (runCfg.workspace !== "direct" && runCfg.workspace !== "worktree") {
        throw new Error(
          `workflow.yml in ${workflowDir} has invalid run.workspace value: ` +
          `"${String(runCfg.workspace)}". Must be "direct" or "worktree".`,
        );
      }
    }
  }

  return spec as unknown as WorkflowSpec;
}
