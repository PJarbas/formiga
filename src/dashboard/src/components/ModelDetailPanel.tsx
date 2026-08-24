// ══════════════════════════════════════════════════════════════════════
// ModelDetailPanel.tsx — slide-over drawer for a single leaderboard entry
// Opens from the right, keeps the table visible, closes on Esc / ✕ / backdrop
// ══════════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { useModelReport, useReproductionScript, downloadReproZip } from "../api/api";
import type { LeaderboardEntry } from "@shared/dashboard-types";
import { StructuredReportTab } from "./report";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

type Tab = "overview" | "report" | "script";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Visão Geral" },
  { id: "report", label: "Relatório" },
  { id: "script", label: "Script de Reprodução" },
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

  // Close on Escape and lock body scroll while the drawer is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Detalhes do modelo ${entry.modelId}`}
        data-testid="model-detail-drawer"
        className="fixed top-0 right-0 z-50 h-full w-full max-w-[480px] bg-[var(--bg-primary)] border-l border-white/10 shadow-2xl flex flex-col animate-slide-in"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <StatusBadge status={entry.status} />
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                {entry.modelId}
              </h3>
              <p className="text-[11px] text-[var(--text-muted)]">
                {entry.modelType} · Round {entry.roundNumber}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors text-lg leading-none px-1 shrink-0"
            aria-label="Close panel"
          >
            &times;
          </button>
        </div>

        {/* Tab bar — pill style */}
        <div className="px-5 py-3 border-b border-white/[0.06] flex gap-1 shrink-0">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? "bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {activeTab === "overview" && <OverviewTab entry={entry} />}
          {activeTab === "report" && (
            <StructuredReportTab content={report?.content} loading={reportLoading} />
          )}
          {activeTab === "script" && (
            <ScriptTab script={scriptData?.script} filename={scriptData?.filename} loading={scriptLoading} entry={entry} />
          )}
        </div>
      </div>
    </>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const config: Record<string, { bg: string; text: string }> = {
    AUDITED: { bg: "bg-[var(--accent-blue)]/10", text: "text-[var(--accent-blue)]" },
    SUCCESS: { bg: "bg-emerald-500/10", text: "text-emerald-400" },
    FAILED: { bg: "bg-[var(--accent-red)]/10", text: "text-[var(--accent-red)]" },
    OVERFITTED: { bg: "bg-[var(--accent-orange)]/10", text: "text-[var(--accent-orange)]" },
    PENDING: { bg: "bg-[var(--bg-tertiary)]", text: "text-[var(--text-muted)]" },
  };
  const c = config[status] ?? config.PENDING;
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded-md font-medium ${c.bg} ${c.text}`}>
      {status}
    </span>
  );
}

function OverviewTab({ entry }: { entry: LeaderboardEntry }) {
  const hp = entry.hyperparameters ?? {};
  const hpEntries = Object.entries(hp);
  const type = entry.problemType ?? "classification";

  return (
    <div className="space-y-6">
      {/* Metrics grid */}
      <section>
        <h4 className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-2">
          Métricas
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard label="Média CV" value={entry.cvMean?.toFixed(4)} />
          <MetricCard label="Desvio CV" value={entry.cvStd?.toFixed(4)} />
          <MetricCard label="Média Treino" value={entry.trainMean?.toFixed(4)} />
          <MetricCard label="Gap Treino/Val" value={entry.trainValGap?.toFixed(4)} highlight={entry.trainValGap > 0.1} />

          {type === "classification" && entry.metrics?.classification && (
            <>
              <MetricCard label="F1-Score" value={entry.metrics.classification.f1?.toFixed(4)} />
              <MetricCard label="Precision" value={entry.metrics.classification.precision?.toFixed(4)} />
              <MetricCard label="Recall" value={entry.metrics.classification.recall?.toFixed(4)} />
              <MetricCard label="ROC-AUC" value={entry.metrics.classification.rocAuc?.toFixed(4)} />
              <MetricCard label="Log Loss" value={entry.metrics.classification.logLoss?.toFixed(4)} />
            </>
          )}

          {type === "regression" && entry.metrics?.regression && (
            <>
              <MetricCard label="RMSE" value={entry.metrics.regression.rmse?.toFixed(4)} />
              <MetricCard label="MAE" value={entry.metrics.regression.mae?.toFixed(4)} />
              <MetricCard label="R²-Score" value={entry.metrics.regression.r2Score?.toFixed(4)} />
            </>
          )}
        </div>
      </section>

      {/* Hyperparameters — env-panel style key/value rows */}
      {hpEntries.length > 0 && (
        <section>
          <h4 className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-2">
            Hiperparâmetros
          </h4>
          <div className="divide-y divide-white/[0.05]">
            {hpEntries.map(([key, val]) => (
              <div key={key} className="flex items-center justify-between gap-4 py-2">
                <span className="font-mono text-xs text-gray-400 shrink-0">{key}</span>
                <span className="font-mono text-xs text-gray-100 text-right truncate">{formatValue(val)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Feature Importances */}
      {entry.featureImportancesTop10 && entry.featureImportancesTop10.length > 0 && (
        <section>
          <h4 className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-2">
            Top Features
          </h4>
          <FeatureBars features={entry.featureImportancesTop10} />
        </section>
      )}

      {/* Arena insights */}
      {(entry.hypothesis || entry.learned) && (
        <section>
          <h4 className="text-[11px] font-medium text-gray-500 uppercase tracking-wider mb-2">
            Insights da Arena
          </h4>
          {entry.hypothesis && (
            <div className="mb-2">
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">Hipótese</div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{cleanInsightText(entry.hypothesis)}</p>
            </div>
          )}
          {entry.learned && (
            <div>
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide mb-1">Aprendizado</div>
              <p className="text-xs text-[var(--text-secondary)] leading-relaxed">{cleanInsightText(entry.learned)}</p>
            </div>
          )}
        </section>
      )}

      {/* Artifact path */}
      {entry.artifactPath && (
        <div className="text-xs text-[var(--text-muted)]">
          <span className="font-medium">Artefato:</span>{" "}
          <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded">{entry.artifactPath}</code>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value?: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg border border-white/5 bg-gray-900/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className={`text-lg font-mono font-semibold mt-1 tabular-nums ${
        highlight ? "text-[var(--accent-orange)]" : "text-gray-100"
      }`}>
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
          <div className="flex-1 h-3 bg-white/[0.06] rounded overflow-hidden">
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

function ScriptTab({ script, filename, loading, entry }: { script?: string; filename?: string; loading: boolean; entry: LeaderboardEntry }) {
  const [isCopied, setIsCopied] = useState(false);
  const [isZipping, setIsZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);

  if (loading) return <LoadingIndicator text="Gerando script..." />;
  if (!script) return <EmptyState text="Não foi possível gerar o script de reprodução." />;

  function handleCopy() {
    navigator.clipboard.writeText(script!);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
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

  async function handleDownloadZip() {
    setZipError(null);
    setIsZipping(true);
    try {
      await downloadReproZip(entry.id);
    } catch (err) {
      setZipError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsZipping(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleDownload}
          className="text-xs px-3 py-1.5 rounded-md border border-[var(--accent-blue)] text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/10 transition-colors"
        >
          Baixar .py
        </button>
        <button
          onClick={handleDownloadZip}
          disabled={isZipping}
          className="text-xs px-3 py-1.5 rounded-md border border-emerald-500/60 text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isZipping ? "Gerando zip..." : "Baixar .zip (pkl + código)"}
        </button>
        {filename && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">{filename}</span>
        )}
      </div>
      {zipError && (
        <p className="text-[11px] text-[var(--accent-red)]" data-testid="zip-error">
          Falha ao gerar o zip: {zipError}
        </p>
      )}
      <div className="relative rounded-lg overflow-hidden" style={{ backgroundColor: "#282c34" }}>
        <button
          onClick={handleCopy}
          className={`absolute top-2 right-2 z-10 text-xs px-2 py-1 rounded transition-colors ${
            isCopied
              ? "bg-green-500/20 text-green-400"
              : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {isCopied ? "✓ Copiado!" : "📋 Copiar"}
        </button>
        <SyntaxHighlighter
          language="python"
          style={oneDark}
          customStyle={{
            margin: 0,
            padding: "1rem",
            maxHeight: "500px",
            fontSize: "12px",
            backgroundColor: "#282c34",
          }}
          showLineNumbers
        >
          {script}
        </SyntaxHighlighter>
      </div>
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

function cleanInsightText(text: string): string {
  if (!text) return "";
  let cleaned = text
    .replace(/\\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/SCRIPT_PATH:\s*\S+/gi, "")
    .replace(/STATUS:\s*\w+/gi, "")
    .replace(/NEXT_FOCUS:\s*.+?(?=\s*(?:STATUS|SCRIPT_PATH|$))/gi, "")
    .replace(/PROXIMO_FOCO:\s*.+?(?=\s*(?:STATUS|SCRIPT_PATH|$))/gi, "")
    .replace(/\{[^{}]*"api"[^{}]*\}/g, "")
    .replace(/\{"[^"]+":[\s\S]*?\}(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const jsonStart = cleaned.indexOf('{"');
  if (jsonStart > 0) {
    cleaned = cleaned.substring(0, jsonStart).trim();
  }
  return cleaned;
}
