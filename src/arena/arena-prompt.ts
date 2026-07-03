// ══════════════════════════════════════════════════════════════════════
// arena-prompt.ts — Build competitive prompts for arena agents.
// Pure function: only string formatting, no side effects.
// ══════════════════════════════════════════════════════════════════════

import type { ArenaSession, ArenaAgentConfig, AgentRoundResult, MetricDirection } from "./arena-types.js";
import type { ExperimentRow } from "../leaderboard/repository.js";
import { formatDatasetContextForPrompt, type DatasetContext } from "./dataset-context.js";

interface AgentAttempt {
  round: number;
  hypothesis: string;
  metric: number | null;
  decision: string;
  learned: string | null;
}

function formatLeaderboardTable(topN: ExperimentRow[], direction: MetricDirection): string {
  if (topN.length === 0) return "(No results yet. Be first!)";
  const headers = "| Rank | Agent | Model | Round | Metric |";
  const sep = "|------|-------|-------|-------|--------|";
  const rows = topN.map((e, idx) => {
    const metricStr = e.val_metric?.toFixed(6) ?? "N/A";
    return `| ${idx + 1} | ${e.agent_name} | ${e.model_type} | ${e.round_number} | ${metricStr} |`;
  });
  return [headers, sep, ...rows].join("\n");
}

function formatMyHistory(attempts: AgentAttempt[]): string {
  if (attempts.length === 0) return "(None yet)\n";
  const headers = "| Round | Hypothesis | Metric | Decision | Learned |";
  const sep = "|-------|------------|--------|----------|---------|";
  const rows = attempts.map((a) => {
    const metricStr = a.metric !== null ? a.metric.toFixed(6) : "crash";
    const dec = a.decision === "keep" || a.decision === "baseline" ? "keep" : a.decision;
    return `| ${a.round} | ${a.hypothesis.slice(0, 40)} | ${metricStr} | ${dec} | ${(a.learned ?? "").slice(0, 40)} |`;
  });
  return [headers, sep, ...rows].join("\n");
}

function formatOthersInsights(keptResults: AgentRoundResult[]): string {
  if (keptResults.length === 0) return "(No kept results from other agents yet.)";
  return keptResults
    .map((r) => `- ${r.agentId}: "${r.hypothesis}" → ${r.metric !== null ? r.metric.toFixed(6) : "crash"} (${r.decision})`)
    .join("\n");
}

/**
 * Build a competitive prompt for a single agent on a single round.
 *
 * @param session       — current arena session state
 * @param round         — current round number
 * @param agent         — agent configuration
 * @param leaderboard   — current top experiments from the leaderboard
 * @param agentHistory  — this agent's past attempts in this session
 * @param othersResults — other agents' kept results in this session
 * @param datasetCtx    — dataset metadata for complexity-aware prompting
 */
export function buildAgentPrompt(
  session: ArenaSession,
  round: number,
  agent: ArenaAgentConfig,
  leaderboard: ExperimentRow[],
  agentHistory: AgentRoundResult[],
  othersResults: AgentRoundResult[],
  datasetCtx?: DatasetContext,
): string {
  const topN = leaderboard.slice(0, 10);
  const myAttempts: AgentAttempt[] = agentHistory
    .filter((h) => h.agentId === agent.id)
    .map((h) => ({
      round: round - 1,
      hypothesis: h.hypothesis,
      metric: h.metric,
      decision: h.decision,
      learned: h.learned,
    }));

  const directionLabel = session.metricDirection === "lower" ? "(lower is better)" : "(higher is better)";

  let prompt = `## Competition Arena — Round ${round}

You are **${agent.id}**. Your goal: beat the current best metric.

`;

  if (datasetCtx) {
    prompt += formatDatasetContextForPrompt(datasetCtx, agent.id);
    prompt += `\n`;
  }

  prompt += `### Current Leaderboard (Top 10)
${formatLeaderboardTable(topN, session.metricDirection)}

### Your Previous Attempts
${formatMyHistory(myAttempts)}

### What Others Have Learned (kept results only)
${formatOthersInsights(othersResults)}

### Strategy Guidance
${agent.strategyHint}

### Rules
- Produce a Python script that defines a \`model\` variable (sklearn-compatible estimator).
- Save it to: \`artifacts/models/${agent.id}_round${round}.py\`
- Your model will be measured by the benchmark (cross-validation on held-out folds).
- Metric: ${session.metricName} ${directionLabel}
- Current best: ${session.bestMetric ?? "no baseline yet"}
- Target: ${session.targetMetric ?? "none (just improve)"}
- **RESPECT the complexity gates above.** Violating them produces overfit models that get discarded.

### Output Format
After generating the script, end your response with:

\`\`\`
HYPOTHESIS: <one-line description of your approach>
SCRIPT_PATH: artifacts/models/${agent.id}_round${round}.py
LEARNED: <what you learned from this attempt—filled after measurement>
NEXT_FOCUS: <what you will try next round>
STATUS: done
\`\`\`
`;
  return prompt;
}
