// ══════════════════════════════════════════════════════════════════════
// TraceTimeline.tsx — Vertical timeline of trace events
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import type { TraceEntry } from "@shared/dashboard-types";

export interface TraceTimelineProps {
  entries: TraceEntry[];
  collapsed?: boolean;
}

const LEVEL_TO_COLOR: Record<TraceEntry["level"], string> = {
  info: "var(--accent-blue)",
  warn: "var(--accent-orange)",
  error: "var(--accent-red)",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString();
}

export function TraceTimeline({ entries, collapsed = false }: TraceTimelineProps) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(collapsed ? null : 0);

  if (entries.length === 0) {
    return (
      <div data-testid="trace-empty" className="text-sm text-[var(--text-muted)] italic">
        No trace events recorded yet.
      </div>
    );
  }

  return (
    <ol data-testid="trace-timeline" className="space-y-2">
      {entries.map((e, idx) => {
        const color = LEVEL_TO_COLOR[e.level];
        const isOpen = expandedIdx === idx;
        return (
          <li
            key={`${e.timestamp}-${idx}`}
            data-level={e.level}
            className="grid grid-cols-[7rem_1fr] gap-3 text-sm"
          >
            <span className="font-mono text-xs text-[var(--text-muted)] pt-0.5">
              {formatTime(e.timestamp)}
            </span>
            <div>
              <button
                type="button"
                onClick={() => setExpandedIdx(isOpen ? null : idx)}
                data-testid={`trace-row-${idx}`}
                className="text-left w-full"
              >
                <span
                  aria-hidden
                  className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
                  style={{ background: color }}
                />
                <span style={{ color }}>{e.event}</span>
              </button>
              {isOpen && e.detail && (
                <pre
                  data-testid={`trace-detail-${idx}`}
                  className="mt-1 ml-4 text-xs text-[var(--text-secondary)] whitespace-pre-wrap"
                >
                  {e.detail}
                </pre>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
