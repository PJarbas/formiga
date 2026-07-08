// ══════════════════════════════════════════════════════════════════════
// ArtifactEdge.tsx — SVG curved path between agent nodes
// Green = delivered, blue animated = in-transit, gray = pending
// ══════════════════════════════════════════════════════════════════════

import type { PipelineFlowEdge } from "@shared/dashboard-types";

interface ArtifactEdgeProps {
  edge: PipelineFlowEdge;
  positions: Record<string, { row: number; col: number }>;
}

const EDGE_COLORS: Record<string, { stroke: string; label: string }> = {
  delivered: { stroke: "var(--accent-green)", label: "delivered" },
  "in-transit": { stroke: "var(--accent-blue)", label: "in transit" },
  pending: { stroke: "var(--text-muted)", label: "pending" },
};

export function ArtifactEdge({ edge, positions }: ArtifactEdgeProps) {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;

  // Approximate SVG positions based on grid (3 cols, 4 rows)
  const COL_WIDTH = 240;
  const ROW_HEIGHT = 140;
  const OFFSET_X = 90; // center offset for node width
  const OFFSET_Y = 60; // center offset for node height

  const x1 = from.col * COL_WIDTH + OFFSET_X;
  const y1 = from.row * ROW_HEIGHT + OFFSET_Y;
  const x2 = to.col * COL_WIDTH + OFFSET_X;
  const y2 = to.row * ROW_HEIGHT + OFFSET_Y;

  // Curve control points
  const midY = (y1 + y2) / 2;
  const path = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

  const style = EDGE_COLORS[edge.status] ?? EDGE_COLORS.pending;

  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={style.stroke}
        strokeWidth={1.5}
        strokeDasharray={edge.status === "in-transit" ? "6 4" : "none"}
        opacity={edge.status === "pending" ? 0.4 : 0.8}
      >
        {edge.status === "in-transit" && (
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="20"
            dur="1.5s"
            repeatCount="indefinite"
          />
        )}
      </path>
      {/* Edge label */}
      <text
        x={(x1 + x2) / 2}
        y={(y1 + y2) / 2 - 4}
        textAnchor="middle"
        className="text-[9px] fill-[var(--text-muted)]"
      >
        {edge.artifactLabel}
      </text>
    </g>
  );
}