// ══════════════════════════════════════════════════════════════════════
// AgentSidePanel.tsx — Slide-in panel with tabs for agent details
// Insights · Activity · Reports · History
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";
import type { AgentKeyDecision } from "@shared/dashboard-types";
import { DataAnalystInsights } from "../insights/DataAnalystInsights";
import { FeatureEngineerInsights } from "../insights/FeatureEngineerInsights";
import { ModelerInsights } from "../insights/ModelerInsights";
import { ReporterInsights } from "../insights/ReporterInsights";
import { ArtifactsSection } from "../insights/ArtifactViewer";
import { EmptyInsight, LoadingInsight } from "../insights/InsightComponents";

interface AgentMessage {
  from: string;
  timestamp: string;
  content: string;
}

type TabId = "insights" | "activity" | "reports" | "history";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "insights", label: "Insights", icon: "💡" },
  { id: "activity", label: "Activity", icon: "📊" },
  { id: "reports", label: "Reports", icon: "📄" },
  { id: "history", label: "History", icon: "📜" },
];

interface AgentSidePanelProps {
  agentId: string;
  runId?: string;
  onClose: () => void;
}

export function AgentSidePanel({ agentId, runId, onClose }: AgentSidePanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("insights");

  const info = AGENT_INFO_REGISTRY[agentId];

  // Fetch agent artifacts for the current run
  const { data: artifacts, isLoading: artifactsLoading } = useQuery({
    queryKey: ["agent-artifacts", agentId, runId],
    queryFn: async () => {
      const artifactKeys = info?.artifactsOut ?? [];
      if (artifactKeys.length === 0) return [];

      const results = await Promise.all(
        artifactKeys.map(async (key) => {
          try {
            const res = await fetch(`/api/runs/${runId ?? "latest"}/agent-artifacts/${key}`);
            if (!res.ok) return null;
            const content = await res.json();
            return { artifactKey: key, content, contentType: "json" };
          } catch {
            return null;
          }
        })
      );

      return results.filter(Boolean);
    },
    refetchInterval: 10000,
    enabled: activeTab === "insights" || activeTab === "reports",
  });

  // Fetch reasoning data
  const { data: reasoning, isLoading: reasoningLoading } = useQuery({
    queryKey: ["agent-reasoning", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/reasoning`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 10000,
    enabled: activeTab === "insights",
  });

  // Fetch messages
  const { data: messages } = useQuery<AgentMessage[]>({
    queryKey: ["agent-messages", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/messages`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
    enabled: activeTab === "activity",
  });

  // Fetch key decisions for modelers
  const { data: keyDecisions } = useQuery<AgentKeyDecision[]>({
    queryKey: ["agent-key-decisions", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard/key-decisions?agent=${agentId}`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 10000,
    enabled: (agentId === "modeler-classic" || agentId === "modeler-advanced") && activeTab === "insights",
  });

  // Helper to get artifact by key
  const getArtifact = (key: string) => {
    const artifact = artifacts?.find((a: { artifactKey: string }) => a?.artifactKey === key);
    return artifact?.content ?? null;
  };

  return (
    <div
      className="fixed top-0 right-0 h-full w-[420px] bg-[var(--bg-primary)] border-l border-[var(--border-default)] shadow-xl z-50 flex flex-col animate-slide-in"
      data-testid="agent-side-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--accent-blue)]/10 flex items-center justify-center text-lg">
            {getAgentIcon(agentId)}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {info?.label ?? agentId}
            </h3>
            <p className="text-[10px] text-[var(--text-muted)] max-w-[280px] truncate">
              {info?.description?.slice(0, 80)}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg p-1 rounded hover:bg-[var(--bg-secondary)]"
        >
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border-default)] px-2">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? "text-[var(--accent-blue)] border-b-2 border-[var(--accent-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            <span className="text-[10px]">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "insights" && (
          <InsightsContent
            agentId={agentId}
            artifacts={artifacts ?? []}
            reasoning={reasoning}
            keyDecisions={keyDecisions ?? []}
            isLoading={artifactsLoading || reasoningLoading}
          />
        )}
        {activeTab === "activity" && (
          <ActivityContent agentId={agentId} messages={messages ?? []} />
        )}
        {activeTab === "reports" && (
          <ReportsContent artifacts={artifacts ?? []} isLoading={artifactsLoading} />
        )}
        {activeTab === "history" && <HistoryContent agentId={agentId} />}
      </div>
    </div>
  );
}

function getAgentIcon(agentId: string): string {
  const icons: Record<string, string> = {
    "data-analyst": "📊",
    "feature-engineer": "🔧",
    "modeler-classic": "🌲",
    "modeler-advanced": "🧠",
    reporter: "📝",
  };
  return icons[agentId] ?? "🤖";
}

interface InsightsContentProps {
  agentId: string;
  artifacts: Array<{ artifactKey: string; content: Record<string, unknown> }>;
  reasoning: { hypothesis?: string; learned?: string; next_focus?: string } | null;
  keyDecisions: AgentKeyDecision[];
  isLoading: boolean;
}

function InsightsContent({ agentId, artifacts, reasoning, keyDecisions, isLoading }: InsightsContentProps) {
  const getArtifact = (key: string) => {
    const artifact = artifacts.find((a) => a.artifactKey === key);
    return artifact?.content ?? null;
  };

  if (agentId === "data-analyst") {
    return (
      <DataAnalystInsights
        edaReport={getArtifact("eda_report") as Parameters<typeof DataAnalystInsights>[0]["edaReport"]}
        edaConfig={getArtifact("eda_config") as Parameters<typeof DataAnalystInsights>[0]["edaConfig"]}
        hypothesis={reasoning?.hypothesis ?? null}
        isLoading={isLoading}
      />
    );
  }

  if (agentId === "feature-engineer") {
    return (
      <FeatureEngineerInsights
        featuresMetadata={getArtifact("features_metadata") as Parameters<typeof FeatureEngineerInsights>[0]["featuresMetadata"]}
        splitConfig={getArtifact("split_config") as Parameters<typeof FeatureEngineerInsights>[0]["splitConfig"]}
        baselineSubmission={getArtifact("baseline_submission") as Parameters<typeof FeatureEngineerInsights>[0]["baselineSubmission"]}
        benchmarkConfig={getArtifact("benchmark_config") as Parameters<typeof FeatureEngineerInsights>[0]["benchmarkConfig"]}
        hypothesis={reasoning?.hypothesis ?? null}
        isLoading={isLoading}
      />
    );
  }

  if (agentId === "modeler-classic" || agentId === "modeler-advanced") {
    const currentBest = keyDecisions.length > 0
      ? (() => {
          const best = keyDecisions.reduce((prev, curr) =>
            (curr.cvMean > prev.cvMean ? curr : prev), keyDecisions[0]
          );
          return {
            modelType: best.modelType,
            cvMean: best.cvMean,
            round: best.roundNumber,
            agent: best.agent,
          };
        })()
      : null;

    return (
      <ModelerInsights
        agentType={agentId === "modeler-classic" ? "classic" : "advanced"}
        currentBest={currentBest}
        hypothesis={reasoning?.hypothesis ?? null}
        learned={reasoning?.learned ?? null}
        nextFocus={reasoning?.next_focus ?? null}
        keyDecisions={keyDecisions}
        totalTrials={keyDecisions.length}
        isLoading={isLoading}
      />
    );
  }

  if (agentId === "reporter") {
    return (
      <ReporterInsights
        arenaReport={getArtifact("arena_report") as Parameters<typeof ReporterInsights>[0]["arenaReport"]}
        competitionTimeline={getArtifact("competition_timeline") as Parameters<typeof ReporterInsights>[0]["competitionTimeline"]}
        isLoading={isLoading}
      />
    );
  }

  if (isLoading) {
    return <LoadingInsight />;
  }

  return (
    <EmptyInsight
      message={`No insights available for ${agentId}`}
      suggestion="This agent type doesn't have a specialized view yet"
    />
  );
}

interface ActivityContentProps {
  agentId: string;
  messages: AgentMessage[];
}

function ActivityContent({ agentId, messages }: ActivityContentProps) {
  return (
    <div className="space-y-4">
      {/* Status */}
      <div className="bg-[var(--bg-secondary)] rounded-lg p-3 border border-[var(--border-default)]">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-green)] animate-pulse" />
          <span className="text-xs font-medium text-[var(--text-primary)]">Agent Active</span>
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          Last activity: {new Date().toLocaleTimeString()}
        </p>
      </div>

      {/* Messages */}
      <div>
        <h4 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
          Inter-Agent Messages
        </h4>
        {messages.length === 0 ? (
          <div className="text-xs text-[var(--text-muted)] text-center py-4">
            No messages exchanged yet
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((msg, i) => (
              <div key={i} className="rounded border border-[var(--border-default)] p-2.5 bg-[var(--bg-secondary)]">
                <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] mb-1.5">
                  <span className="font-medium">From: {msg.from}</span>
                  <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                </div>
                <div className="text-xs text-[var(--text-secondary)] leading-relaxed">{msg.content}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

interface ReportsContentProps {
  artifacts: Array<{ artifactKey: string; content: Record<string, unknown>; contentType?: string }>;
  isLoading: boolean;
}

function ReportsContent({ artifacts, isLoading }: ReportsContentProps) {
  return (
    <div className="space-y-4">
      <h4 className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
        Agent Artifacts
      </h4>
      <ArtifactsSection artifacts={artifacts} isLoading={isLoading} />
    </div>
  );
}

function HistoryContent({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["agent-history", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/leaderboard/agent-history?agent=${agentId}`);
      if (!res.ok) return { failed: [], succeeded: [] };
      return res.json();
    },
  });

  if (isLoading) {
    return <LoadingInsight />;
  }

  const result = data as { failed?: Array<Record<string, unknown>>; succeeded?: Array<Record<string, unknown>> } | null;
  const failed = result?.failed ?? [];
  const succeeded = result?.succeeded ?? [];

  if (failed.length === 0 && succeeded.length === 0) {
    return (
      <EmptyInsight
        message="No cross-run history yet"
        suggestion="History will accumulate across multiple pipeline runs"
      />
    );
  }

  return (
    <div className="space-y-4">
      {succeeded.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-green)]" />
            <h4 className="text-xs font-medium text-[var(--accent-green)]">
              Successful Configs ({succeeded.length})
            </h4>
          </div>
          <div className="space-y-1.5">
            {succeeded.slice(0, 5).map((item, i) => (
              <div
                key={i}
                className="text-xs text-[var(--text-secondary)] rounded border border-[var(--accent-green)]/30 bg-[var(--accent-green)]/5 p-2 font-mono"
              >
                {formatHistoryItem(item)}
              </div>
            ))}
            {succeeded.length > 5 && (
              <div className="text-[10px] text-[var(--text-muted)] text-center">
                +{succeeded.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}

      {failed.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-2 h-2 rounded-full bg-[var(--accent-red)]" />
            <h4 className="text-xs font-medium text-[var(--accent-red)]">
              Failed Configs ({failed.length})
            </h4>
          </div>
          <div className="space-y-1.5">
            {failed.slice(0, 5).map((item, i) => (
              <div
                key={i}
                className="text-xs text-[var(--text-secondary)] rounded border border-[var(--accent-red)]/30 bg-[var(--accent-red)]/5 p-2 font-mono"
              >
                {formatHistoryItem(item)}
              </div>
            ))}
            {failed.length > 5 && (
              <div className="text-[10px] text-[var(--text-muted)] text-center">
                +{failed.length - 5} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatHistoryItem(item: Record<string, unknown>): string {
  const modelType = item.model_type ?? item.MODEL_TYPE ?? "Unknown";
  const cvMean = item.cv_mean ?? item.CV_MEAN;
  const round = item.round ?? item.round_number;

  if (cvMean !== undefined) {
    return `${modelType} • CV: ${Number(cvMean).toFixed(4)}${round ? ` • R${round}` : ""}`;
  }

  return JSON.stringify(item, null, 1).slice(0, 100);
}
