// ══════════════════════════════════════════════════════════════════════
// AgentSidePanel.tsx — Slide-in panel with 5 tabs for agent details
// Logs · Reasoning · Messages · Artifacts · History
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_INFO_REGISTRY } from "@shared/dashboard-types";
import type { AgentMessage } from "@shared/dashboard-types";

type TabId = "logs" | "reasoning" | "messages" | "artifacts" | "history";

const TABS: { id: TabId; label: string }[] = [
  { id: "logs", label: "Logs" },
  { id: "reasoning", label: "Reasoning" },
  { id: "messages", label: "Messages" },
  { id: "artifacts", label: "Artifacts" },
  { id: "history", label: "History" },
];

interface AgentSidePanelProps {
  agentId: string;
  onClose: () => void;
}

export function AgentSidePanel({ agentId, onClose }: AgentSidePanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("logs");

  const info = AGENT_INFO_REGISTRY[agentId];

  const { data: messages } = useQuery<AgentMessage[]>({
    queryKey: ["agent-messages", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/messages`);
      if (!res.ok) return [];
      return res.json();
    },
    refetchInterval: 5000,
    enabled: activeTab === "messages",
  });

  const { data: agentDetail } = useQuery({
    queryKey: ["agent-detail", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: activeTab === "reasoning" || activeTab === "history",
  });

  return (
    <div
      className="fixed top-0 right-0 h-full w-96 bg-[var(--bg-primary)] border-l border-[var(--border-default)] shadow-xl z-50 flex flex-col animate-slide-in"
      data-testid="agent-side-panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {info?.label ?? agentId}
          </h3>
          <p className="text-[10px] text-[var(--text-muted)]">{info?.description?.slice(0, 60)}...</p>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg"
        >
          ✕
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-[var(--border-default)]">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-2 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? "text-[var(--accent-blue)] border-b-2 border-[var(--accent-blue)]"
                : "text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === "logs" && <LogsContent agentId={agentId} />}
        {activeTab === "reasoning" && <ReasoningContent agentId={agentId} detail={agentDetail} />}
        {activeTab === "messages" && <MessagesContent messages={messages ?? []} />}
        {activeTab === "artifacts" && <ArtifactsContent agentId={agentId} info={info} />}
        {activeTab === "history" && <HistoryContent agentId={agentId} />}
      </div>
    </div>
  );
}

function LogsContent({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["agent-logs", agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/logs?limit=100`);
      if (!res.ok) return { entries: [] };
      return res.json();
    },
    refetchInterval: 5000,
  });

  if (isLoading) return <div className="text-xs text-[var(--text-muted)]">Loading logs...</div>;

  const entries = (data as { entries?: Array<{ timestamp: string; level: string; message: string }> })?.entries ?? [];

  if (entries.length === 0) {
    return <div className="text-xs text-[var(--text-muted)]">No logs yet</div>;
  }

  return (
    <div className="space-y-1 font-mono text-[11px]">
      {entries.map((entry, i) => (
        <div key={i} className="flex gap-2">
          <span className="text-[var(--text-muted)] shrink-0">{new Date(entry.timestamp).toLocaleTimeString()}</span>
          <span className={entry.level === "error" ? "text-[var(--accent-red)]" : "text-[var(--text-secondary)]"}>
            {entry.message}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReasoningContent({ agentId, detail }: { agentId: string; detail: unknown }) {
  // Placeholder — will be wired to /api/agents/:name/reasoning
  return (
    <div className="text-xs text-[var(--text-muted)]">
      <p>Reasoning data for {agentId} will appear here once available.</p>
      <p className="mt-2">This tab shows the agent's decision-making process and hypothesis evolution.</p>
    </div>
  );
}

function MessagesContent({ messages }: { messages: AgentMessage[] }) {
  if (messages.length === 0) {
    return <div className="text-xs text-[var(--text-muted)]">No inter-agent messages yet</div>;
  }

  return (
    <div className="space-y-2">
      {messages.map((msg, i) => (
        <div key={i} className="rounded border border-[var(--border-default)] p-2">
          <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] mb-1">
            <span>From: {msg.from}</span>
            <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
          </div>
          <div className="text-xs text-[var(--text-secondary)]">{msg.content}</div>
        </div>
      ))}
    </div>
  );
}

function ArtifactsContent({ agentId, info }: { agentId: string; info: typeof AGENT_INFO_REGISTRY[string] | undefined }) {
  const artifacts = info?.artifactsOut ?? [];

  if (artifacts.length === 0) {
    return <div className="text-xs text-[var(--text-muted)]">No artifacts tracked</div>;
  }

  return (
    <div className="space-y-2">
      {artifacts.map((name) => (
        <div key={name} className="flex items-center justify-between rounded border border-[var(--border-default)] p-2">
          <span className="text-xs text-[var(--text-primary)] font-mono">{name}</span>
          <a
            href={`/api/runs/latest/artifacts/${name}`}
            className="text-[10px] text-[var(--accent-blue)] hover:underline"
          >
            download
          </a>
        </div>
      ))}
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

  if (isLoading) return <div className="text-xs text-[var(--text-muted)]">Loading history...</div>;

  const result = data as { failed?: unknown[]; succeeded?: unknown[] } | null;
  const failed = result?.failed ?? [];
  const succeeded = result?.succeeded ?? [];

  return (
    <div className="space-y-4">
      {succeeded.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-[var(--accent-green)] mb-2">Successful Configs</h4>
          <div className="space-y-1">
            {succeeded.map((item, i) => (
              <div key={i} className="text-xs text-[var(--text-secondary)] rounded border border-[var(--border-default)] p-2">
                {JSON.stringify(item, null, 1).slice(0, 200)}
              </div>
            ))}
          </div>
        </div>
      )}
      {failed.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-[var(--accent-red)] mb-2">Failed Configs</h4>
          <div className="space-y-1">
            {failed.map((item, i) => (
              <div key={i} className="text-xs text-[var(--text-secondary)] rounded border border-[var(--border-default)] p-2">
                {JSON.stringify(item, null, 1).slice(0, 200)}
              </div>
            ))}
          </div>
        </div>
      )}
      {failed.length === 0 && succeeded.length === 0 && (
        <div className="text-xs text-[var(--text-muted)]">No cross-run history yet</div>
      )}
    </div>
  );
}