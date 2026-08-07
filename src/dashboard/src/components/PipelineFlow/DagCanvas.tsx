// ══════════════════════════════════════════════════════════════════════
// DagCanvas.tsx — React Flow DAG canvas for pipeline visualization
// Dark dot-pattern background, SageMaker-style nodes, Bezier edges.
// ══════════════════════════════════════════════════════════════════════

import { useMemo, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  PipelineFlowNode,
  PipelineFlowEdge,
  WorkflowType,
} from "@shared/dashboard-types";
import PipelineAgentNode from "./PipelineAgentNode";
import PipelineEdge from "./PipelineEdge";

// ── Phase definitions (layout only — not rendered as groups) ────────────

interface PhaseGroup {
  id: string;
  agentIds: string[];
}

const ML_PIPELINE_PHASES: PhaseGroup[] = [
  { id: "analysis", agentIds: ["data-analyst"] },
  { id: "preparation", agentIds: ["feature-engineer"] },
  { id: "arena", agentIds: ["modeler-classic", "modeler-advanced", "ml-critic"] },
];

const ML_AUTORESEARCH_PHASES: PhaseGroup[] = [
  { id: "analysis", agentIds: ["data-analyst"] },
  { id: "preparation", agentIds: ["feature-engineer"] },
  { id: "arena", agentIds: ["arena-modeler-classic", "arena-modeler-advanced"] },
  { id: "results", agentIds: ["reporter"] },
];

function getPhaseLayout(
  workflowType: WorkflowType | undefined
): PhaseGroup[] {
  if (workflowType === "ml-autoresearch") return ML_AUTORESEARCH_PHASES;
  return ML_PIPELINE_PHASES;
}

// ── Layout computation ─────────────────────────────────────────────────

const VERTICAL_SPACING = 160;
const HORIZONTAL_SPACING = 280;
const CANVAS_PADDING_X = 60;
const CANVAS_PADDING_Y = 40;

function computeLayout(
  nodes: PipelineFlowNode[],
  phaseGroups: PhaseGroup[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};

  phaseGroups.forEach((phase, phaseIndex) => {
    const phaseNodes = nodes.filter((n) => phase.agentIds.includes(n.agentId));
    const count = phaseNodes.length;
    const y = phaseIndex * VERTICAL_SPACING + CANVAS_PADDING_Y;

    phaseNodes.forEach((node, agentIndex) => {
      // Center the row of agents
      const offsetX =
        (agentIndex - (count - 1) / 2) * HORIZONTAL_SPACING + 400;
      positions[node.agentId] = { x: offsetX, y };
    });
  });

  return positions;
}

// ── Edge color by status ───────────────────────────────────────────────

const EDGE_COLORS: Record<string, string> = {
  delivered: "#3fb950",
  "in-transit": "#58a6ff",
  pending: "#334155",
};

// ── React Flow node/edge type registration ──────────────────────────────

const nodeTypes = { pipelineAgent: PipelineAgentNode };
const edgeTypes = { pipelineEdge: PipelineEdge };

// ── Props ──────────────────────────────────────────────────────────────

interface DagCanvasProps {
  nodes: PipelineFlowNode[];
  edges: PipelineFlowEdge[];
  phaseGroups?: PhaseGroup[];
  workflowType?: WorkflowType;
  selectedAgent: string | null;
  onNodeClick: (agentId: string) => void;
}

// ── Component ──────────────────────────────────────────────────────────

export default function DagCanvas({
  nodes: pipelineNodes,
  edges: pipelineEdges,
  workflowType,
  selectedAgent,
  onNodeClick,
}: DagCanvasProps) {
  const phaseGroups = useMemo(
    () => getPhaseLayout(workflowType),
    [workflowType]
  );

  // Compute positions from phase groups
  const positions = useMemo(
    () => computeLayout(pipelineNodes, phaseGroups),
    [pipelineNodes, phaseGroups]
  );

  // Build React Flow nodes
  const initialNodes: Node[] = useMemo(
    () =>
      pipelineNodes.map((n) => ({
        id: n.agentId,
        type: "pipelineAgent",
        position: positions[n.agentId] ?? { x: 0, y: 0 },
        data: {
          node: n,
          isSelected: selectedAgent === n.agentId,
          onClick: () => onNodeClick(n.agentId),
        },
      })),
    [pipelineNodes, positions, selectedAgent, onNodeClick]
  );

  // Build React Flow edges
  const initialEdges: Edge[] = useMemo(
    () =>
      pipelineEdges.map((e) => ({
        id: `${e.from}→${e.to}`,
        source: e.from,
        target: e.to,
        type: "pipelineEdge",
        data: { edge: e },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: EDGE_COLORS[e.status] ?? EDGE_COLORS.pending,
        },
        style: {
          stroke: EDGE_COLORS[e.status] ?? EDGE_COLORS.pending,
          strokeWidth: 1.5,
        },
        animated: false,
      })),
    [pipelineEdges]
  );

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState(initialNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Sync state when props change (nodes refetched every 5s)
  useEffect(() => {
    setRfNodes(initialNodes);
    setRfEdges(initialEdges);
  }, [initialNodes, initialEdges, setRfNodes, setRfEdges]);

  return (
    <div className="w-full h-full rounded-lg overflow-hidden border border-[#1e293b]">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
        defaultViewport={{ x: 0, y: 0, zoom: 0.85 }}
      >
        <Background
          variant="dots"
          gap={20}
          size={1}
          color="rgba(148, 163, 184, 0.08)"
        />
        <Controls
          className="[&>button]:!bg-[#1e293b] [&>button]:!border-[#334155] [&>button]:!text-slate-400 [&>button]:!fill-slate-400"
          position="bottom-right"
        />
      </ReactFlow>
    </div>
  );
}
