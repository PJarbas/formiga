// ══════════════════════════════════════════════════════════════════════
// PipelineAgentNode.tsx — SageMaker-inspired compact agent node for React Flow
// Gradient icon block on the left, status indicator on the right.
// ══════════════════════════════════════════════════════════════════════

import { Handle, Position } from "@xyflow/react";
import type { PipelineFlowNode } from "@shared/dashboard-types";

interface PipelineAgentNodeData {
  node: PipelineFlowNode;
  isSelected: boolean;
  onClick: () => void;
}

const AGENT_ICONS: Record<string, string> = {
  "data-analyst": "📊",
  "feature-engineer": "⚙️",
  "modeler-classic": "🧠",
  "modeler-advanced": "🧠",
  "arena-modeler-classic": "🧠",
  "arena-modeler-advanced": "🧠",
  "ml-critic": "🔍",
  "reporter": "📋",
};

const AGENT_GRADIENTS: Record<string, string> = {
  "data-analyst": "from-blue-500 to-cyan-400",
  "feature-engineer": "from-amber-500 to-orange-400",
  "modeler-classic": "from-purple-500 to-pink-400",
  "modeler-advanced": "from-purple-500 to-pink-400",
  "arena-modeler-classic": "from-purple-500 to-pink-400",
  "arena-modeler-advanced": "from-purple-500 to-pink-400",
  "ml-critic": "from-rose-500 to-red-400",
  "reporter": "from-emerald-500 to-teal-400",
};

function StatusBadge({ status, experiments }: { status: string; experiments?: PipelineFlowNode["experiments"] }) {
  // Arena modelers: summarize the pass rate instead of the latest-step glyph.
  // A single red ✗ (latest experiment rejected/crashed) hides the models that
  // did pass — "3/5" shows the pass count at a glance.
  if (experiments && experiments.total > 0) {
    const color =
      experiments.kept === experiments.total
        ? "var(--accent-green)"
        : experiments.kept === 0
          ? "var(--accent-red)"
          : "var(--accent-amber)";
    return (
      <span
        className="text-[11px] leading-none font-mono font-bold tabular-nums"
        style={{ color }}
        title={`${experiments.kept}/${experiments.total} passaram (✓${experiments.kept} ⚠${experiments.rejected} ✗${experiments.crashed})`}
      >
        {experiments.kept}/{experiments.total}
      </span>
    );
  }
  switch (status) {
    case "running":
      return (
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)] animate-pulse" />
        </span>
      );
    case "completed":
      return (
        <span className="text-[var(--accent-green)] text-[11px] leading-none">✓</span>
      );
    case "failed":
    case "timed_out":
    case "crash":
      return (
        <span className="text-[var(--accent-red)] text-[11px] leading-none font-bold">✗</span>
      );
    case "checks_failed":
      return (
        <span className="text-[var(--accent-amber)] text-[11px] leading-none font-bold">⚠</span>
      );
    default:
      return null;
  }
}

function StatusSubtitle({ node }: { node: PipelineFlowNode }) {
  if (node.status === "running") return <span className="text-[10px] text-[var(--accent-blue)]">Running...</span>;
  if (node.experiments && node.experiments.total > 0) {
    return (
      <span className="text-[10px] text-slate-500 font-mono">
        ✓{node.experiments.kept} ⚠{node.experiments.rejected} ✗{node.experiments.crashed}
      </span>
    );
  }
  if (node.bestModel && node.bestMetric != null) {
    return (
      <span className="text-[10px] text-slate-500">
        best: {node.bestModel} <span className="text-[var(--accent-green)] font-mono">{node.bestMetric.toFixed(4)}</span>
      </span>
    );
  }
  return null;
}

export default function PipelineAgentNode({ data }: { data: PipelineAgentNodeData }) {
  const { node, isSelected, onClick } = data;
  const icon = AGENT_ICONS[node.agentId] ?? "🤖";
  const gradient = AGENT_GRADIENTS[node.agentId] ?? "from-slate-500 to-slate-400";

  return (
    <>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div
        onClick={onClick}
        className={`
          relative flex items-stretch rounded-lg overflow-hidden cursor-pointer
          transition-all duration-200 w-[240px]
          bg-[#1e293b] border
          ${isSelected
            ? "border-[var(--accent-blue)] shadow-lg shadow-[var(--accent-blue)]/10"
            : "border-[#334155] hover:border-slate-500 hover:shadow-lg hover:shadow-cyan-500/5"
          }
        `}
      >
        {/* Gradient icon block — SageMaker style */}
        <div
          className={`flex items-center justify-center shrink-0 w-[42px] bg-gradient-to-br ${gradient}`}
        >
          <span className="text-lg">{icon}</span>
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col justify-center px-3 py-2.5 min-w-0">
          {/* Top row: agent name + status badge */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-white truncate">
              {node.label}
            </span>
            <StatusBadge status={node.status} experiments={node.experiments} />
          </div>

          {/* Bottom row: subtitle (status text, counters, or best model) */}
          <div className="mt-0.5">
            <StatusSubtitle node={node} />
          </div>

          {/* Harness badge — tiny pill */}
          <div className="mt-1.5 flex items-center gap-1.5">
            <span className="text-[9px] px-1 py-px rounded font-mono bg-slate-800 text-slate-500">
              {node.harness}
            </span>
            {node.messagesCount > 0 && (
              <span className="text-[9px] text-slate-600">
                📨{node.messagesCount}
              </span>
            )}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </>
  );
}
