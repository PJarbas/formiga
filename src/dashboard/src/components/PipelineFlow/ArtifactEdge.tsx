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
  delivered: { stroke: "#3fb950", label: "delivered" },
  "in-transit": { stroke: "#58a6ff", label: "in transit" },
  pending: { stroke: "#A0AEC0", label: "pending" },
};

export function ArtifactEdge({ edge, positions }: ArtifactEdgeProps) {
  const from = positions[edge.from];
  const to = positions[edge.to];
  if (!from || !to) return null;

  // Match grid layout: 3 cols × 4 rows, each cell ~320px × 140px with 24px/32px gap
  const COL_WIDTH = 320 + 24; // cell width + horizontal gap
  const ROW_HEIGHT = 140 + 32; // cell height + vertical gap
  const OFFSET_X = 160; // center of cell (320/2)
  const OFFSET_Y = 70; // center of cell (140/2)

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
        strokeWidth={2}
        strokeDasharray={edge.status === "in-transit" ? "6 4" : "none"}
        opacity={edge.status === "pending" ? 0.6 : 0.9}
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
        className="text-[10px]"
        fill="#A0AEC0"
      >
        {edge.artifactLabel}
      </text>
    </g>
  );
}