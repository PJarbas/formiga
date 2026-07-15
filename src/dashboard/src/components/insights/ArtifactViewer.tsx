// ══════════════════════════════════════════════════════════════════════
// ArtifactViewer.tsx — Modal for viewing artifact content (JSON/Markdown)
// Supports syntax highlighting, copy, download
// ══════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";

interface ArtifactViewerProps {
  artifactKey: string;
  content: Record<string, unknown> | string;
  contentType?: string;
  onClose: () => void;
}

export function ArtifactViewer({ artifactKey, content, contentType = "json", onClose }: ArtifactViewerProps) {
  const [copied, setCopied] = useState(false);

  const displayContent = typeof content === "string" ? content : JSON.stringify(content, null, 2);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(displayContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const extension = contentType === "json" ? ".json" : contentType === "markdown" ? ".md" : ".txt";
    const mimeType = contentType === "json" ? "application/json" : "text/plain";
    const blob = new Blob([displayContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifactKey}${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-[var(--bg-primary)] rounded-lg shadow-2xl border border-[var(--border-default)] w-[90vw] max-w-4xl max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <span className="text-lg">📄</span>
            <h3 className="text-sm font-semibold text-[var(--text-primary)] font-mono">
              {artifactKey}
            </h3>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
              {contentType}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="px-2 py-1 text-xs rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
            >
              {copied ? "✓ Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownload}
              className="px-2 py-1 text-xs rounded bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] transition-colors"
            >
              Download
            </button>
            <button
              onClick={onClose}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-lg px-1"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {contentType === "markdown" ? (
            <MarkdownRenderer content={displayContent} />
          ) : (
            <pre className="text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
              <JsonHighlight content={displayContent} />
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function JsonHighlight({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <>
      {lines.map((line, i) => (
        <div key={i} className="hover:bg-[var(--bg-secondary)] px-1 -mx-1 rounded">
          <span className="text-[var(--text-muted)] select-none w-8 inline-block text-right mr-3 opacity-50">
            {i + 1}
          </span>
          <JsonLineHighlight line={line} />
        </div>
      ))}
    </>
  );
}

function JsonLineHighlight({ line }: { line: string }) {
  const keyMatch = line.match(/^(\s*)"([^"]+)":/);
  const stringMatch = line.match(/:\s*"([^"]*)"(,?)$/);
  const numberMatch = line.match(/:\s*(-?\d+\.?\d*)(,?)$/);
  const boolMatch = line.match(/:\s*(true|false|null)(,?)$/);

  if (keyMatch) {
    const [, indent, key] = keyMatch;
    const rest = line.slice(keyMatch[0].length);

    let valueElement: React.ReactNode = <span className="text-[var(--text-secondary)]">{rest}</span>;

    if (stringMatch) {
      const [, value, comma] = stringMatch;
      valueElement = (
        <>
          <span className="text-[var(--text-muted)]">: "</span>
          <span className="text-[var(--accent-green)]">{value}</span>
          <span className="text-[var(--text-muted)]">"{comma}</span>
        </>
      );
    } else if (numberMatch) {
      const [, value, comma] = numberMatch;
      valueElement = (
        <>
          <span className="text-[var(--text-muted)]">: </span>
          <span className="text-[var(--accent-blue)]">{value}</span>
          <span className="text-[var(--text-muted)]">{comma}</span>
        </>
      );
    } else if (boolMatch) {
      const [, value, comma] = boolMatch;
      valueElement = (
        <>
          <span className="text-[var(--text-muted)]">: </span>
          <span className="text-[var(--accent-yellow)]">{value}</span>
          <span className="text-[var(--text-muted)]">{comma}</span>
        </>
      );
    }

    return (
      <>
        <span>{indent}</span>
        <span className="text-[var(--accent-blue)]">"{key}"</span>
        {valueElement}
      </>
    );
  }

  return <span className="text-[var(--text-secondary)]">{line}</span>;
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <div className="prose prose-sm prose-invert max-w-none">
      {lines.map((line, i) => {
        if (line.startsWith("# ")) {
          return <h1 key={i} className="text-xl font-bold text-[var(--text-primary)] mt-4 mb-2">{line.slice(2)}</h1>;
        }
        if (line.startsWith("## ")) {
          return <h2 key={i} className="text-lg font-semibold text-[var(--text-primary)] mt-3 mb-2">{line.slice(3)}</h2>;
        }
        if (line.startsWith("### ")) {
          return <h3 key={i} className="text-base font-semibold text-[var(--text-primary)] mt-2 mb-1">{line.slice(4)}</h3>;
        }
        if (line.startsWith("- ")) {
          return <li key={i} className="text-sm text-[var(--text-secondary)] ml-4">{line.slice(2)}</li>;
        }
        if (line.startsWith("```")) {
          return <div key={i} className="bg-[var(--bg-tertiary)] rounded p-0.5" />;
        }
        if (line.trim() === "") {
          return <div key={i} className="h-2" />;
        }
        return <p key={i} className="text-sm text-[var(--text-secondary)]">{line}</p>;
      })}
    </div>
  );
}

// ── Artifact List Item ─────────────────────────────────────────────────

interface ArtifactListItemProps {
  artifactKey: string;
  artifactPath?: string;
  updatedAt?: string;
  onView: () => void;
}

export function ArtifactListItem({ artifactKey, onView }: ArtifactListItemProps) {
  const icon = artifactKey.endsWith(".json") || artifactKey.includes("_") ? "📄" : "📝";

  return (
    <div className="flex items-center justify-between py-2 px-2 rounded hover:bg-[var(--bg-secondary)] transition-colors group">
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className="text-xs">{icon}</span>
        <span className="text-xs text-[var(--text-primary)] font-mono truncate">{artifactKey}</span>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onView}
          className="px-2 py-0.5 text-[10px] rounded bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] hover:bg-[var(--accent-blue)]/30"
        >
          View
        </button>
      </div>
    </div>
  );
}

// ── Artifacts Section ──────────────────────────────────────────────────

interface Artifact {
  artifactKey: string;
  artifactPath?: string;
  content: Record<string, unknown>;
  contentType?: string;
  updatedAt?: string;
}

interface ArtifactsSectionProps {
  artifacts: Artifact[];
  isLoading?: boolean;
}

export function ArtifactsSection({ artifacts, isLoading }: ArtifactsSectionProps) {
  const [viewingArtifact, setViewingArtifact] = useState<Artifact | null>(null);

  if (isLoading) {
    return (
      <div className="space-y-2 animate-pulse">
        <div className="h-8 bg-[var(--bg-tertiary)] rounded" />
        <div className="h-8 bg-[var(--bg-tertiary)] rounded" />
        <div className="h-8 bg-[var(--bg-tertiary)] rounded" />
      </div>
    );
  }

  if (artifacts.length === 0) {
    return (
      <div className="text-center py-4">
        <span className="text-xs text-[var(--text-muted)]">No artifacts produced yet</span>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-0.5">
        {artifacts.map((artifact) => (
          <ArtifactListItem
            key={artifact.artifactKey}
            artifactKey={artifact.artifactKey}
            artifactPath={artifact.artifactPath}
            updatedAt={artifact.updatedAt}
            onView={() => setViewingArtifact(artifact)}
          />
        ))}
      </div>

      {viewingArtifact && (
        <ArtifactViewer
          artifactKey={viewingArtifact.artifactKey}
          content={viewingArtifact.content}
          contentType={viewingArtifact.contentType}
          onClose={() => setViewingArtifact(null)}
        />
      )}
    </>
  );
}
