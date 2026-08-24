// ══════════════════════════════════════════════════════════════════════
// activity-timeout.ts — Activity-rearmed timeout for harness child processes
// ══════════════════════════════════════════════════════════════════════
//
// A fixed wall-clock timeout is the wrong kill criterion for long-running
// harness children (pi/opencode/hermes): an agent that keeps emitting output
// (tool calls, stream events) is working, not stuck. This helper implements
// two independent bounds:
//   - hard: an absolute ceiling that is NEVER re-armed — a runaway agent can
//     not outlive it, no matter how chatty.
//   - stale: when notifyActivity() is wired to the child's stdout and no
//     activity arrives for `staleMs`, the child is considered stuck and
//     expires. Re-armed on every notifyActivity() call.
//
// When staleMs is not provided, the behavior collapses to the legacy single
// hard timeout — existing callers keep their exact semantics.
//
// Pure module — zero imports, fully unit-testable.
// ══════════════════════════════════════════════════════════════════════

export interface ActivityTimeoutOptions {
  /** Absolute wall-clock cap in ms. Never re-armed. */
  hardMs: number;
  /** When > 0, re-arms the expiry timer on every notifyActivity() call. */
  staleMs?: number;
}

export interface ActivityTimeout {
  /** Signal that the child produced output — re-arms the stale timer. */
  notifyActivity(): void;
  /** Disarm both timers (call on normal exit). */
  clear(): void;
}

export function createActivityTimeout(
  options: ActivityTimeoutOptions,
  onExpire: () => void,
): ActivityTimeout {
  let expired = false;
  let staleTimer: NodeJS.Timeout | null = null;

  const hardTimer = setTimeout(expire, options.hardMs);
  hardTimer.unref?.();

  function expire(): void {
    if (expired) return;
    expired = true;
    clear();
    onExpire();
  }

  function clear(): void {
    if (staleTimer) clearTimeout(staleTimer);
    clearTimeout(hardTimer);
  }

  function armStale(): void {
    if (expired) return;
    if (staleTimer) clearTimeout(staleTimer);
    if (options.staleMs && options.staleMs > 0) {
      staleTimer = setTimeout(expire, options.staleMs);
      staleTimer.unref?.();
    }
  }

  armStale();

  return { notifyActivity: armStale, clear };
}
