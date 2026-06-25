// ══════════════════════════════════════════════════════════════════════
// Kanban.tsx — Tela 2: lane-grouped agent cards with detail dialog
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { usePipelineStatus, useKanbanSnapshot } from "../api/api";

export default function Kanban() {
  const { data: status } = usePipelineStatus();
  const { data: kanban, isLoading } = useKanbanSnapshot(status?.runId ?? undefined);
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  if (!status?.runId) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center">
        <p className="text-[var(--text-secondary)]">No active pipeline. Start a run to see the kanban.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading kanban...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Round {kanban?.roundNumber ?? status.currentRound} Kanban
        </h2>
        <span className="text-xs text-[var(--text-muted)]">
          Snapshot at {kanban?.generatedAt ? new Date(kanban.generatedAt).toLocaleTimeString() : "—"}
        </span>
      </div>

      <div className="grid grid-cols-5 gap-4 items-start">
        {(kanban?.lanes ?? []).map((lane) => (
          <div
            key={lane.agent}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden"
          >
            {/* Lane header */}
            <div className="px-3 py-2 border-b border-[var(--border-default)] flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`status-dot ${lane.status}`} />
                <span className="text-sm font-medium text-[var(--text-primary)]">{lane.label}</span>
              </div>
              <span className="text-xs text-[var(--text-muted)]">
                {lane.summary.done}/{lane.summary.total}
              </span>
            </div>

            {/* Lane cards */}
            <div className="p-2 space-y-2 max-h-[500px] overflow-y-auto">
              {lane.cards.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] text-center py-4">No cards yet</p>
              ) : (
                lane.cards.map((card) => (
                  <button
                    key={card.id}
                    onClick={() => setSelectedCardId(card.id)}
                    className={`w-full text-left rounded p-2 border transition-colors ${
                      selectedCardId === card.id
                        ? "border-[var(--accent-blue)] bg-[var(--bg-tertiary)]"
                        : "border-[var(--border-default)] hover:border-[var(--accent-blue)]"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`status-dot ${card.status}`} />
                      <span className="text-xs font-medium text-[var(--text-primary)] truncate">{card.title}</span>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)]">{card.sub}</p>
                  </button>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Card detail dialog */}
      {selectedCardId && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setSelectedCardId(null)}
        >
          <div
            className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg p-6 max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-[var(--text-primary)]">Card Detail</h3>
              <button
                onClick={() => setSelectedCardId(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="text-[var(--text-muted)] text-xs uppercase tracking-wide">ID</dt>
                <dd className="text-[var(--text-primary)] mt-0.5 font-mono text-xs">{selectedCardId}</dd>
              </div>
              {/* Card detail content populated from kanban data */}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
