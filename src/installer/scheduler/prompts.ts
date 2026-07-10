// ══════════════════════════════════════════════════════════════════════
// prompts.ts — Builders for agent-facing pi/hermes prompts
// ══════════════════════════════════════════════════════════════════════
//
// Two prompt styles:
//   - `buildAgentPrompt` / `buildWorkPrompt` — single-shot (already
//     claimed or about to claim a known step). Used by agent-cron.
//   - `buildPollingPrompt` — the two-phase script the scheduler hands to
//     `pi --print` every interval: phase 1 peeks, phase 2 claims+executes.
//
// `buildAgentPersonaInstructions` lifts AGENTS.md / IDENTITY.md / SOUL.md
// out of the agent's workspace and embeds them as persona context.
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { resolveFormigaCli, resolveWorkflowWorkspaceDir } from "../paths.js";
import { AGENT_PERSONA_FILES } from "./shared.js";
import { getUnreadMessagesHeader } from "../message-ops.js";

// ── Persona file loading ───────────────────────────────────────────────

async function readOptionalPersonaFile(
  workspaceDir: string,
  fileName: typeof AGENT_PERSONA_FILES[number],
): Promise<string | null> {
  const filePath = path.join(workspaceDir, fileName);
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const trimmed = content.trim();
    if (trimmed.length === 0) return null;
    return content.trimEnd();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return null;
    throw err;
  }
}

export async function buildAgentPersonaInstructions(agentId: string): Promise<string> {
  const workspaceDir = resolveWorkflowWorkspaceDir(agentId);
  const sections: string[] = [];

  for (const fileName of AGENT_PERSONA_FILES) {
    const content = await readOptionalPersonaFile(workspaceDir, fileName);
    if (!content) continue;
    sections.push(`### ${fileName}\n\n${content}`);
  }

  if (sections.length === 0) return "";

  return [
    "The following files are the provisioned Formiga persona instructions for this workflow agent.",
    "Follow them when executing claimed work. Repository-level instructions from the harness working directory still apply for repository-specific conventions.",
    "",
    ...sections,
  ].join("\n\n");
}

// ── Prompt builders ────────────────────────────────────────────────────

/**
 * Build the prompt an agent gets to check for and execute work.
 *
 * @param workflowId – the workflow this agent serves
 * @param agentId    – the agent's ID
 * @param runId      – run-scoped polling: passed to `step peek` / `step claim`
 *                     via `--run-id` so the CLI only matches steps in this run
 */
export function buildAgentPrompt(workflowId: string, agentId: string, runId: string): string {
  const cli = resolveFormigaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}" (run ${runId}).`,
    ``,
    `Your job is to poll for work and execute it.`,
    ``,
    `STEP 1 — Check for pending work:`,
    `Run: node "${cli}" step peek "${agentId}" --run-id "${runId}"`,
    ``,
    `STEP 2 — If NO_WORK:`,
    `Reply HEARTBEAT_OK and stop. Do NOT do anything else.`,
    ``,
    `STEP 3 — If HAS_WORK:`,
    `Claim the step and capture the JSON response:`,
    `Run: node "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `The output will be JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `SAVE the stepId — you MUST use it in step 4.`,
    ``,
    `Read the "input" field carefully. It describes the actual work you must do.`,
    `Execute the work using all available tools and capabilities.`,
    ``,
    `STEP 4 — Report results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<clear reason>"`,
    ``,
    `CRITICAL: You MUST report results using the step complete or step fail commands.`,
    `Failing to report will leave the workflow stuck forever. Always report, even if you`,
    `could not complete the work — use step fail with a clear reason.`,
  ].join("\n");
}

/**
 * Build the work prompt for when work was already claimed.
 * Does NOT include step claim — just work execution instructions.
 */
export function buildWorkPrompt(workflowId: string, agentId: string, runId: string): string {
  const cli = resolveFormigaCli();

  return [
    `You are agent "${agentId}" in workflow "${workflowId}" (run ${runId}).`,
    `You have already claimed this step. Now execute the work.`,
    ``,
    `The claimed step JSON contains a "stepId" field. You MUST save this and use it`,
    `when reporting results.`,
    ``,
    `Work instructions are in the "input" field. Execute them thoroughly.`,
    ``,
    `When done, report your results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `On failure: node "${cli}" step fail "<stepId>" "<reason>"`,
    ``,
    `CRITICAL: You MUST report results. Do not exit without calling step complete or step fail.`,
  ].join("\n");
}

/**
 * Build the polling prompt — a two-phase script executed by `pi --print`.
 *
 * Phase 1 (cheap): peek for work. If none → HEARTBEAT_OK.
 * Phase 2 (work):   if work exists, claim it and execute.
 *
 * Both peek + claim are scoped to a specific runId so concurrent runs of
 * the same workflow can't cross-claim each other's steps.
 */
export async function buildPollingPrompt(
  workflowId: string,
  agentId: string,
  runId: string,
  agentPersonaInstructions = "",
): Promise<string> {
  const cli = resolveFormigaCli();

  const persona = agentPersonaInstructions.trim();
  const prompt = [
    `You are a polling agent for workflow "${workflowId}", agent "${agentId}", run "${runId}".`,
    `You run in --print mode. Your goal: check for work and execute it if present.`,
  ];

  if (persona.length > 0) {
    prompt.push(
      ``,
      `─── PROVISIONED AGENT PERSONA ───`,
      persona,
      `─── END PROVISIONED AGENT PERSONA ───`,
    );
  }

  // Inject unread messages from other agents (non-blocking)
  try {
    const messagesHeader = await getUnreadMessagesHeader(agentId, runId);
    if (messagesHeader) {
      prompt.push(messagesHeader);
    }
  } catch (err) {
    // Message injection is best-effort — never block polling
  }

  prompt.push(
    ``,
    `─── PHASE 1: PEEK ───`,
    `Run this exact command and capture its output:`,
    `node "${cli}" step peek "${agentId}" --run-id "${runId}"`,
    ``,
    `If the output contains NO_WORK:`,
    `  Reply exactly: HEARTBEAT_OK`,
    `  Then STOP. Do not proceed to PHASE 2.`,
    ``,
    `If the output contains HAS_WORK:`,
    `  Proceed to PHASE 2.`,
    ``,
    `─── PHASE 2: CLAIM AND EXECUTE ───`,
    `1. Claim the step and capture the JSON response:`,
    `   node "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `   The output is JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `   SAVE the stepId — you MUST use it when reporting results.`,
    ``,
    `2. Read the "input" field carefully. It describes the actual work you must do.`,
    ``,
    `3. Execute the work using all available tools and capabilities.`,
    ``,
    `4. When finished, report using the SAVED stepId (NOT the agent ID):`,
    `   - Success: echo 'STATUS: done
CHANGES: <what you did>
TESTS: <tests you ran>' | node "${cli}" step complete "<stepId>"`,
    `   - Failure: node "${cli}" step fail "<stepId>" "<clear reason for failure>"`,
    ``,
    `─── RULES ───`,
    `- ALWAYS report results. Never exit without calling step complete or step fail.`,
    `- If you cannot complete the work, use step fail — do not hang.`,
    `- Keep responses concise; you are a background agent.`,
    `- If something is unclear, use step fail with an explanation of what is missing.`,
  );

  return prompt.join("\n");
}
