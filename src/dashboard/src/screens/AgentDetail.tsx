// ══════════════════════════════════════════════════════════════════════
// AgentDetail.tsx — Tela 4: agent plan, trials, paginated logs
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useParams } from "react-router-dom";
import { useAgentDetail, useAgentLogs } from "../api/api";

const LOG_PAGE_SIZE = 50;

export default function AgentDetail() {
  const { name } = useParams<{ name: string }>();
  const { data: detail, isLoading } = useAgentDetail(name);
  const [logOffset, setLogOffset] = useState(0);
  const { data: logs } = useAgentLogs(name, logOffset, LOG_PAGE_SIZE);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading agent detail...
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center">
        <p className="text-[var(--text-secondary)]">Agent not found: {name}</p>
      </div>
    );
  }

  const { agent, currentStatus, totalTrials, rounds, lastError } = detail;

  return (
    <div className="space-y-6">
      {/* Agent header */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{agent.label}</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-1">{agent.description}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`status-dot ${currentStatus}`} />
            <span className="text-sm font-medium capitalize text-[var(--text-primary)]">{currentStatus}</span>
          </div>
        </div>
        <div className="flex gap-6 mt-4 text-sm">
          <div>
            <span className="text-[var(--text-muted)]">Model: </span>
            <span className="text-[var(--text-primary)] font-medium">{agent.model}</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Total Trials: </span>
            <span className="text-[var(--text-primary)] font-medium">{totalTrials}</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Tools: </span>
            <span className="text-[var(--text-primary)] font-medium">{agent.tools.join(", ")}</span>
          </div>
        </div>
      </div>

      {/* Rounds table */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border-default)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Rounds</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-default)] text-left">
                <th className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Round</th>
                <th className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">CV Mean</th>
                <th className="px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase">Model Type</th>
              </tr>
            </thead>
            <tbody>
              {rounds.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-[var(--text-muted)]">
                    No rounds completed yet
                  </td>
                </tr>
              ) : (
                rounds.map((r) => (
                  <tr key={r.roundNumber} className="border-b border-[var(--border-default)]">
                    <td className="px-4 py-2.5 text-[var(--text-primary)] text-xs">Round {r.roundNumber}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded ${
                        r.status === "completed" ? "bg-[var(--accent-green)]/20 text-[var(--accent-green)]" :
                        r.status === "failed" ? "bg-[var(--accent-red)]/20 text-[var(--accent-red)]" :
                        "bg-[var(--text-muted)]/20 text-[var(--text-secondary)]"
                      }`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-[var(--accent-blue)]">
                      {r.cvMean?.toFixed(4) ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-[var(--text-secondary)]">{r.modelType ?? "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Error display */}
      {lastError && (
        <div className="rounded-lg border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5 p-4">
          <h3 className="text-sm font-semibold text-[var(--accent-red)] mb-2">Last Error</h3>
          <pre className="text-xs text-[var(--text-primary)] whitespace-pre-wrap font-mono">{lastError}</pre>
        </div>
      )}

      {/* Logs */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            Logs {logs && `(${logs.total} entries)`}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLogOffset(Math.max(0, logOffset - LOG_PAGE_SIZE))}
              disabled={logOffset === 0}
              className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-[var(--text-muted)]">
              {logOffset + 1}–{Math.min(logOffset + LOG_PAGE_SIZE, logs?.total ?? 0)}
            </span>
            <button
              onClick={() => setLogOffset(logOffset + LOG_PAGE_SIZE)}
              disabled={!logs || logOffset + LOG_PAGE_SIZE >= logs.total}
              className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
        <div className="max-h-[400px] overflow-y-auto">
          {!logs || logs.entries.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] text-center py-8">No log entries</p>
          ) : (
            logs.entries.map((entry, i) => (
              <div
                key={i}
                className={`px-4 py-2 border-b border-[var(--border-default)] last:border-0 font-mono text-xs ${
                  entry.level === "error"
                    ? "text-[var(--accent-red)]"
                    : entry.level === "warn"
                      ? "text-[var(--accent-orange)]"
                      : "text-[var(--text-secondary)]"
                }`}
              >
                <span className="text-[var(--text-muted)] mr-2">{entry.timestamp.slice(11, 19)}</span>
                {entry.message}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
