// ══════════════════════════════════════════════════════════════════════
// Sparkline.tsx — Pure-SVG inline trend line (no chart dependency)
// ══════════════════════════════════════════════════════════════════════

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
}

export function Sparkline({
  data,
  width = 120,
  height = 32,
  stroke = "var(--accent-blue)",
}: SparklineProps) {
  if (data.length < 2) {
    return (
      <svg
        data-testid="sparkline"
        data-empty="true"
        width={width}
        height={height}
        role="img"
        aria-label="No trend data"
      />
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      data-testid="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Trend"
    >
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
}
