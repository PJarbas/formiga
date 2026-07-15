// ══════════════════════════════════════════════════════════════════════
// FigureGallery.tsx — Grid of figure thumbnails with fullscreen modal
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";

interface FigureItem {
  title: string;
  url: string;
  path: string;
  section?: string;
}

interface FigureGalleryProps {
  figures: FigureItem[];
}

export function FigureGallery({ figures }: FigureGalleryProps) {
  const [selected, setSelected] = useState<FigureItem | null>(null);

  if (figures.length === 0) return null;

  // Group by section if present
  const grouped = figures.reduce<Record<string, FigureItem[]>>((acc, fig) => {
    const key = fig.section ?? "Figures";
    if (!acc[key]) acc[key] = [];
    acc[key].push(fig);
    return acc;
  }, {});

  return (
    <div className="space-y-3">
      {Object.entries(grouped).map(([section, items]) => (
        <div key={section}>
          {Object.keys(grouped).length > 1 && (
            <h5 className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mb-1.5">
              {section}
            </h5>
          )}
          <div className="grid grid-cols-2 gap-2">
            {items.map((fig) => (
              <button
                key={fig.path}
                onClick={() => setSelected(fig)}
                className="group text-left rounded-lg border border-[var(--border-default)] overflow-hidden hover:border-[var(--accent-blue)] transition-colors bg-[var(--bg-secondary)]"
              >
                <div className="flex items-center justify-center bg-[var(--bg-tertiary)]" style={{ minHeight: "80px" }}>
                  <img
                    src={fig.url}
                    alt={fig.title}
                    className="max-h-[120px] w-auto object-contain"
                    loading="lazy"
                  />
                </div>
                <div className="px-2 py-1.5">
                  <p className="text-[10px] text-[var(--text-secondary)] truncate" title={fig.title}>
                    {fig.title}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {/* Modal */}
      {selected && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          onClick={() => setSelected(null)}
        >
          <div className="relative max-w-[90vw] max-h-[90vh] flex flex-col">
            <button
              onClick={() => setSelected(null)}
              className="absolute -top-8 right-0 text-white text-lg hover:opacity-80"
            >
              ✕
            </button>
            <img
              src={selected.url}
              alt={selected.title}
              className="max-w-full max-h-[85vh] object-contain rounded shadow-2xl"
            />
            <p className="text-sm text-white mt-2 text-center">{selected.title}</p>
          </div>
        </div>
      )}
    </div>
  );
}
