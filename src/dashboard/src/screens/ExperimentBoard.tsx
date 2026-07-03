// ══════════════════════════════════════════════════════════════════════
// ExperimentBoard.tsx — Tela 2 / front-specs §4
// Lane view of experiments with view toggle (Phase | Agent) and
// a contextual detail panel showing trace + checklist + spec diff.
// Phase view shows active phase with pulse indicator and grays out
// dependent phases. Reuses the existing kanban snapshot endpoint.
// ══════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  usePipelineStatus,
  useKanbanSnapshot,
} from "../api/api";
import { AgentDetailPanel } from "../components/AgentDetailPanel";
import { ActionBar } from "../components/ActionBar";
import { EmptyState } from "../components/EmptyState";
import { addToast } from "../components/Toast";
import { getStatusConfig } from "../lib/status-config";
import type {
  Action,
  AgentStatus,
  MLKanbanCard,
  MLKanbanLane,
} from "@shared/dashboard-types";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";

type ViewMode = "phase" | "agent";

// Derive phase info from AGENT_INFO_REGISTRY — single source of truth.

// Phase ordering for sequential pipeline display
const PHASE_ORDER = ["data_analysis", "feature_engineering", "modeling", "audit"];

// Map phaseStats keys to phase IDs used in AGENT_INFO_REGISTRY
const PHASE_STATS_TO_PHASE_ID: Record<string, string> = {
  dataAnalyst: "data_analysis",
  featureEngineer: "feature_engineering",
  modelerClassic: "modeling",
  modelerAdvanced: "modeling",
  mlCritic: "audit",
};

// Card-kind heuristic for display styling.
function cardKind(card: MLKanbanCard): "step" | "audit" {
  if (card.agentName === "ml-critic") return "audit";
  return "step";
}

interface BoardLane {
  key: string;
  label: string;
  status: AgentStatus | string;
  cards: MLKanbanCard[];
  summary: { done: number; total: number };
}

// Phase label mapping for display
const PHASE_LABELS: Record<string, string> = {
  data_analysis: "Data Analysis",
  feature_engineering: "Feature Engineering",
  modeling: "Modeling",
  audit: "Audit",
};

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

  // phase view — group by pipeline phase in order
  const buckets = new Map<string, BoardLane>();
  for (const l of lanes) {
    const agentInfo = AGENT_INFO_REGISTRY[l.agent];
    const phaseId = agentInfo?.phase ?? l.agent;
    const phaseLabel = PHASE_LABELS[phaseId] ?? agentInfo?.label ?? l.label;
    if (!buckets.has(phaseId)) {
      buckets.set(phaseId, {
        key: phaseId,
        label: phaseLabel,
        status: "idle",
        cards: [],
        summary: { done: 0, total: 0 },
      });
    }
    const bucket = buckets.get(phaseId)!;
    bucket.cards.push(...l.cards);
    bucket.summary.done += l.summary.done;
    bucket.summary.total += l.summary.total;
  }
  // Return in pipeline order
  const ordered: BoardLane[] = [];
  for (const phaseId of PHASE_ORDER) {
    const bucket = buckets.get(phaseId);
    if (bucket) ordered.push(bucket);
  }
  // Append any phases not in the predefined order
  for (const [phaseId, bucket] of buckets) {
    if (!PHASE_ORDER.includes(phaseId)) ordered.push(bucket);
  }
  return ordered;
}

function actionsForCard(_card: MLKanbanCard): Action[] {
  return [{ id: "details", label: "Details" }];
}

export default function ExperimentBoard() {
  const [searchParams] = useSearchParams();
  const roundFromUrl = searchParams.get("round") ? Number(searchParams.get("round")) : null;
  const runIdFromUrl = searchParams.get("run") ?? undefined;

  const { data: status } = usePipelineStatus();
  const runId = runIdFromUrl ?? status?.runId ?? undefined;
  const { data: kanban, isLoading } = useKanbanSnapshot(runId);
  const [view, setView] = useState<ViewMode>("phase");
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);

  const lanes = useMemo(() => buildLanes(view, kanban?.lanes ?? []), [view, kanban]);
  const pipelineRunning = status?.status === "running";

  // Determine active phase and dependent phases from phaseStats
  const { activePhase, completedPhases } = useMemo(() => {
    const phaseStats = status?.phaseStats;
    if (!phaseStats) return { activePhase: null as string | null, completedPhases: new Set<string>() };

    // Build per-phase status by aggregating agent statuses
    const phaseStatusMap = new Map<string, AgentStatus[]>();
    for (const [key, agentStatus] of Object.entries(phaseStats)) {
      const phaseId = PHASE_STATS_TO_PHASE_ID[key];
      if (!phaseId) continue;
      if (!phaseStatusMap.has(phaseId)) phaseStatusMap.set(phaseId, []);
      phaseStatusMap.get(phaseId)!.push(agentStatus);
    }

    const completed = new Set<string>();
    let active: string | null = null;

    for (const phaseId of PHASE_ORDER) {
      const statuses = phaseStatusMap.get(phaseId) ?? [];
      const allCompleted = statuses.length > 0 && statuses.every((s) => s === "completed");
      const anyRunning = statuses.some((s) => s === "running");

      if (allCompleted) {
        completed.add(phaseId);
      } else if (anyRunning || (!active && !allCompleted)) {
        if (!active) active = phaseId;
      }
    }

    return { activePhase: active, completedPhases: completed };
  }, [status?.phaseStats]);

  const selectedAgent = useMemo<string | null>(() => {
    if (!selectedCardId || !kanban) return null;
    for (const l of kanban.lanes) {
      for (const c of l.cards) if (c.id === selectedCardId) return c.agentName;
    }
    return null;
  }, [selectedCardId, kanban]);

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
    if (actionId === "details") {
      setSelectedCardId(card.id);
      return;
    }
    addToast("info", `"${actionId}" not yet wired`);
  }

  return (
    <div className="space-y-4" data-testid="experiment-board">
      {/* Header + view toggle */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">
              Round {roundFromUrl ?? kanban?.roundNumber ?? "—"} Experiment Board
            </h2>
            {roundFromUrl && roundFromUrl !== kanban?.roundNumber && (
              <span className="text-[10px] bg-[var(--bg-tertiary)] text-[var(--text-muted)] px-1.5 py-0.5 rounded">
                viewing historical round
              </span>
            )}
          </div>
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
          {(["phase", "agent"] as const).map((m) => (
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

      {/* Lanes */}
      <div
        className="grid gap-4 items-start"
        style={{ gridTemplateColumns: `repeat(${Math.max(lanes.length, 1)}, minmax(180px, 1fr))` }}
      >
        {lanes.map((lane) => {
          const isActivePhase = view === "phase" && lane.key === activePhase;
          const isCompletedPhase = view === "phase" && completedPhases.has(lane.key);
          const isDependentPhase = view === "phase" && !isActivePhase && !isCompletedPhase && pipelineRunning;

          return (
          <div
            key={lane.key}
            data-testid={`lane-${lane.key}`}
            className={`rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden transition-opacity ${
              isDependentPhase ? "opacity-40 pointer-events-none" : ""
            }`}
            title={isDependentPhase ? "Waiting for previous phase" : undefined}
          >
            {(() => {
              const headerConfig = isActivePhase
                ? getStatusConfig("running")
                : isCompletedPhase
                  ? getStatusConfig("completed")
                  : getStatusConfig(lane.status);
              return (
                <div
                  className={`px-3 py-2 border-b flex items-center justify-between ${headerConfig.borderClass} ${headerConfig.bgClass}`}
                  style={{ color: `var(${headerConfig.colorVar})` }}
                >
                  <span className="text-sm font-medium flex items-center gap-2">
                    {lane.label}
                    {isActivePhase && (
                      <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)] animate-pulse" />
                    )}
                    {isCompletedPhase && (
                      <span className="text-xs opacity-70">{getStatusConfig("completed").emoji}</span>
                    )}
                  </span>
                  <span className="text-xs">
                    {lane.summary.done}/{lane.summary.total}
                  </span>
                </div>
              );
            })()}
            <div className="p-2 space-y-2 max-h-[500px] overflow-y-auto">
              {lane.cards.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    icon={isDependentPhase ? "⏳" : isCompletedPhase ? getStatusConfig("completed").emoji : "⚪"}
                    message={isDependentPhase ? "Waiting for previous phase" : isCompletedPhase ? "Phase completed" : "No steps yet"}
                  />
                </div>
              ) : (
                lane.cards.map((card) => {
                  const acts = actionsForCard(card);
                  const cardConfig = getStatusConfig(card.status);
                  const isSelected = selectedCardId === card.id;
                  const baseClasses = [
                    "w-full text-left rounded p-2 border-l-3 transition-colors",
                    isSelected
                      ? `${cardConfig.borderClass} ${cardConfig.bgClass}`
                      : "border-[var(--border-default)] hover:border-l-[var(--status-running)]",
                    cardConfig.key === "idle"
                      ? "opacity-60"
                      : cardConfig.key === "completed"
                        ? "opacity-80"
                        : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <button
                      key={card.id}
                      data-testid={`card-${card.id}`}
                      data-kind={cardKind(card)}
                      onClick={() => setSelectedCardId(card.id)}
                      className={baseClasses}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-sm" aria-hidden="true">
                          {cardConfig.emoji}
                        </span>
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
          );
        })}
      </div>

      {/* Agent detail panel */}
      {selectedAgent && runId && (
        <AgentDetailPanel
          agentName={selectedAgent}
          runId={runId}
          onClose={() => setSelectedCardId(null)}
        />
      )}
    </div>
  );
}