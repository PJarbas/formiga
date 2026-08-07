// ══════════════════════════════════════════════════════════════════════
// PipelineEdge.tsx — Bezier edge with arrowhead for React Flow
// Colors by delivery status: green=delivered, blue=in-transit, dark=pending
// ══════════════════════════════════════════════════════════════════════

import { BaseEdge, getBezierPath, MarkerType, type EdgeProps } from "@xyflow/react";
import type { PipelineFlowEdge } from "@shared/dashboard-types";

interface PipelineEdgeData {
  edge: PipelineFlowEdge;
}

const EDGE_STATUS_COLORS: Record<string, string> = {
  delivered: "#3fb950",
  "in-transit": "#58a6ff",
  pending: "#334155",
};

export default function PipelineEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps & { data?: PipelineEdgeData }) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  const status = data?.edge?.status ?? "pending";
  const strokeColor = EDGE_STATUS_COLORS[status] ?? EDGE_STATUS_COLORS.pending;
  const isAnimated = status === "in-transit";

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth: 1.5,
          strokeDasharray: isAnimated ? "6 3" : "none",
        }}
        markerEnd={
          status !== "pending"
            ? MarkerType.ArrowClosed
            : undefined
        }
      />
      {isAnimated && (
        <path
          d={edgePath}
          fill="none"
          stroke={strokeColor}
          strokeWidth={1.5}
          strokeDasharray="6 3"
          className="pipeline-edge-animated"
          opacity={0.5}
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to=" -18"
            dur="0.8s"
            repeatCount="indefinite"
          />
        </path>
      )}
    </>
  );
}
