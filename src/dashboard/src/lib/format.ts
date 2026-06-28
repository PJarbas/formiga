// ══════════════════════════════════════════════════════════════════════
// format.ts — Shared formatting functions for the dashboard
// ══════════════════════════════════════════════════════════════════════
// Single source for elapsed time and timestamp formatting.
// Screens and components import from here — never define local formatters.
// ══════════════════════════════════════════════════════════════════════

/** Format milliseconds elapsed as MM:SS */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** Format elapsed between two ISO timestamps as MM:SS */
export function formatElapsedBetween(
  startedAt: string | null,
  updatedAt: string | null,
): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = updatedAt ? new Date(updatedAt).getTime() : Date.now();
  return formatElapsedMs(Math.max(0, end - start));
}

/** Format ISO timestamp to locale time string (HH:MM:SS) */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
}