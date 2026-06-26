// ══════════════════════════════════════════════════════════════════════
// ExperimentBoard.tsx — Tela 2 / front-specs §4
// Lane view of experiments with view toggle (Phase | Agent | Status) and
// a contextual detail panel showing trace + checklist + spec diff.
// Reuses the existing kanban snapshot endpoint for card data.
// ══════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import {
  usePipelineStatus,
  useKanbanSnapshot,
  useTrace,
  useChecklist,
  useExperimentActions,
  useSpecActions,
} from "../api/api";
import { TraceTimeline } from "../components/TraceTimeline";
import { InteractiveChecklist } from "../components/InteractiveChecklist";
import { ActionBar } from "../components/ActionBar";
import type {
  Action,
  AgentStatus,
  MLKanbanCard,
  MLKanbanLane,
} from "@shared/dashboard-types";

type ViewMode = "phase" | "agent" | "status";

// Map agent name to logical phase id (for the "Phase" view).
const AGENT_PHASE: Record<string, { id: string; label: string }> = {
  "data-analyst": { id: "eda", label: "EDA" },
  "feature-engineer": { id: "feat-eng", label: "Feature Eng." },
  "modeler-classic": { id: "modeling", label: "Modeling" },
  "modeler-advanced": { id: "modeling", label: "Modeling" },
  "ml-critic": { id: "audit", label: "Audit" },
};

const STATUS_GROUPS: { id: AgentStatus | "all"; label: string }[] = [
  { id: "idle", label: "Pending" },
  { id: "running", label: "Running" },
  { id: "completed", label: "Done" },
  { id: "failed", label: "Failed" },
];

// Approximate card-kind heuristic. Cards that come from spec-producing
// agents are treated as "spec"; others are "trial" except ml-critic = "audit".
function cardKind(card: MLKanbanCard): "spec" | "trial" | "audit" {
  if (card.agentName === "ml-critic") return "audit";
  if (card.agentName === "data-analyst" || card.agentName === "feature-engineer") return "spec";
  return "trial";
}

interface BoardLane {
  key: string;
  label: string;
  status: AgentStatus | string;
  cards: MLKanbanCard[];
  summary: { done: number; total: number };
}

function buildLanes(view: ViewMode, lanes: MLKanbanLane[]): BoardLane[] {
  if (view === "agent") {
    return lanes.map((l) => ({
      key: l.agent,
      label: l.label,
      status: l.status,
      cards: l.cards,
      summary: { done: l.summary.done, total: l.summary.total },
    }));
  }
  if (view === "phase") {
    const buckets = new Map<string, BoardLane>();
    for (const l of lanes) {
      const phase = AGENT_PHASE[l.agent] ?? { id: l.agent, label: l.label };
      if (!buckets.has(phase.id)) {
        buckets.set(phase.id, {
          key: phase.id,
          label: phase.label,
          status: "running",
          cards: [],
          summary: { done: 0, total: 0 },
        });
      }
      const b = buckets.get(phase.id)!;
      b.cards.push(...l.cards);
      b.summary.done += l.summary.done;
      b.summary.total += l.summary.total;
    }
    return Array.from(buckets.values());
  }
  // status
  const buckets = new Map<string, BoardLane>();
  for (const g of STATUS_GROUPS) {
    buckets.set(g.id, {
      key: g.id,
      label: g.label,
      status: g.id,
      cards: [],
      summary: { done: 0, total: 0 },
    });
  }
  for (const l of lanes) {
    for (const c of l.cards) {
      const key = (buckets.has(c.status) ? c.status : "idle") as string;
      const b = buckets.get(key)!;
      b.cards.push(c);
      b.summary.total += 1;
      if (c.status === "completed") b.summary.done += 1;
    }
  }
  return Array.from(buckets.values());
}

function actionsForCard(card: MLKanbanCard): Action[] {
  const kind = cardKind(card);
  if (kind === "spec") {
    return [
      { id: "approve", label: "Approve", primary: true, variant: "success" },
      { id: "edit", label: "Edit" },
      { id: "reject", label: "Reject", variant: "destructive" },
    ];
  }
  if (kind === "audit") {
    return [{ id: "details", label: "Details" }];
  }
  // trial
  return [
    { id: "promote", label: "Promote", variant: "success" },
    { id: "reject", label: "Reject", variant: "destructive" },
    { id: "details", label: "Details" },
  ];
}

export default function ExperimentBoard() {
  const { data: status } = usePipelineStatus();
  const runId = status?.runId ?? undefined;
  const { data: kanban, isLoading } = useKanbanSnapshot(runId);
  const [view, setView] = useState<ViewMode>("phase");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const { promote, reject } = useExperimentActions();
  const { approve: approveSpec, reject: rejectSpec } = useSpecActions();

  const lanes = useMemo(() => buildLanes(view, kanban?.lanes ?? []), [view, kanban]);

  const selectedCard = useMemo<MLKanbanCard | null>(() => {
    if (!selectedCardId || !kanban) return null;
    for (const l of kanban.lanes) {
      for (const c of l.cards) if (c.id === selectedCardId) return c;
    }
    return null;
  }, [selectedCardId, kanban]);

  const { data: trace } = useTrace(
    selectedCard?.agentName,
    kanban?.roundNumber,
  );
  const checklistEnabled = selectedCard?.agentName === "feature-engineer" && !!runId;
  const { data: checklist } = useChecklist(
    checklistEnabled ? runId : undefined,
    checklistEnabled ? "feat-eng" : undefined,
  );

  if (!runId) {
    return (
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center">
        <p className="text-[var(--text-secondary)]">
          No active pipeline. Start a run to see the experiment board.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading experiment board...
      </div>
    );
  }

  function dispatch(card: MLKanbanCard, actionId: string) {
    setToast(null);
    const kind = cardKind(card);
    if (kind === "spec") {
      const specId = `${runId}:${AGENT_PHASE[card.agentName]?.id ?? card.agentName}`;
      if (actionId === "approve") {
        approveSpec.mutate(
          { specId },
          {
            onSuccess: () => setToast(`Approved ${specId}`),
            onError: (e) => setToast(`Approve failed: ${(e as Error).message}`),
          },
        );
        return;
      }
      if (actionId === "reject") {
        const reason = window.prompt("Reject reason (optional):") ?? undefined;
        rejectSpec.mutate(
          { specId, reason },
          {
            onSuccess: () => setToast(`Rejected ${specId}`),
            onError: (e) => setToast(`Reject failed: ${(e as Error).message}`),
          },
        );
        return;
      }
      setToast(`"${actionId}" not yet wired`);
      return;
    }
    if (kind === "trial") {
      if (actionId === "promote") {
        promote.mutate(card.id, {
          onSuccess: () => setToast(`Promoted ${card.id}`),
          onError: (e) => setToast(`Promote failed: ${(e as Error).message}`),
        });
        return;
      }
      if (actionId === "reject") {
        reject.mutate(
          { id: card.id },
          {
            onSuccess: () => setToast(`Rejected ${card.id}`),
            onError: (e) => setToast(`Reject failed: ${(e as Error).message}`),
          },
        );
        return;
      }
    }
    setToast(`"${actionId}" not yet wired`);
  }

  return (
    <div className="space-y-4" data-testid="experiment-board">
      {/* Header + view toggle */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Round {kanban?.roundNumber ?? "—"} Experiment Board
          </h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Snapshot at{" "}
            {kanban?.generatedAt ? new Date(kanban.generatedAt).toLocaleTimeString() : "—"}
          </p>
        </div>
        <div
          role="tablist"
          aria-label="View mode"
          className="inline-flex rounded border border-[var(--border-default)] overflow-hidden text-xs"
        >
          {(["phase", "agent", "status"] as const).map((m) => (
            <button
              key={m}
              data-testid={`view-${m}`}
              data-active={view === m ? "true" : "false"}
              onClick={() => setView(m)}
              className={`px-3 py-1.5 capitalize ${
                view === m
                  ? "bg-[var(--accent-blue)] text-white"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {toast && (
        <div
          data-testid="board-toast"
          className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded px-3 py-1.5"
        >
          {toast}
        </div>
      )}

      {/* Lanes */}
      <div
        className="grid gap-4 items-start"
        style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(180px, 1fr))` }}
      >
        {lanes.map((lane) => (
          <div
            key={lane.key}
            data-testid={`lane-${lane.key}`}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden"
          >
            <div className="px-3 py-2 border-b border-[var(--border-default)] flex items-center justify-between">
              <span className="text-sm font-medium text-[var(--text-primary)]">{lane.label}</span>
              <span className="text-xs text-[var(--text-muted)]">
                {lane.summary.done}/{lane.summary.total}
              </span>
            </div>
            <div className="p-2 space-y-2 max-h-[500px] overflow-y-auto">
              {lane.cards.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] text-center py-4">No cards</p>
              ) : (
                lane.cards.map((card) => {
                  const acts = actionsForCard(card);
                  return (
                    <button
                      key={card.id}
                      data-testid={`card-${card.id}`}
                      data-kind={cardKind(card)}
                      onClick={() => setSelectedCardId(card.id)}
                      className={`w-full text-left rounded p-2 border transition-colors ${
                        selectedCardId === card.id
                          ? "border-[var(--accent-blue)] bg-[var(--bg-tertiary)]"
                          : "border-[var(--border-default)] hover:border-[var(--accent-blue)]"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className={`status-dot ${card.status}`} />
                        <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                          {card.title}
                        </span>
                      </div>
                      <p className="text-[10px] text-[var(--text-muted)]">{card.sub}</p>
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2"
                      >
                        <ActionBar
                          actions={acts}
                          onAction={(actionId) => dispatch(card, actionId)}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Detail panel */}
      {selectedCard && (
        <div
          data-testid="detail-panel"
          className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5 space-y-4"
        >
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {selectedCard.title}
              </h3>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {selectedCard.agentName} · {selectedCard.sub}
              </p>
            </div>
            <ActionBar
              actions={actionsForCard(selectedCard)}
              onAction={(a) => dispatch(selectedCard, a)}
            />
          </div>

          {checklistEnabled && (
            <div>
              <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
                Checklist
              </h4>
              <InteractiveChecklist
                runId={runId!}
                phase="feat-eng"
                items={checklist?.items ?? []}
              />
            </div>
          )}

          <div>
            <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
              Trace
            </h4>
            <TraceTimeline entries={trace ?? []} />
          </div>
        </div>
      )}
    </div>
  );
}
