// ══════════════════════════════════════════════════════════════════════
// PipelineFlowScreen.tsx — React Flow DAG visualization
// SageMaker-inspired dark canvas with gradient-icon nodes and Bezier edges.
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { PipelineFlowResponse } from "@shared/dashboard-types";
import DagCanvas from "../components/PipelineFlow/DagCanvas";
import { AgentSidePanel } from "../components/PipelineFlow/AgentSidePanel";

export default function PipelineFlowScreen() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // #128: the flow follows the ?run= in the URL (set by /kanban?run=<id>),
  // falling back to the active run when no selection is present.
  const [searchParams] = useSearchParams();
  const runParam = searchParams.get("run")?.trim() || undefined;

  const { data, isLoading } = useQuery<PipelineFlowResponse>({
    queryKey: ["pipeline-flow", runParam ?? "active"],
    queryFn: async () => {
      const suffix = runParam ? `?run=${encodeURIComponent(runParam)}` : "";
      const res = await fetch(`/api/pipeline/flow${suffix}`);
      if (!res.ok) throw new Error("Failed to fetch pipeline flow");
      return res.json();
    },
    refetchInterval: 5000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading pipeline flow...
      </div>
    );
  }

  return (
    <div data-testid="pipeline-flow">
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Pipeline Flow
        </h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Real-time agent execution graph
        </p>
      </div>

      {/* Run status banner */}
      {data?.runStatus &&
        data.runStatus !== "running" &&
        data.runStatus !== "paused" && (
          <div
            className="mb-4 px-3 py-2 rounded border text-xs font-medium flex items-center gap-2"
            style={{
              backgroundColor:
                data.runStatus === "failed"
                  ? "var(--accent-red)"
                  : data.runStatus === "canceled"
                    ? "var(--accent-orange)"
                    : "var(--bg-tertiary)",
              color:
                data.runStatus === "failed" || data.runStatus === "canceled"
                  ? "#fff"
                  : "var(--text-primary)",
              borderColor:
                data.runStatus === "failed"
                  ? "var(--accent-red)"
                  : data.runStatus === "canceled"
                    ? "var(--accent-orange)"
                    : "var(--border-default)",
            }}
          >
            Run {data.runStatus} — agents below reflect last known state.
          </div>
        )}

      {/* DAG Canvas */}
      <div className="h-[calc(100vh-200px)] min-h-[500px]">
        <DagCanvas
          nodes={data?.nodes ?? []}
          edges={data?.edges ?? []}
          workflowType={data?.workflowType}
          selectedAgent={selectedAgent}
          onNodeClick={(id) =>
            setSelectedAgent(selectedAgent === id ? null : id)
          }
        />
      </div>

      {/* Side panel */}
      {selectedAgent && (
        <AgentSidePanel
          agentId={selectedAgent}
          runId={data?.runId ?? undefined}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  );
}
