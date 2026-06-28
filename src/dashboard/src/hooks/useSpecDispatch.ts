// ══════════════════════════════════════════════════════════════════════
// useSpecDispatch.ts — Shared approve/reject dispatch logic
// ══════════════════════════════════════════════════════════════════════
// Eliminates duplicated 20-line approve/reject + toast blocks
// from CommandCenter and ExperimentBoard.
// ══════════════════════════════════════════════════════════════════════

import { useSpecActions } from "../api/api.js";
import { addToast } from "../components/Toast.js";

export function useSpecDispatch() {
  const { approve: approveSpec, reject: rejectSpec } = useSpecActions();

  function approve(specId: string) {
    approveSpec.mutate(
      { specId },
      {
        onSuccess: () => addToast("success", `Approved ${specId}`),
        onError: (e) => addToast("error", `Approve failed: ${(e as Error).message}`),
      },
    );
  }

  function reject(specId: string) {
    const reason = window.prompt("Reject reason (optional):") ?? undefined;
    rejectSpec.mutate(
      { specId, reason },
      {
        onSuccess: () => addToast("success", `Rejected ${specId}`),
        onError: (e) => addToast("error", `Reject failed: ${(e as Error).message}`),
      },
    );
  }

  return { approve, reject };
}