/**
 * ReportRawToggle — Toggle para ver o markdown original
 */

import { useState } from "react";
import { UI_LABELS } from "../../lib/reportTranslations";

interface ReportRawToggleProps {
  content: string;
}

export function ReportRawToggle({ content }: ReportRawToggleProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-6 border-t border-[var(--border-default)] pt-4">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="
          flex items-center gap-2 text-xs text-[var(--text-muted)]
          hover:text-[var(--text-secondary)] transition-colors
        "
      >
        <span>{isOpen ? "▼" : "▶"}</span>
        <span className="font-mono">
          {isOpen ? UI_LABELS.hideRawMarkdown : UI_LABELS.viewRawMarkdown}
        </span>
      </button>

      {isOpen && (
        <div className="mt-3">
          <div className="flex items-center justify-end gap-2 mb-2">
            <button
              onClick={handleCopy}
              className="
                text-xs px-3 py-1.5 rounded
                border border-[var(--border-default)]
                text-[var(--text-secondary)]
                hover:text-[var(--text-primary)]
                hover:border-[var(--text-muted)]
                transition-colors
              "
            >
              {copied ? "✓ Copiado!" : `📋 ${UI_LABELS.copyToClipboard}`}
            </button>
          </div>

          <pre
            className="
              max-h-[400px] overflow-auto
              rounded border border-[var(--border-default)]
              bg-[var(--bg-tertiary)] p-4
              text-[11px] font-mono text-[var(--text-secondary)]
              whitespace-pre-wrap break-words
            "
          >
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
