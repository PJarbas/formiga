/**
 * CollapsibleSection — Seção colapsável com animação suave
 */

import { useState } from "react";

interface CollapsibleSectionProps {
  id: string;
  title: string;
  itemCount?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  level?: 2 | 3;
}

export function CollapsibleSection({
  id,
  title,
  itemCount,
  defaultOpen = false,
  children,
  level = 2,
}: CollapsibleSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const paddingLeft = level === 3 ? "pl-6" : "";

  return (
    <div
      id={id}
      className={`border border-[var(--border-default)] rounded-lg overflow-hidden ${paddingLeft}`}
    >
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`
          w-full flex items-center justify-between gap-3
          px-4 py-3 text-left
          bg-[var(--bg-tertiary)] hover:bg-[var(--bg-secondary)]
          transition-colors duration-150
        `}
        aria-expanded={isOpen}
        aria-controls={`${id}-content`}
      >
        <div className="flex items-center gap-2">
          <span
            className={`
              text-[var(--text-muted)] text-xs transition-transform duration-150
              ${isOpen ? "rotate-90" : ""}
            `}
          >
            ▶
          </span>
          <span className="font-medium text-sm text-[var(--text-primary)]">
            {title}
          </span>
        </div>

        {itemCount !== undefined && itemCount > 0 && (
          <span className="text-[10px] bg-[var(--accent-blue)]/15 text-[var(--accent-blue)] px-2 py-0.5 rounded-full">
            {itemCount} {itemCount === 1 ? "item" : "itens"}
          </span>
        )}
      </button>

      <div
        id={`${id}-content`}
        className={`
          transition-all duration-200 ease-out
          ${isOpen ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0 overflow-hidden"}
        `}
      >
        <div className="p-4 border-t border-[var(--border-default)]">
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Container for multiple collapsible sections ────────────────────────

interface SectionsContainerProps {
  children: React.ReactNode;
}

export function SectionsContainer({ children }: SectionsContainerProps) {
  return <div className="space-y-2">{children}</div>;
}
