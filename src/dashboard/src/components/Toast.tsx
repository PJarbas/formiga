// ══════════════════════════════════════════════════════════════════════
// Toast.tsx — Imperative singleton toast system (no provider/context)
// ══════════════════════════════════════════════════════════════════════
// Usage: import { addToast } from "./components/Toast";
//        addToast("success", "Model approved");
//
// addToast() is a module-level function — no hook dependency.
// ToastContainer renders the fixed top-right stack.
// Max 3 toasts. Success/info auto-dismiss 4s, error persists, warning 6s.
// ══════════════════════════════════════════════════════════════════════

import { useState, useRef, useCallback } from "react";

interface ToastEntry {
  id: string;
  type: "success" | "error" | "warning" | "info";
  message: string;
  createdAt: number;
}

const TOAST_CONFIG = {
  success: {
    emoji: "✅",
    bgClass: "bg-[var(--accent-green)]/10 border-[var(--accent-green)]/30",
    autoDismiss: 4000,
  },
  error: {
    emoji: "❌",
    bgClass: "bg-[var(--accent-red)]/10 border-[var(--accent-red)]/30",
    autoDismiss: null as number | null,
  },
  warning: {
    emoji: "⚠️",
    bgClass: "bg-[var(--accent-orange)]/10 border-[var(--accent-orange)]/30",
    autoDismiss: 6000,
  },
  info: {
    emoji: "ℹ️",
    bgClass: "bg-[var(--accent-blue)]/10 border-[var(--accent-blue)]/30",
    autoDismiss: 4000,
  },
} as const;

// ── Module-level imperative API ────────────────────────────────────
let addToastFn: ((type: ToastEntry["type"], message: string) => void) | null = null;

export function addToast(type: ToastEntry["type"], message: string): void {
  addToastFn?.(type, message);
}

// ── Constants ──────────────────────────────────────────────────────
const MAX_TOASTS = 3;

// ── Container component ────────────────────────────────────────────
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const handleAdd = useCallback((type: ToastEntry["type"], message: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, type, message, createdAt: Date.now() }]);

    const config = TOAST_CONFIG[type];
    if (config.autoDismiss) {
      timers.current.set(
        id,
        setTimeout(() => {
          setToasts((prev) => prev.filter((t) => t.id !== id));
        }, config.autoDismiss),
      );
    }
  }, []);

  // Keep the module-level ref fresh
  addToastFn = handleAdd;

  const dismiss = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2 max-w-sm" role="status" aria-live="polite">
      {toasts.map((t) => {
        const config = TOAST_CONFIG[t.type];
        return (
          <div
            key={t.id}
            className={`flex items-center gap-2 px-4 py-3 rounded-lg border shadow-lg animate-slide-in ${config.bgClass}`}
          >
            <span aria-hidden="true">{config.emoji}</span>
            <p className="text-sm text-[var(--text-primary)] flex-1">{t.message}</p>
            <button
              onClick={() => dismiss(t.id)}
              className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs ml-2"
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}