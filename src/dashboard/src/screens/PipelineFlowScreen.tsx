// ══════════════════════════════════════════════════════════════════════
// PipelineFlowScreen.tsx — SageMaker-inspired horizontal phase groups
// Replaces the old rigid 3×4 grid with dynamic phase-grouped layout.
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PipelineFlowResponse, PipelineFlowNode, WorkflowType } from "@shared/dashboard-types";
import { AgentNode } from "../components/PipelineFlow/AgentNode";
import { AgentSidePanel } from "../components/PipelineFlow/AgentSidePanel";

// ── Phase group definitions ─────────────────────────────────────────────

interface PhaseGroup {
  id: string;
  label: string;
  icon: string;
  agentIds: string[];
  /** Agent IDs that feed INTO this group */
  feedsFrom: string[];
}

const ML_PIPELINE_PHASES: PhaseGroup[] = [
  { id: "analysis", label: "Analysis", icon: "📊", agentIds: ["data-analyst"], feedsFrom: [] },
  { id: "preparation", label: "Preparation", icon: "⚙️", agentIds: ["feature-engineer"], feedsFrom: ["data-analyst"] },
  { id: "arena", label: "Arena", icon: "🏟️", agentIds: ["modeler-classic", "modeler-advanced", "ml-critic"], feedsFrom: ["feature-engineer"] },
];

const ML_AUTORESEARCH_PHASES: PhaseGroup[] = [
  { id: "analysis", label: "Analysis", icon: "📊", agentIds: ["data-analyst"], feedsFrom: [] },
  { id: "preparation", label: "Preparation", icon: "⚙️", agentIds: ["feature-engineer"], feedsFrom: ["data-analyst"] },
  { id: "arena", label: "Arena", icon: "🏟️", agentIds: ["arena-modeler-classic", "arena-modeler-advanced"], feedsFrom: ["feature-engineer"] },
  { id: "results", label: "Results", icon: "📋", agentIds: ["reporter"], feedsFrom: ["arena-modeler-classic", "arena-modeler-advanced"] },
];

function getPhaseGroups(workflowType: WorkflowType | undefined): PhaseGroup[] {
  if (workflowType === "ml-autoresearch") return ML_AUTORESEARCH_PHASES;
  return ML_PIPELINE_PHASES;
}

// ── Phase status aggregation ────────────────────────────────────────────

type PhaseStatus = "idle" | "running" | "completed" | "failed" | "mixed";

function aggregatePhaseStatus(nodes: PipelineFlowNode[], agentIds: string[]): PhaseStatus {
  const groupNodes = nodes.filter((n) => agentIds.includes(n.agentId));
  if (groupNodes.length === 0) return "idle";

  const statuses = groupNodes.map((n) => n.status);
  const allIdle = statuses.every((s) => s === "idle");
  const allCompleted = statuses.every((s) => s === "completed");
  const anyFailed = statuses.some((s) => s === "failed" || s === "timed_out");
  const anyRunning = statuses.some((s) => s === "running");
  const allDone = statuses.every((s) => s === "completed" || s === "idle");

  if (allIdle) return "idle";
  if (anyFailed && allDone) return "failed";
  if (anyRunning) return "running";
  if (allCompleted) return "completed";
  return "mixed";
}

const PHASE_STATUS_STYLES: Record<PhaseStatus, { emoji: string; color: string; bg: string; border: string }> = {
  idle: { emoji: "⚪", color: "var(--text-muted)", bg: "var(--bg-secondary)", border: "var(--border-default)" },
  running: { emoji: "🔵", color: "var(--accent-blue)", bg: "var(--accent-blue)/5", border: "var(--accent-blue)" },
  completed: { emoji: "✅", color: "var(--accent-green)", bg: "var(--accent-green)/5", border: "var(--accent-green)" },
  failed: { emoji: "❌", color: "var(--accent-red)", bg: "var(--accent-red)/5", border: "var(--accent-red)" },
  mixed: { emoji: "⚠️", color: "var(--accent-amber)", bg: "var(--accent-amber)/5", border: "var(--accent-amber)" },
};

// ── Connector arrow between phase groups ─────────────────────────────────

function PhaseConnector({ status }: { status: "pending" | "active" | "done" }) {
  const color =
    status === "done" ? "var(--accent-green)" :
    status === "active" ? "var(--accent-blue)" :
    "var(--border-default)";

  return (
    <div className="flex items-center justify-center shrink-0" style={{ width: 40 }}>
      <svg width="28" height="16" viewBox="0 0 28 16">
        <line x1="0" y1="8" x2="22" y2="8" stroke={color} strokeWidth="2"
          strokeDasharray={status === "active" ? "5 3" : "none"}
          className={status === "active" ? "animate-pulse" : ""}
        />
        <polygon points="20,3 28,8 20,13" fill={color} />
      </svg>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export default function PipelineFlowScreen() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  const { data, isLoading } = useQuery<PipelineFlowResponse>({
    queryKey: ["pipeline-flow"],
    queryFn: async () => {
      const res = await fetch("/api/pipeline/flow");
      if (!res.ok) throw new Error("Failed to fetch pipeline flow");
      return res.json();
    },
    refetchInterval: 5000,
  });

  const phaseGroups = useMemo(
    () => getPhaseGroups(data?.workflowType),
    [data?.workflowType]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading pipeline flow...
      </div>
    );
  }

  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];

  // Build a set of connected pairs from edges to determine connector status
  const edgeMap = new Map<string, string>();
  for (const edge of edges) {
    const key = `${edge.from}→${edge.to}`;
    if (!edgeMap.has(key) || edge.status === "delivered") {
      edgeMap.set(key, edge.status);
    }
  }

  return (
    <div data-testid="pipeline-flow">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Pipeline Flow</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Real-time view of agent execution across phases
        </p>
      </div>

      {/* Run status banner */}
      {data?.runStatus && data.runStatus !== "running" && data.runStatus !== "paused" && (
        <div
          className="mb-6 px-3 py-2 rounded border text-xs font-medium flex items-center gap-2"
          style={{
            backgroundColor:
              data.runStatus === "failed" ? "var(--accent-red)" :
              data.runStatus === "canceled" ? "var(--accent-yellow)" :
              "var(--bg-tertiary)",
            color:
              data.runStatus === "failed" || data.runStatus === "canceled"
                ? "#fff" : "var(--text-primary)",
            borderColor:
              data.runStatus === "failed" ? "var(--accent-red)" :
              data.runStatus === "canceled" ? "var(--accent-yellow)" :
              "var(--border-default)",
          }}
        >
          Run {data.runStatus} — agents below reflect last known state.
        </div>
      )}

      {/* Horizontal phase groups */}
      <div className="flex items-start gap-0 overflow-x-auto pb-4">
        {phaseGroups.map((group, gi) => {
          const phaseStatus = aggregatePhaseStatus(nodes, group.agentIds);
          const ps = PHASE_STATUS_STYLES[phaseStatus];
          const groupNodes = nodes.filter((n) => group.agentIds.includes(n.agentId));

          // Determine connector status to this group
          let connectorStatus: "pending" | "active" | "done" = "pending";
          if (gi > 0) {
            const prevGroup = phaseGroups[gi - 1];
            const fromAgent = prevGroup.agentIds[prevGroup.agentIds.length - 1];
            const toAgent = group.agentIds[0];
            const edgeStatus = edgeMap.get(`${fromAgent}→${toAgent}`);
            if (edgeStatus === "delivered") connectorStatus = "done";
            else if (edgeStatus === "in-transit") connectorStatus = "active";
          }

          return (
            <div key={group.id} className="flex items-start">
              {/* Connector arrow between groups */}
              {gi > 0 && <PhaseConnector status={connectorStatus} />}

              {/* Phase group card */}
              <div
                className="rounded-lg border-2 p-4 min-w-[200px]"
                style={{
                  borderColor: ps.border,
                  backgroundColor: `color-mix(in srgb, ${ps.color} 4%, var(--bg-secondary))`,
                }}
              >
                {/* Group header */}
                <div className="flex items-center gap-2 mb-3 pb-2 border-b" style={{ borderColor: "var(--border-default)" }}>
                  <span className="text-base">{group.icon}</span>
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: ps.color }}>
                    {group.label}
                  </span>
                  <span className="ml-auto text-xs">{ps.emoji}</span>
                </div>

                {/* Nodes inside the group */}
                <div className="flex flex-wrap gap-3">
                  {groupNodes.map((node) => (
                    <AgentNode
                      key={node.agentId}
                      node={node}
                      isSelected={selectedAgent === node.agentId}
                      onClick={() => setSelectedAgent(selectedAgent === node.agentId ? null : node.agentId)}
                    />
                  ))}
                  {groupNodes.length === 0 && (
                    <div className="text-[11px] text-[var(--text-muted)] italic py-2 px-1">
                      No agents in this phase
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Side panel */}
      {selectedAgent && (
        <AgentSidePanel
          agentId={selectedAgent}
          runId={data?.runId}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  );
}
