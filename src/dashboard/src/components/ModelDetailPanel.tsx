import { useState } from "react";
import { useModelReport, useReproductionScript } from "../api/api";
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
                ? "border-[var(--accent-blue)] text-[var(--accent-blue)] opacity-100"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] opacity-50 hover:opacity-80"
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
          <StructuredReportTab content={report?.content} loading={reportLoading} />
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
  const type = entry.problemType ?? "classification";

  return (
    <div className="space-y-5">
      {/* Metrics grid */}
      <div>
        <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
          Métricas
        </h4>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
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
      </div>

      {/* Hyperparameters */}
      {hpEntries.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
            Hiperparâmetros
          </h4>
          <div className="rounded border border-[var(--border-default)] overflow-hidden">
            <table className="w-full text-xs">
              <tbody>
                {hpEntries.map(([key, val]) => (
                  <tr key={key} className="border-b border-[var(--border-default)] last:border-0">
                    <td className="px-3 py-3 font-mono text-gray-400 bg-[var(--bg-tertiary)] w-1/3">
                      {key}
                    </td>
                    <td className="px-3 py-3 font-mono text-white">
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

      {/* Arena insights */}
      {(entry.hypothesis || entry.learned) && (
        <div>
          <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-2">
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
        </div>
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
    <div className="px-3 py-2">
      <div className="text-[10px] text-gray-400 uppercase tracking-wide">{label}</div>
      <div className={`text-xl font-mono font-bold mt-1 ${highlight ? "text-[var(--accent-orange)]" : "text-white"}`}>
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


function ScriptTab({ script, filename, loading }: { script?: string; filename?: string; loading: boolean }) {
  const [isCopied, setIsCopied] = useState(false);

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

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          onClick={handleDownload}
          className="text-xs px-3 py-1.5 rounded border border-[var(--accent-blue)] text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/10 transition-colors"
        >
          Baixar .py
        </button>
        {filename && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">{filename}</span>
        )}
      </div>
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
