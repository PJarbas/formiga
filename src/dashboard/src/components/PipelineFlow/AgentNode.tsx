// ══════════════════════════════════════════════════════════════════════
// AgentNode.tsx — Clickable agent node in the pipeline DAG
// Shows status, harness badge, message count, timeout progress
// ══════════════════════════════════════════════════════════════════════

import type { PipelineFlowNode } from "@shared/dashboard-types";

interface AgentNodeProps {
  node: PipelineFlowNode;
  isSelected: boolean;
  onClick: () => void;
}

const STATUS_STYLES: Record<string, { border: string; bg: string; dot: string; label: string }> = {
  idle: { border: "var(--border-default)", bg: "var(--bg-secondary)", dot: "var(--text-muted)", label: "idle" },
  running: { border: "var(--accent-blue)", bg: "var(--bg-secondary)", dot: "var(--accent-blue)", label: "running ⟳" },
  completed: { border: "var(--accent-green)", bg: "var(--bg-secondary)", dot: "var(--accent-green)", label: "done ✓" },
  failed: { border: "var(--accent-red)", bg: "var(--bg-secondary)", dot: "var(--accent-red)", label: "failed ✗" },
  timed_out: { border: "var(--accent-orange)", bg: "var(--bg-secondary)", dot: "var(--accent-orange)", label: "timed out" },
};

const HARNESS_LABELS: Record<string, { text: string; color: string }> = {
  pi: { text: "pi", color: "var(--accent-blue)" },
  hermes: { text: "hermes", color: "var(--accent-orange)" },
  unknown: { text: "?", color: "var(--text-muted)" },
};

export function AgentNode({ node, isSelected, onClick }: AgentNodeProps) {
  const style = STATUS_STYLES[node.status] ?? STATUS_STYLES.idle;
  const harness = HARNESS_LABELS[node.harness] ?? HARNESS_LABELS.unknown;

  return (
    <div
      onClick={onClick}
      className={`
        relative rounded-lg border-2 p-4 cursor-pointer transition-all duration-200
        hover:shadow-lg hover:scale-[1.02] min-w-[180px]
        ${isSelected ? "ring-2 ring-[var(--accent-blue)]" : ""}
      `}
      style={{
        borderColor: style.border,
        backgroundColor: style.bg,
      }}
      data-testid={`agent-node-${node.agentId}`}
    >
      {/* Status dot + label */}
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: style.dot }} />
        <span className="text-xs font-medium" style={{ color: style.dot }}>{style.label}</span>
      </div>

      {/* Agent name */}
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{node.label}</h3>

      {/* Harness badge */}
      <div className="mt-2 flex items-center gap-2">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
          style={{ backgroundColor: `color-mix(in srgb, ${harness.color} 15%, transparent)`, color: harness.color }}
        >
          {harness.text}
        </span>

        {/* Message count badge */}
        {node.messagesCount > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-red)]/10 text-[var(--accent-red)] font-mono">
            📨 {node.messagesCount}
          </span>
        )}
      </div>

      {/* Timeout progress bar */}
      {node.elapsedSeconds != null && node.timeoutSeconds != null && node.status === "running" && (
        <TimeoutProgressBar elapsed={node.elapsedSeconds} total={node.timeoutSeconds} />
      )}

      {/* Artifacts out */}
      {node.artifactsOut.length > 0 && (
        <div className="mt-2 text-[10px] text-[var(--text-muted)] truncate" title={node.artifactsOut.join(", ")}>
          → {node.artifactsOut.join(", ")}
        </div>
      )}
    </div>
  );
}

function TimeoutProgressBar({ elapsed, total }: { elapsed: number; total: number }) {
  const pct = Math.min(100, (elapsed / total) * 100);
  const isWarning = pct > 80;

  return (
    <div className="mt-2 w-full h-1.5 bg-[var(--bg-tertiary)] rounded overflow-hidden">
      <div
        className={`h-full rounded transition-[width] duration-1000 ${isWarning ? "bg-[var(--accent-orange)]" : "bg-[var(--accent-blue)]"}`}
        style={{ width: `${pct}%` }}
      />
      <div className="text-[9px] text-[var(--text-muted)] mt-0.5">
        {elapsed}s / {total}s
      </div>
    </div>
  );
}