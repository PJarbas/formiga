// ══════════════════════════════════════════════════════════════════════
// InteractiveChecklist.tsx — Toggleable checklist persisted to backend
// ──────────────────────────────────────────────────────────────────────
// Owns the mutation (PUT /api/checklist/:runId/:phase) so it can drive
// optimistic update + rollback. Parent only supplies runId, phase, items.
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import type { ChecklistItem } from "@shared/dashboard-types";
import { useChecklistMutation } from "../api/api.js";

export interface InteractiveChecklistProps {
  runId: string;
  phase: string;
  items: ChecklistItem[];
  /** Optional override for the mutation — primarily for testing. */
  onMutate?: (items: ChecklistItem[]) => Promise<ChecklistItem[]>;
}

export function InteractiveChecklist({
  runId,
  phase,
  items,
  onMutate,
}: InteractiveChecklistProps) {
  const [local, setLocal] = useState<ChecklistItem[]>(items);
  const [error, setError] = useState<string | null>(null);
  const mutation = useChecklistMutation(runId, phase);

  const inFlight = mutation.isPending;

  async function toggle(id: string): Promise<void> {
    const prev = local;
    const next = local.map((it) => (it.id === id ? { ...it, checked: !it.checked } : it));
    setLocal(next);
    setError(null);
    try {
      if (onMutate) {
        const updated = await onMutate(next);
        setLocal(updated);
      } else {
        const state = await mutation.mutateAsync(next);
        setLocal(state.items);
      }
    } catch (err) {
      setLocal(prev);
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  return (
    <div data-testid="interactive-checklist" className="space-y-2">
      {local.length === 0 && (
        <div className="text-sm text-[var(--text-muted)] italic">No checklist items.</div>
      )}
      {local.map((item) => (
        <label
          key={item.id}
          data-item-id={item.id}
          className={`flex items-start gap-2 cursor-pointer text-sm ${
            inFlight ? "opacity-60" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={item.checked}
            disabled={inFlight}
            onChange={() => toggle(item.id)}
            data-testid={`checkbox-${item.id}`}
          />
          <span className={item.checked ? "text-[var(--text-secondary)] line-through" : ""}>
            {item.label}
            {item.required && (
              <span className="ml-1 text-[var(--accent-red)]" title="Required">
                *
              </span>
            )}
          </span>
        </label>
      ))}
      {error && (
        <div data-testid="checklist-error" className="text-xs text-[var(--accent-red)]">
          {error}
        </div>
      )}
    </div>
  );
}
