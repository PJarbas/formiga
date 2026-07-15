/**
 * formatters.ts — Human-readable formatters for tool results
 *
 * Tool results are text shown back to the LLM. Keep them compact so they
 * don't blow up the context window on every call.
 */

import type { LeaderboardEntry } from "./http-client.ts";

export function formatLeaderboard(entries: LeaderboardEntry[]): string {
  if (entries.length === 0) {
    return "Leaderboard is empty. No experiments registered yet.";
  }

  const lines = entries.map((e, i) => {
    const rank = i + 1;
    const cv = pickMetric(e.cvMean, e.valMetric);
    const train = pickMetric(e.trainMean, e.trainMetric);
    const gap = cv !== null && train !== null ? (train - cv).toFixed(4) : "n/a";
    const cvStr = cv !== null ? cv.toFixed(4) : "n/a";
    const trainStr = train !== null ? train.toFixed(4) : "n/a";
    return `${rank}. ${e.modelType} (${e.agentName}) — CV: ${cvStr}, Train: ${trainStr}, Gap: ${gap}, R${e.roundNumber}`;
  });

  return `Top ${entries.length} experiments:\n${lines.join("\n")}`;
}

function pickMetric(a: number | undefined, b: number | undefined): number | null {
  if (typeof a === "number" && Number.isFinite(a)) return a;
  if (typeof b === "number" && Number.isFinite(b)) return b;
  return null;
}

export function truncateForDisplay(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}
