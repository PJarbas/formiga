import { useState } from "react";
import {
  useAgentDetail,
  useAgentLogs,
  useAgentReasoning,
  useChecklist,
  useTrace,
} from "../api/api";
import { AgentReasoning } from "./AgentReasoning";
import { AgentExperiments } from "./AgentExperiments";
import { TraceTimeline } from "./TraceTimeline";
import { InteractiveChecklist } from "./InteractiveChecklist";
import { AgentActivityStream } from "./AgentActivityStream";
import { getStatusConfig } from "../lib/status-config";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";
import type { ChecklistItem } from "@shared/dashboard-types";

type Tab = "activity" | "reasoning" | "experiments" | "timeline" | "logs";

const TABS: { id: Tab; label: string }[] = [
  { id: "activity", label: "Activity" },
  { id: "reasoning", label: "Reasoning" },
  { id: "experiments", label: "Experiments" },
  { id: "timeline", label: "Timeline" },
  { id: "logs", label: "Logs" },
];

const LOG_PAGE_SIZE = 50;

const DEFAULT_FEAT_ENG_CHECKLIST: ChecklistItem[] = [
  { id: "missing", label: "Handle missing values", checked: false, required: true },
  { id: "encode", label: "Encode categorical features", checked: false, required: true },
  { id: "scale", label: "Scale/normalize numerics", checked: false, required: false },
  { id: "leak", label: "Verify no target leakage", checked: false, required: true },
  { id: "doc", label: "Document feature decisions", checked: false, required: false },
];

interface Props {
  agentName: string;
  runId: string;
  onClose: () => void;
}

export function AgentDetailPanel({ agentName, runId, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("activity");
  const [logOffset, setLogOffset] = useState(0);

  const agentInfo = AGENT_INFO_REGISTRY[agentName];
  const { data: detail } = useAgentDetail(agentName);
  const { data: reasoning } = useAgentReasoning(agentName, runId);
  const isRunning = detail?.currentStatus === "running";

  const latestRound = detail?.rounds?.length
    ? Math.max(...detail.rounds.map((r) => r.roundNumber))
    : 0;

  const { data: trace } = useTrace(agentName, latestRound, {
    refetchInterval: isRunning ? 3000 : false,
  });
  const { data: logs } = useAgentLogs(agentName, logOffset, LOG_PAGE_SIZE, {
    refetchInterval: isRunning ? 3000 : false,
    runId,
  });

  const isFeatureEngineer = agentName === "feature-engineer";
  const { data: checklist } = useChecklist(
    isFeatureEngineer ? runId : undefined,
    isFeatureEngineer ? "feat-eng" : undefined,
  );

  const statusConfig = getStatusConfig(detail?.currentStatus ?? "idle");

  return (
    <div
      data-testid="agent-detail-panel"
      className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden"
    >
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${statusConfig.dotClass}`} />
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {agentInfo?.label ?? agentName}
            </h3>
          </div>
          <span className="text-xs text-[var(--text-muted)]">
            {detail?.currentStatus ?? "idle"}
          </span>
          {detail && (
            <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
              <span>Round {latestRound}</span>
              <span>{detail.totalTrials} trials</span>
              <span>{agentInfo?.model}</span>
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none px-1"
          aria-label="Close panel"
        >
          &times;
        </button>
      </div>

      {/* Tab bar */}
      <div className="px-5 border-b border-[var(--border-default)] flex gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-[var(--accent-blue)] text-[var(--accent-blue)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="p-5">
        {activeTab === "activity" && (
          <AgentActivityStream
            runId={runId}
            stepId={agentInfo?.stepId}
            isRunning={isRunning}
          />
        )}

        {activeTab === "reasoning" && (
          <div className="space-y-5">
            {reasoning && <AgentReasoning reasoning={reasoning} />}
            {isFeatureEngineer && runId && (
              <div className="pt-3 border-t border-[var(--border-default)]">
                <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
                  Engineering Checklist
                </h4>
                <InteractiveChecklist
                  runId={runId}
                  phase="feat-eng"
                  items={checklist?.items?.length ? checklist.items : DEFAULT_FEAT_ENG_CHECKLIST}
                />
              </div>
            )}
          </div>
        )}

        {activeTab === "experiments" && <AgentExperiments agentName={agentName} />}

        {activeTab === "timeline" && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              {isRunning && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-green)]/20 text-[var(--accent-green)] animate-pulse">
                  LIVE
                </span>
              )}
              <span className="text-xs text-[var(--text-muted)]">Round {latestRound}</span>
            </div>
            <TraceTimeline entries={trace ?? []} />
          </div>
        )}

        {activeTab === "logs" && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-[var(--text-muted)]">
                {logs ? `${logs.total} entries` : "Loading..."}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLogOffset(Math.max(0, logOffset - LOG_PAGE_SIZE))}
                  disabled={logOffset === 0}
                  className="text-xs px-2 py-1 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40"
                >
                  Prev
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
            <div className="max-h-[300px] overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)]">
              {!logs || logs.entries.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)] text-center py-6">No log entries</p>
              ) : (
                logs.entries.map((entry, i) => (
                  <div
                    key={i}
                    className={`px-3 py-1.5 border-b border-[var(--border-default)] last:border-0 font-mono text-[11px] ${
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
        )}
      </div>
    </div>
  );
}
