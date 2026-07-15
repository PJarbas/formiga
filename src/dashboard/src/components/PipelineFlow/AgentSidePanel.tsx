// ══════════════════════════════════════════════════════════════════════
// AgentSidePanel.tsx — Slide-in panel with insights + reports tabs
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

interface AgentFigure {
  title: string;
  url: string;
  path: string;
  section?: string;
}

interface AgentDecision {
  key: string;
  decision_type?: string;
  description?: string;
  reasoning?: string;
  alternatives_considered?: string[];
  timestamp?: string;
  loggedAt: string;
}

interface AgentMetric {
  key: string;
  name?: string;
  value?: number;
  tags?: Record<string, string>;
  timestamp?: string;
  loggedAt: string;
}

interface AgentLegacyFile {
  path: string;
  url: string;
  size?: number;
}

type TabId = "insights" | "reports";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "insights", label: "Insights", icon: "💡" },
  { id: "reports", label: "Reports", icon: "📄" },
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
            const envelope = await res.json();
            const content = envelope?.content ?? envelope;
            return {
              artifactKey: key,
              content,
              contentType: envelope?.contentType ?? "json",
            };
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

  // Fetch figures (filesystem discovery)
  const { data: figures } = useQuery<AgentFigure[]>({
    queryKey: ["agent-figures", agentId, runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId ?? "latest"}/agents/${agentId}/figures`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.figures ?? []) as AgentFigure[];
    },
    refetchInterval: 10000,
    enabled: !!runId && (activeTab === "insights" || activeTab === "reports"),
  });

  // Fetch decisions
  const { data: decisions } = useQuery<AgentDecision[]>({
    queryKey: ["agent-decisions", agentId, runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId ?? "latest"}/agents/${agentId}/decisions`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.decisions ?? []) as AgentDecision[];
    },
    refetchInterval: 10000,
    enabled: !!runId && (activeTab === "reports" || agentId === "data-analyst"),
  });

  // Fetch metrics
  const { data: metrics } = useQuery<AgentMetric[]>({
    queryKey: ["agent-metrics", agentId, runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId ?? "latest"}/agents/${agentId}/metrics`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.metrics ?? []) as AgentMetric[];
    },
    refetchInterval: 10000,
    enabled: !!runId && activeTab === "reports",
  });

  // Fetch legacy files
  const { data: legacyFiles } = useQuery<AgentLegacyFile[]>({
    queryKey: ["agent-legacy-files", agentId, runId],
    queryFn: async () => {
      const res = await fetch(`/api/runs/${runId ?? "latest"}/agents/${agentId}/legacy-files`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data?.files ?? []) as AgentLegacyFile[];
    },
    refetchInterval: 15000,
    enabled: !!runId && activeTab === "reports",
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

  const baseAgentName = agentId.replace(/^arena-/, "");

  // Helper to get artifact by key
  const getArtifact = (key: string) => {
    const artifact = artifacts?.find((a) => a?.artifactKey === key);
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
            keyDecisions={decisions ?? []}
            figures={figures ?? []}
            decisions={decisions ?? []}
            isLoading={artifactsLoading || reasoningLoading}
          />
        )}
        {activeTab === "reports" && (
          <ReportsContent
            artifacts={artifacts ?? []}
            figures={figures ?? []}
            decisions={decisions ?? []}
            metrics={metrics ?? []}
            legacyFiles={legacyFiles ?? []}
            isLoading={artifactsLoading}
          />
        )}
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
    "arena-modeler-classic": "🌲",
    "arena-modeler-advanced": "🧠",
    reporter: "📝",
  };
  return icons[agentId] ?? "🤖";
}

interface InsightsContentProps {
  agentId: string;
  artifacts: Array<{ artifactKey: string; content: Record<string, unknown> }>;
  reasoning: { hypothesis?: string; learned?: string; next_focus?: string } | null;
  keyDecisions: AgentKeyDecision[];
  figures: AgentFigure[];
  decisions: AgentDecision[];
  isLoading: boolean;
}

function InsightsContent({ agentId, artifacts, reasoning, keyDecisions, figures, decisions, isLoading }: InsightsContentProps) {
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
        figures={figures}
        decisions={decisions}
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
        figures={figures}
        decisions={decisions}
        isLoading={isLoading}
      />
    );
  }

  if (
    agentId === "modeler-classic" ||
    agentId === "modeler-advanced" ||
    agentId === "arena-modeler-classic" ||
    agentId === "arena-modeler-advanced"
  ) {
    const agentType: "classic" | "advanced" =
      agentId === "modeler-classic" || agentId === "arena-modeler-classic" ? "classic" : "advanced";

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
        agentType={agentType}
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

interface ReportsContentProps {
  artifacts: Array<{ artifactKey: string; content: Record<string, unknown>; contentType?: string }>;
  figures: AgentFigure[];
  decisions: AgentDecision[];
  metrics: AgentMetric[];
  legacyFiles: AgentLegacyFile[];
  isLoading: boolean;
}

function ReportsContent({ artifacts, figures, decisions, metrics, legacyFiles, isLoading }: ReportsContentProps) {
  const [openSection, setOpenSection] = useState<string | null>("artifacts");

  if (isLoading) return <LoadingInsight />;

  const sections = [
    { id: "artifacts", label: "Artifacts", icon: "📁", badge: artifacts.length, items: artifacts.length > 0 },
    { id: "figures", label: "Figures", icon: "📈", badge: figures.length, items: figures.length > 0 },
    { id: "decisions", label: "Decisions", icon: "🧭", badge: decisions.length, items: decisions.length > 0 },
    { id: "metrics", label: "Metrics", icon: "📊", badge: metrics.length, items: metrics.length > 0 },
    { id: "legacy", label: "Legacy Files", icon: "📜", badge: legacyFiles.length, items: legacyFiles.length > 0 },
  ];

  return (
    <div className="space-y-3">
      {sections.map((sec) => (
        <div key={sec.id}>
          <button
            onClick={() => setOpenSection(openSection === sec.id ? null : sec.id)}
            className="w-full flex items-center gap-2 py-2 text-left"
          >
            <span className="text-xs">{sec.icon}</span>
            <span className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wide">
              {sec.label}
            </span>
            {sec.items && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {sec.badge}
              </span>
            )}
            <span className="ml-auto text-[var(--text-muted)] text-xs">
              {openSection === sec.id ? "▼" : "▶"}
            </span>
          </button>

          {openSection === sec.id && (
            <div className="mt-1">
              {sec.id === "artifacts" && (
                <ArtifactsSection artifacts={artifacts} isLoading={isLoading} />
              )}
              {sec.id === "figures" && (
                <FiguresSection figures={figures} />
              )}
              {sec.id === "decisions" && (
                <DecisionsSection decisions={decisions} />
              )}
              {sec.id === "metrics" && (
                <MetricsSection metrics={metrics} />
              )}
              {sec.id === "legacy" && (
                <LegacyFilesSection files={legacyFiles} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function FiguresSection({ figures }: { figures: AgentFigure[] }) {
  if (figures.length === 0) {
    return (
      <EmptyInsight
        message="No figures found"
        suggestion="Figures are discovered from the run workspace. Run the agent to generate charts."
      />
    );
  }

  const [selected, setSelected] = useState<AgentFigure | null>(null);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {figures.map((fig) => (
          <button
            key={fig.path}
            onClick={() => setSelected(fig)}
            className="group text-left rounded-lg border border-[var(--border-default)] overflow-hidden hover:border-[var(--accent-blue)] transition-colors bg-[var(--bg-secondary)]"
          >
            <div className="flex items-center justify-center bg-[var(--bg-tertiary)]" style={{ minHeight: "80px" }}>
              <img
                src={fig.url}
                alt={fig.title}
                className="max-h-[120px] w-auto object-contain"
                loading="lazy"
              />
            </div>
            <div className="px-2 py-1.5">
              <p className="text-[10px] text-[var(--text-secondary)] truncate" title={fig.title}>
                {fig.title}
              </p>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col">
            <button
              onClick={() => setSelected(null)}
              className="absolute -top-8 right-0 text-white text-lg hover:opacity-80"
            >
              ✕
            </button>
            <img
              src={selected.url}
              alt={selected.title}
              className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl"
            />
            <p className="text-sm text-white mt-2 text-center">{selected.title}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function DecisionsSection({ decisions }: { decisions: AgentDecision[] }) {
  if (decisions.length === 0) {
    return (
      <EmptyInsight
        message="No decisions logged yet"
        suggestion="Decisions are logged via log_decision tool by the agent"
      />
    );
  }

  return (
    <div className="space-y-2">
      {decisions.map((dec, i) => (
        <div
          key={dec.key ?? i}
          className="rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5 text-xs"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[10px] font-semibold uppercase text-[var(--accent-blue)] bg-[var(--accent-blue)]/10 px-1.5 py-0.5 rounded">
              {dec.decision_type ?? "decision"}
            </span>
            <span className="text-[10px] text-[var(--text-muted)] ml-auto">
              {dec.timestamp ? new Date(dec.timestamp).toLocaleDateString() : dec.loggedAt ? new Date(dec.loggedAt).toLocaleDateString() : ""}
            </span>
          </div>
          <p className="text-[var(--text-primary)] leading-relaxed">{dec.description}</p>
          {dec.reasoning && (
            <p className="mt-1 text-[10px] text-[var(--text-muted)] italic">{dec.reasoning}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function MetricsSection({ metrics }: { metrics: AgentMetric[] }) {
  if (metrics.length === 0) {
    return (
      <EmptyInsight
        message="No metrics reported yet"
        suggestion="Metrics are logged via report_metric tool by the agent"
      />
    );
  }

  return (
    <div className="space-y-2">
      {metrics.map((m, i) => (
        <div
          key={m.key ?? i}
          className="flex items-center justify-between rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5"
        >
          <div className="text-xs">
            <span className="text-[var(--text-primary)] font-medium">{m.name ?? m.key}</span>
            {m.tags && Object.keys(m.tags).length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {Object.entries(m.tags).map(([k, v]) => (
                  <span
                    key={k}
                    className="text-[9px] px-1 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
                  >
                    {k}={v}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="text-sm font-mono font-bold text-[var(--accent-blue)]">
            {m.value !== undefined ? m.value.toFixed(4) : "—"}
          </div>
        </div>
      ))}
    </div>
  );
}

function LegacyFilesSection({ files }: { files: AgentLegacyFile[] }) {
  if (files.length === 0) {
    return (
      <EmptyInsight
        message="No legacy files found"
        suggestion="Files are discovered from the run workspace (.md, .json, .txt, .csv, .log, .py)"
      />
    );
  }

  return (
    <div className="space-y-1">
      {files.map((f) => (
        <a
          key={f.path}
          href={f.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-between rounded border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2 hover:border-[var(--accent-blue)] transition-colors no-underline"
        >
          <div className="text-xs text-[var(--text-primary)] truncate max-w-[240px]">
            {f.path}
          </div>
          {f.size !== undefined && (
            <span className="text-[10px] text-[var(--text-muted)] font-mono">
              {formatBytes(f.size)}
            </span>
          )}
        </a>
      ))}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
