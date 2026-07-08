// ══════════════════════════════════════════════════════════════════════
// FoldSparkline.tsx — Mini vertical bar chart for CV fold scores
// ══════════════════════════════════════════════════════════════════════

interface FoldSparklineProps {
  scores: number[];
  width?: number;
  height?: number;
}

export function FoldSparkline({ scores, width = 32, height = 20 }: FoldSparklineProps) {
  if (!scores || scores.length === 0) return <span className="text-[var(--text-muted)] text-xs">—</span>;

  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;

  return (
    <svg width={width} height={height} className="inline-block" aria-label={`${scores.length}-fold CV`}>
      {scores.map((s, i) => {
        const h = Math.max(2, ((s - min) / range) * (height - 2));
        const x = i * (width / scores.length);
        const w = Math.max(1, (width / scores.length) - 1);
        return (
          <rect
            key={i}
            x={x}
            y={height - h}
            width={w}
            height={h}
            fill="var(--accent-blue)"
            opacity={0.7}
            rx={1}
          />
        );
      })}
    </svg>
  );
}