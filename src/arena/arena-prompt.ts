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
  if (topN.length === 0) return "(Sem resultados ainda. Seja o primeiro!)";
  const headers = "| Rank | Agente | Modelo | Rodada | Métrica |";
  const sep = "|------|--------|--------|--------|---------|";
  const rows = topN.map((e, idx) => {
    const metricStr = e.val_metric?.toFixed(6) ?? "N/A";
    return `| ${idx + 1} | ${e.agent_name} | ${e.model_type} | ${e.round_number} | ${metricStr} |`;
  });
  return [headers, sep, ...rows].join("\n");
}

function formatMyHistory(attempts: AgentAttempt[]): string {
  if (attempts.length === 0) return "(Nenhuma ainda)\n";
  const headers = "| Rodada | Hipótese | Métrica | Decisão | Aprendizado |";
  const sep = "|--------|----------|---------|---------|-------------|";
  const rows = attempts.map((a) => {
    const metricStr = a.metric !== null ? a.metric.toFixed(6) : "falha";
    const dec = a.decision === "keep" || a.decision === "baseline" ? "manter" : a.decision;
    return `| ${a.round} | ${a.hypothesis.slice(0, 40)} | ${metricStr} | ${dec} | ${(a.learned ?? "").slice(0, 40)} |`;
  });
  return [headers, sep, ...rows].join("\n");
}

function formatOthersInsights(keptResults: AgentRoundResult[]): string {
  if (keptResults.length === 0) return "(Nenhum resultado mantido de outros agentes ainda.)";
  return keptResults
    .map((r) => `- ${r.agentId}: "${r.hypothesis}" → ${r.metric !== null ? r.metric.toFixed(6) : "falha"} (${r.decision})`)
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

  const directionLabel = session.metricDirection === "lower" ? "(menor é melhor)" : "(maior é melhor)";

  let prompt = `## Arena de Competição — Rodada ${round}

Você é **${agent.id}**. Seu objetivo: superar a melhor métrica atual.

**IMPORTANTE**: Todas as suas respostas devem ser em português brasileiro. Isso inclui hipóteses, aprendizados e próximos focos.

`;

  if (datasetCtx) {
    prompt += formatDatasetContextForPrompt(datasetCtx, agent.id);
    prompt += `\n`;
  }

  prompt += `### Leaderboard Atual (Top 10)
${formatLeaderboardTable(topN, session.metricDirection)}

### Suas Tentativas Anteriores
${formatMyHistory(myAttempts)}

### O que Outros Aprenderam (apenas resultados mantidos)
${formatOthersInsights(othersResults)}

### Orientação de Estratégia
${agent.strategyHint}

### Regras
- Produza um script Python que define uma variável \`model\` (estimador compatível com sklearn).
- Salve em: \`artifacts/models/${agent.id}_round${round}.py\`
- Seu modelo será medido pelo benchmark (validação cruzada em folds separados).
- Métrica: ${session.metricName} ${directionLabel}
- Melhor atual: ${session.bestMetric ?? "sem baseline ainda"}
- Meta: ${session.targetMetric ?? "nenhuma (apenas melhorar)"}
- **RESPEITE os limites de complexidade acima.** Violá-los produz modelos com overfitting que serão descartados.

### Formato de Saída
Após gerar o script, finalize sua resposta com:

\`\`\`
HIPOTESE: <descrição de uma linha da sua abordagem, em português>
SCRIPT_PATH: artifacts/models/${agent.id}_round${round}.py
APRENDIZADO: <o que você aprendeu com esta tentativa, em português—preenchido após medição>
PROXIMO_FOCO: <o que você tentará na próxima rodada, em português>
STATUS: done
\`\`\`
`;
  return prompt;
}
