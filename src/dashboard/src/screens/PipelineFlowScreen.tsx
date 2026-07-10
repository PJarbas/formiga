// ══════════════════════════════════════════════════════════════════════
// PipelineFlowScreen.tsx — DAG view of the ML pipeline (replaces kanban)
// Dynamic grid layout based on workflow type, SVG edges, clickable nodes
// ══════════════════════════════════════════════════════════════════════

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PipelineFlowResponse, WorkflowType } from "@shared/dashboard-types";
import { AgentNode } from "../components/PipelineFlow/AgentNode";
import { ArtifactEdge } from "../components/PipelineFlow/ArtifactEdge";
import { AgentSidePanel } from "../components/PipelineFlow/AgentSidePanel";

/** Grid positions for ml-pipeline workflow (5 agents) */
const ML_PIPELINE_POSITIONS: Record<string, { row: number; col: number }> = {
  "data-analyst": { row: 0, col: 1 },
  "feature-engineer": { row: 1, col: 1 },
  "modeler-classic": { row: 2, col: 0 },
  "modeler-advanced": { row: 2, col: 2 },
  "ml-critic": { row: 3, col: 1 },
};

/** Grid positions for ml-autoresearch workflow (5 agents, different layout) */
const ML_AUTORESEARCH_POSITIONS: Record<string, { row: number; col: number }> = {
  "data-analyst": { row: 0, col: 1 },
  "feature-engineer": { row: 1, col: 1 },
  "arena-modeler-classic": { row: 2, col: 0 },
  "arena-modeler-advanced": { row: 2, col: 2 },
  "reporter": { row: 3, col: 1 },
};

function getGridPositions(workflowType: WorkflowType | undefined): Record<string, { row: number; col: number }> {
  if (workflowType === "ml-autoresearch") {
    return ML_AUTORESEARCH_POSITIONS;
  }
  return ML_PIPELINE_POSITIONS;
}

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

  const gridPositions = useMemo(
    () => getGridPositions(data?.workflowType),
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

  return (
    <div className="relative" data-testid="pipeline-flow">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Pipeline Flow</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Real-time DAG view of agent execution and artifact flow
        </p>
      </div>

      {/* DAG grid layout - fixed positions with explicit grid areas */}
      <div
        className="relative mx-auto"
        style={{
          display: "grid",
          gridTemplateRows: "repeat(4, 140px)",
          gridTemplateColumns: "repeat(3, minmax(200px, 320px))",
          gap: "32px 24px",
          maxWidth: "1100px",
          justifyContent: "center",
        }}
      >
        {/* SVG edges layer - full overlay */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
          style={{ zIndex: 0 }}
        >
          {edges.map((edge) => (
            <ArtifactEdge key={`${edge.from}-${edge.to}`} edge={edge} positions={gridPositions} />
          ))}
        </svg>

        {/* Nodes - each placed in explicit grid cell */}
        {nodes.map((node) => {
          const pos = gridPositions[node.agentId];
          if (!pos) return null;
          return (
            <div
              key={node.agentId}
              className="flex justify-center"
              style={{
                gridRow: pos.row + 1,
                gridColumn: pos.col + 1,
                zIndex: 1,
              }}
            >
              <AgentNode
                node={node}
                isSelected={selectedAgent === node.agentId}
                onClick={() => setSelectedAgent(selectedAgent === node.agentId ? null : node.agentId)}
              />
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