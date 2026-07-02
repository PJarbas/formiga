import { useState } from "react";
import Markdown from "react-markdown";
import { useModelReport, useReproductionScript } from "../api/api";
import type { LeaderboardEntry } from "@shared/dashboard-types";

type Tab = "overview" | "report" | "script";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "report", label: "Report" },
  { id: "script", label: "Reproduction Script" },
];

interface Props {
  entry: LeaderboardEntry;
  onClose: () => void;
}

export function ModelDetailPanel({ entry, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const { data: report, isLoading: reportLoading } = useModelReport(
    activeTab === "report" ? entry.id : undefined,
  );
  const { data: scriptData, isLoading: scriptLoading } = useReproductionScript(
    activeTab === "script" ? entry.id : undefined,
  );

  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusBadge status={entry.status} />
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">
            {entry.modelId}
          </h3>
          <span className="text-xs text-[var(--text-muted)]">
            {entry.modelType} · Round {entry.roundNumber}
          </span>
        </div>
        <button
          onClick={onClose}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none px-1"
          aria-label="Close panel"
        >
          &times;
        </button>
      </div>

      {/* Tab bar */}
      <div className="px-5 border-b border-[var(--border-default)] flex gap-1">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-[var(--accent-blue)] text-[var(--accent-blue)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-5">
        {activeTab === "overview" && <OverviewTab entry={entry} />}
        {activeTab === "report" && (
          <ReportTab content={report?.content} loading={reportLoading} />
        )}
        {activeTab === "script" && (
          <ScriptTab script={scriptData?.script} filename={scriptData?.filename} loading={scriptLoading} />
        )}
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    AUDITED: { bg: "bg-[var(--accent-green)]/20", text: "text-[var(--accent-green)]" },
    SUCCESS: { bg: "bg-[var(--accent-blue)]/20", text: "text-[var(--accent-blue)]" },
    FAILED: { bg: "bg-[var(--accent-red)]/20", text: "text-[var(--accent-red)]" },
    OVERFITTED: { bg: "bg-[var(--accent-orange)]/20", text: "text-[var(--accent-orange)]" },
    PENDING: { bg: "bg-[var(--bg-tertiary)]", text: "text-[var(--text-muted)]" },
  };
  const c = config[status] ?? config.PENDING;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${c.bg} ${c.text}`}>
      {status}
    </span>
  );
}

function OverviewTab({ entry }: { entry: LeaderboardEntry }) {
  const hp = entry.hyperparameters ?? {};
  const hpEntries = Object.entries(hp);

  return (
    <div className="space-y-5">
      {/* Metrics grid */}
      <div>
        <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
          Metrics
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <MetricCard label="CV Mean" value={entry.cvMean?.toFixed(4)} />
          <MetricCard label="CV Std" value={entry.cvStd?.toFixed(4)} />
          <MetricCard label="Train Mean" value={entry.trainMean?.toFixed(4)} />
          <MetricCard label="Train/Val Gap" value={entry.trainValGap?.toFixed(4)} highlight={entry.trainValGap > 0.1} />
        </div>
      </div>

      {/* Hyperparameters */}
      {hpEntries.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
            Hyperparameters
          </h4>
          <div className="rounded border border-[var(--border-default)] overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {hpEntries.map(([key, val]) => (
                  <tr key={key} className="border-b border-[var(--border-default)] last:border-0">
                    <td className="px-3 py-1.5 font-mono text-[var(--text-secondary)] bg-[var(--bg-tertiary)] w-1/3">
                      {key}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-[var(--text-primary)]">
                      {formatValue(val)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Feature Importances */}
      {entry.featureImportancesTop10 && entry.featureImportancesTop10.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
            Top Features
          </h4>
          <FeatureBars features={entry.featureImportancesTop10} />
        </div>
      )}

      {/* Artifact path */}
      {entry.artifactPath && (
        <div className="text-xs text-[var(--text-muted)]">
          <span className="font-medium">Artifact:</span>{" "}
          <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">{entry.artifactPath}</code>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value?: string; highlight?: boolean }) {
  return (
    <div className="rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] px-3 py-2">
      <div className="text-[10px] text-[var(--text-muted)] uppercase">{label}</div>
      <div className={`text-sm font-mono font-medium ${highlight ? "text-[var(--accent-orange)]" : "text-[var(--text-primary)]"}`}>
        {value ?? "—"}
      </div>
    </div>
  );
}

function FeatureBars({ features }: { features: Array<[string, number]> }) {
  const maxVal = Math.max(...features.map(([, v]) => Math.abs(v)), 1);
  return (
    <div className="space-y-1">
      {features.map(([name, importance]) => (
        <div key={name} className="flex items-center gap-2">
          <span className="text-xs font-mono text-[var(--text-secondary)] w-32 truncate" title={name}>
            {name}
          </span>
          <div className="flex-1 h-3 bg-[var(--bg-tertiary)] rounded overflow-hidden">
            <div
              className="h-full bg-[var(--accent-blue)] rounded"
              style={{ width: `${(Math.abs(importance) / maxVal) * 100}%` }}
            />
          </div>
          <span className="text-[10px] font-mono text-[var(--text-muted)] w-12 text-right">
            {importance.toFixed(3)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ReportTab({ content, loading }: { content?: string; loading: boolean }) {
  if (loading) return <LoadingIndicator text="Loading report..." />;
  if (!content) return <EmptyState text="No report available for this experiment." />;

  return (
    <div className="prose prose-invert prose-sm max-w-none max-h-[500px] overflow-y-auto rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4">
      <Markdown>{content}</Markdown>
    </div>
  );
}

function ScriptTab({ script, filename, loading }: { script?: string; filename?: string; loading: boolean }) {
  if (loading) return <LoadingIndicator text="Generating script..." />;
  if (!script) return <EmptyState text="Could not generate reproduction script." />;

  function handleCopy() {
    navigator.clipboard.writeText(script!);
  }

  function handleDownload() {
    const blob = new Blob([script!], { type: "text/x-python" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename ?? "reproduce.py";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleCopy}
          className="text-xs px-3 py-1.5 rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        >
          Copy to clipboard
        </button>
        <button
          onClick={handleDownload}
          className="text-xs px-3 py-1.5 rounded border border-[var(--accent-blue)] text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/10 transition-colors"
        >
          Download .py
        </button>
        {filename && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">{filename}</span>
        )}
      </div>
      <pre className="max-h-[500px] overflow-auto rounded border border-[var(--border-default)] bg-[var(--bg-tertiary)] p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre">
        {script}
      </pre>
    </div>
  );
}

function LoadingIndicator({ text }: { text: string }) {
  return <div className="text-xs text-[var(--text-muted)] animate-pulse py-6 text-center">{text}</div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="text-xs text-[var(--text-muted)] py-6 text-center">{text}</div>;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
