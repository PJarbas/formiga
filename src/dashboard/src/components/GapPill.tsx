// ══════════════════════════════════════════════════════════════════════
// GapPill.tsx — Overfitting gap indicator pill
// Green ✓ <0.05 · Yellow ! 0.05-0.15 · Red ✕ >0.15
// ══════════════════════════════════════════════════════════════════════

interface GapPillProps {
  gap: number;
}

export function GapPill({ gap }: GapPillProps) {
  const abs = Math.abs(gap);
  let color: string;
  let symbol: string;

  if (abs < 0.05) {
    color = "var(--accent-green)";
    symbol = "✓";
  } else if (abs < 0.15) {
    color = "var(--accent-orange)";
    symbol = "!";
  } else {
    color = "var(--accent-red)";
    symbol = "✕";
  }

  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded font-mono"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
      title={`Train-Val Gap: ${gap.toFixed(4)}`}
    >
      {symbol} {gap.toFixed(4)}
    </span>
  );
}