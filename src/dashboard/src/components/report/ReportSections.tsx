/**
 * ReportSections — Renderiza seções do report em acordeão
 */

import type { ParsedSection } from "../../lib/parseReportMarkdown";
import { CollapsibleSection, SectionsContainer } from "./CollapsibleSection";
import { FeatureTable } from "./FeatureTable";
import Markdown from "react-markdown";

interface ReportSectionsProps {
  sections: ParsedSection[];
}

// Sections that should start expanded
const IMPORTANT_SECTIONS = [
  "hipóteses",
  "baseline",
  "modelo base",
  "features criadas",
  "seleção",
  "métricas",
];

export function ReportSections({ sections }: ReportSectionsProps) {
  if (sections.length === 0) {
    return (
      <div className="text-sm text-[var(--text-muted)] text-center py-6">
        Nenhuma seção encontrada no relatório.
      </div>
    );
  }

  return (
    <SectionsContainer>
      {sections.map((section, index) => {
        const isImportant = IMPORTANT_SECTIONS.some(
          (keyword) => section.titlePt.toLowerCase().includes(keyword)
        );

        return (
          <CollapsibleSection
            key={section.id}
            id={section.id}
            title={`${index + 1}. ${section.titlePt}`}
            itemCount={section.itemCount}
            defaultOpen={isImportant || section.itemCount > 0}
            level={section.level}
          >
            <SectionContent section={section} />
          </CollapsibleSection>
        );
      })}
    </SectionsContainer>
  );
}

// ── Section Content Renderer ───────────────────────────────────────────

interface SectionContentProps {
  section: ParsedSection;
}

function SectionContent({ section }: SectionContentProps) {
  const { tables, content } = section;

  // If section has tables, render them with special styling
  if (tables.length > 0) {
    return (
      <div className="space-y-4">
        {tables.map((table, i) => (
          <FeatureTable
            key={i}
            table={table}
            showImportanceBars={shouldShowBars(section.title)}
          />
        ))}

        {/* Render remaining content as markdown */}
        <ContentWithoutTables content={content} />
      </div>
    );
  }

  // No tables, render as enhanced markdown
  return <EnhancedMarkdown content={content} />;
}

// ── Enhanced Markdown Renderer ─────────────────────────────────────────

function EnhancedMarkdown({ content }: { content: string }) {
  if (!content.trim()) {
    return (
      <div className="text-xs text-[var(--text-muted)] italic">
        Sem informações adicionais.
      </div>
    );
  }

  return (
    <div className="prose prose-invert prose-sm max-w-none">
      <Markdown
        components={{
          // Style code blocks
          code: ({ children, className }) => {
            const isInline = !className;
            if (isInline) {
              return (
                <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[var(--accent-blue)] text-[11px]">
                  {children}
                </code>
              );
            }
            return (
              <code className={`${className} text-xs`}>{children}</code>
            );
          },
          // Style strong/bold
          strong: ({ children }) => (
            <strong className="text-[var(--text-primary)] font-semibold">
              {children}
            </strong>
          ),
          // Style lists
          ul: ({ children }) => (
            <ul className="list-disc list-inside space-y-1 text-[var(--text-secondary)]">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal list-inside space-y-1 text-[var(--text-secondary)]">
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className="text-xs">{children}</li>
          ),
          // Style paragraphs
          p: ({ children }) => (
            <p className="text-xs text-[var(--text-secondary)] mb-2">
              {children}
            </p>
          ),
          // Style headings within sections
          h3: ({ children }) => (
            <h3 className="text-sm font-medium text-[var(--text-primary)] mt-4 mb-2">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="text-xs font-medium text-[var(--text-primary)] mt-3 mb-1">
              {children}
            </h4>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}

// ── Content Without Tables ─────────────────────────────────────────────

function ContentWithoutTables({ content }: { content: string }) {
  // Remove table lines from content
  const lines = content.split('\n');
  const nonTableLines: string[] = [];
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      inTable = true;
      continue;
    }
    if (inTable && !trimmed) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      nonTableLines.push(line);
    }
  }

  const cleanContent = nonTableLines.join('\n').trim();

  if (!cleanContent) return null;

  return <EnhancedMarkdown content={cleanContent} />;
}

// ── Helpers ────────────────────────────────────────────────────────────

function shouldShowBars(title: string): boolean {
  const lower = title.toLowerCase();
  return (
    lower.includes("importance") ||
    lower.includes("stability") ||
    lower.includes("mrmr") ||
    lower.includes("score") ||
    lower.includes("importância") ||
    lower.includes("estabilidade")
  );
}
