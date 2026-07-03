import { useState } from "react";
import type { ArenaRoundExperiment } from "@shared/dashboard-types";
import { getStatusConfig } from "../../lib/status-config";

interface AgentStrategyCardsProps {
  rounds: Array<{ round: number; experiments: ArenaRoundExperiment[] }> | undefined;
}

type StrategyView = "hypothesis" | "learned";

export default function AgentStrategyCards({ rounds }: AgentStrategyCardsProps) {
  const [visibleAgents, setVisibleAgents] = useState<Record<string, boolean>>({});
  const [view, setView] = useState<StrategyView>("hypothesis");

  if (!rounds || rounds.length === 0) return null;

  const agents = new Map<string, { latest: ArenaRoundExperiment | null; first: ArenaRoundExperiment | null; kept: number; total: number }>();

  for (const r of rounds) {
    for (const exp of r.experiments) {
      if (!agents.has(exp.agentName)) {
        agents.set(exp.agentName, { latest: null, first: null, kept: 0, total: 0 });
      }
      const a = agents.get(exp.agentName)!;
      a.total += 1;
      if (exp.decision?.toLowerCase() === "keep") a.kept += 1;
      if (!a.first) a.first = exp;
      a.latest = exp;
    }
  }

  function toggleAgent(name: string) {
    setVisibleAgents((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Agent Strategies</h3>
        <div className="flex items-center gap-1 rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-1 py-0.5">
          <button
            type="button"
            onClick={() => setView("hypothesis")}
            className={`text-xs px-2 py-0.5 rounded ${view === "hypothesis" ? "bg-[var(--accent-blue)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
          >
            Hypothesis
          </button>
          <button
            type="button"
            onClick={() => setView("learned")}
            className={`text-xs px-2 py-0.5 rounded ${view === "learned" ? "bg-[var(--accent-blue)] text-white" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}
          >
            Learned
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {Array.from(agents.entries()).map(([name, s]) => {
          const isOpen = visibleAgents[name] ?? true;
          const config = s.latest?.decision ? getStatusConfig(s.latest.decision) : getStatusConfig("idle");
          const text = view === "hypothesis" ? (s.latest?.hypothesis ?? null) : (s.latest?.learned ?? null);
          return (
            <div key={name} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)]">
              <button
                type="button"
                onClick={() => toggleAgent(name)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-primary)]">{name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border ${config.bgClass} ${config.borderClass}`}>
                    {s.kept}/{s.total} kept
                  </span>
                </div>
                <span className="text-xs text-[var(--text-muted)]">{isOpen ? "▼" : "▶"}</span>
              </button>
              {isOpen && (
                <div className="px-4 pb-3 text-sm text-[var(--text-secondary)] leading-relaxed">
                  {text ? <p>{text}</p> : <p className="italic text-[var(--text-muted)]">No {view} recorded for this agent yet.</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
