// ══════════════════════════════════════════════════════════════════════
// AgentActivityStream.tsx — Real-time tool call activity for agents
// ══════════════════════════════════════════════════════════════════════
// Shows tool calls, thinking blocks, and artifacts from the database
// in a live-updating stream format. Replaces the old empty tabs.
// ══════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from "react";
import { useAgentEvents } from "../api/api";
import type { AgentEventRow } from "@shared/dashboard-types";

const TOOL_ICONS: Record<string, string> = {
  Read: "📖",
  Write: "✏️",
  Edit: "📝",
  Bash: "🖥️",
  Glob: "🔍",
  Grep: "🔎",
  default: "⚙️",
};

function getToolIcon(toolName?: string): string {
  if (!toolName) return TOOL_ICONS.default;
  return TOOL_ICONS[toolName] ?? TOOL_ICONS.default;
}

function getStatusColor(status?: string): string {
  switch (status) {
    case "running":
      return "text-[var(--accent-blue)]";
    case "completed":
      return "text-[var(--accent-green)]";
    case "failed":
      return "text-[var(--accent-red)]";
    default:
      return "text-[var(--text-muted)]";
  }
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatToolArgs(args?: Record<string, unknown>): string | null {
  if (!args) return null;
  // Show file paths or command summaries
  if (args.file_path) return String(args.file_path).split("/").slice(-2).join("/");
  if (args.command) {
    const cmd = String(args.command);
    return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
  }
  if (args.pattern) return String(args.pattern);
  return null;
}

interface EventItemProps {
  event: AgentEventRow;
  isLatest: boolean;
}

function EventItem({ event, isLatest }: EventItemProps) {
  const time = new Date(event.createdAt).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  if (event.eventType === "thinking") {
    return (
      <div className="flex gap-3 py-2 px-3 hover:bg-[var(--bg-tertiary)] rounded transition-colors">
        <span className="text-[var(--text-muted)] font-mono text-[10px] shrink-0 w-16">{time}</span>
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <span className="text-sm">💭</span>
          <div className="flex-1 min-w-0">
            <span className="text-xs text-[var(--text-muted)] italic">Thinking...</span>
            {event.thinking && (
              <p className="text-[11px] text-[var(--text-secondary)] mt-1 line-clamp-2">
                {event.thinking}
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (event.eventType === "step_event") {
    const stepColors: Record<string, string> = {
      claimed: "bg-[var(--accent-blue)]/20 text-[var(--accent-blue)]",
      completed: "bg-[var(--accent-green)]/20 text-[var(--accent-green)]",
      failed: "bg-[var(--accent-red)]/20 text-[var(--accent-red)]",
      retrying: "bg-[var(--accent-orange)]/20 text-[var(--accent-orange)]",
    };
    return (
      <div className="flex gap-3 py-2 px-3 hover:bg-[var(--bg-tertiary)] rounded transition-colors">
        <span className="text-[var(--text-muted)] font-mono text-[10px] shrink-0 w-16">{time}</span>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium uppercase ${stepColors[event.stepEvent ?? ""] ?? ""}`}>
            {event.stepEvent}
          </span>
          <span className="text-xs text-[var(--text-secondary)]">Step {event.stepId.slice(0, 8)}</span>
        </div>
      </div>
    );
  }

  // Tool call event
  const argSummary = formatToolArgs(event.toolArgs);
  const isRunning = event.toolStatus === "running";

  return (
    <div className={`flex gap-3 py-2 px-3 hover:bg-[var(--bg-tertiary)] rounded transition-colors ${isLatest && isRunning ? "bg-[var(--accent-blue)]/5" : ""}`}>
      <span className="text-[var(--text-muted)] font-mono text-[10px] shrink-0 w-16">{time}</span>
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <span className="text-sm">{getToolIcon(event.toolName)}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-[var(--text-primary)]">{event.toolName}</span>
            <span className={`text-[10px] ${getStatusColor(event.toolStatus)}`}>
              {isRunning ? (
                <span className="inline-flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
                  running
                </span>
              ) : (
                event.toolStatus
              )}
            </span>
            {event.durationMs && (
              <span className="text-[10px] text-[var(--text-muted)]">
                {formatDuration(event.durationMs)}
              </span>
            )}
          </div>
          {argSummary && (
            <p className="text-[11px] text-[var(--text-secondary)] mt-0.5 font-mono truncate">
              {argSummary}
            </p>
          )}
          {event.toolResult && event.toolStatus === "failed" && (
            <p className="text-[11px] text-[var(--accent-red)] mt-1 line-clamp-2">
              {event.toolResult}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

interface Props {
  runId?: string;
  stepId?: string;
  isRunning?: boolean;
}

export function AgentActivityStream({ runId, stepId, isRunning }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data, isLoading } = useAgentEvents(runId, {
    stepId,
    limit: 100,
    refetchInterval: isRunning ? 2000 : false,
  });

  if (!runId) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <span className="text-2xl mb-2">💤</span>
        <p className="text-xs text-[var(--text-muted)]">No active pipeline run</p>
        <p className="text-[10px] text-[var(--text-muted)] mt-1">
          Start a run to see agent activity
        </p>
      </div>
    );
  }

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && containerRef.current && data?.events.length) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [data?.events.length, autoScroll]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-[var(--text-muted)]">
        <span className="text-xs">Loading activity...</span>
      </div>
    );
  }

  if (!data || data.events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <span className="text-2xl mb-2">🔍</span>
        <p className="text-xs text-[var(--text-muted)]">No activity recorded yet</p>
        {isRunning && (
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Tool calls will appear here in real-time
          </p>
        )}
      </div>
    );
  }

  // Reverse to show oldest first (chronological order)
  const events = [...data.events].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Header with stats */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)]">
        <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
          <span>{data.events.length} events</span>
          {isRunning && (
            <span className="inline-flex items-center gap-1 text-[var(--accent-green)]">
              <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
              }
            }}
            className="text-[10px] px-2 py-1 rounded bg-[var(--accent-blue)]/10 text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/20 transition-colors"
          >
            Jump to latest
          </button>
        )}
      </div>

      {/* Event stream */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto max-h-[400px]"
      >
        {events.map((event, idx) => (
          <EventItem key={event.id} event={event} isLatest={idx === events.length - 1} />
        ))}
      </div>
    </div>
  );
}
