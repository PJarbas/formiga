// ══════════════════════════════════════════════════════════════════════
// prompts.ts — Builders for agent-facing pi/hermes prompts
// ══════════════════════════════════════════════════════════════════════
//
// Two prompt styles:
//   - `buildAgentPrompt` / `buildWorkPrompt` — single-shot (already
//     claimed or about to claim a known step). Used by agent-cron.
//   - `buildPollingPrompt` — the script the scheduler hands to `pi --print`
//     every interval. Work discovery is done by the scheduler's pre-check,
//     NOT by the agent, so this prompt goes straight to claim + execute.
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
    `Run: "${cli}" step peek "${agentId}" --run-id "${runId}"`,
    ``,
    `STEP 2 — If NO_WORK:`,
    `Reply HEARTBEAT_OK and stop. Do NOT do anything else.`,
    ``,
    `STEP 3 — If HAS_WORK:`,
    `Claim the step and capture the JSON response:`,
    `Run: "${cli}" step claim "${agentId}" --run-id "${runId}"`,
    `The output will be JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
    `SAVE the stepId — you MUST use it in step 4.`,
    ``,
    `Read the "input" field carefully. It describes the actual work you must do.`,
    `Execute the work using all available tools and capabilities.`,
    ``,
    `STEP 4 — Report results using the SAVED stepId (NOT the agent ID):`,
    `On success: echo 'STATUS: done
CHANGES: <what you changed>
TESTS: <tests you ran>' | "${cli}" step complete "<stepId>"`,
    `On failure: "${cli}" step fail "<stepId>" "<clear reason>"`,
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
TESTS: <tests you ran>' | "${cli}" step complete "<stepId>"`,
    `On failure: "${cli}" step fail "<stepId>" "<reason>"`,
    ``,
    `CRITICAL: You MUST report results. Do not exit without calling step complete or step fail.`,
  ].join("\n");
}

/**
 * Build the polling prompt executed by `pi --print`.
 *
 * Work discovery + claim are NOT done by the agent (RF-2, complete level).
 * The scheduler's pre-check confirms work exists, then `claimStep` claims
 * it atomically and passes `{stepId, input}` here. So when `work` is
 * provided, the agent only executes the work and reports — it never runs
 * `step peek` or `step claim` via the CLI. This removes the class of bugs
 * where a model mistypes the discovery/claim command (run 367d0f4e).
 *
 * When `work` is omitted (legacy/fallback path, or a claim race where the
 * scheduler could not pre-claim), the prompt falls back to instructing the
 * agent to claim via CLI, with a HEARTBEAT_OK escape on NO_WORK.
 */
export async function buildPollingPrompt(
  workflowId: string,
  agentId: string,
  runId: string,
  agentPersonaInstructions = "",
  work?: { stepId: string; input: string },
): Promise<string> {
  const cli = resolveFormigaCli();

  const persona = agentPersonaInstructions.trim();
  const prompt = [
    `You are a polling agent for workflow "${workflowId}", agent "${agentId}", run "${runId}".`,
    `You run in --print mode.`,
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

  if (work) {
    // RF-2 complete: the scheduler already claimed the step. Inject the
    // stepId + resolved input directly; the agent only executes + reports.
    prompt.push(
      ``,
      `─── EXECUTE ASSIGNED WORK ───`,
      `Your step has already been claimed for you. Do NOT run step claim.`,
      ``,
      `STEP ID (save this — you MUST use it to report results):`,
      work.stepId,
      ``,
      `WORK INPUT (the task to execute):`,
      work.input,
      ``,
      `Execute the work above using all available tools and capabilities.`,
      ``,
      `When finished, report using the SAVED STEP ID (NOT the agent ID):`,
      `   - Success: echo 'STATUS: done
CHANGES: <what you did>
TESTS: <tests you ran>' | "${cli}" step complete "${work.stepId}"`,
      `   - Failure: "${cli}" step fail "${work.stepId}" "<clear reason for failure>"`,
    );
  } else {
    // Fallback: scheduler could not pre-claim (race / legacy). Agent
    // claims via CLI, with HEARTBEAT_OK on NO_WORK.
    prompt.push(
      ``,
      `─── CLAIM AND EXECUTE ───`,
      `1. Claim the step and capture the JSON response:`,
      `   "${cli}" step claim "${agentId}" --run-id "${runId}"`,
      `   The output is JSON: {"stepId":"<UUID>", "runId":"<UUID>", "input":"<task description>"}`,
      `   SAVE the stepId — you MUST use it when reporting results.`,
      ``,
      `   If the output is NO_WORK (work was already claimed by another worker):`,
      `     Reply exactly: HEARTBEAT_OK`,
      `     Then STOP. Do not attempt anything else.`,
      ``,
      `2. Read the "input" field carefully. It describes the actual work you must do.`,
      ``,
      `3. Execute the work using all available tools and capabilities.`,
      ``,
      `4. When finished, report using the SAVED stepId (NOT the agent ID):`,
      `   - Success: echo 'STATUS: done
CHANGES: <what you did>
TESTS: <tests you ran>' | "${cli}" step complete "<stepId>"`,
      `   - Failure: "${cli}" step fail "<stepId>" "<clear reason for failure>"`,
    );
  }

  prompt.push(
    ``,
    `─── FORMIGA TOOLS (formiga-agent-tools extension) ───`,
    `The following tools are available for persisting agent output to the Formiga dashboard:`,
    `  - save_artifact({ key, data })    Persist structured JSON (EDA reports, features, model configs)`,
    `  - log_decision({ decision_type, description, reasoning?, alternatives_considered? })`,
    `                                    Record significant choices for audit/explainability`,
    `  - report_metric({ name, value, tags? })    Emit numeric metrics (CV score, timings, counts)`,
    `  - query_leaderboard({ limit? })   Read the current competition leaderboard`,
    ``,
    `USE THESE TOOLS instead of curl for any dashboard write. Read your workspace's AGENTS.md for the`,
    `expected artifact keys and payload shapes. Reading artifacts via HTTP GET is still fine.`,
    ``,
    `─── RULES ───`,
    `- ALWAYS report results. Never exit without calling step complete or step fail.`,
    `- If you cannot complete the work, use step fail — do not hang.`,
    `- Keep responses concise; you are a background agent.`,
    `- If something is unclear, use step fail with an explanation of what is missing.`,
    `- NEVER use curl to WRITE artifacts. Use save_artifact / log_decision / report_metric instead.`,
  );

  return prompt.join("\n");
}
