import { useCommandCenter, usePipelineControl, useDeleteRun } from "../api/api";
import { PipelineTable } from "../components/PipelineTable";
import type { RunActionId } from "../components/PipelineTable";
import { EmptyState } from "../components/EmptyState";
import { addToast } from "../components/Toast";

export default function CommandCenter() {
  const { data, isLoading, error } = useCommandCenter();
  const { pause, resume, cancel } = usePipelineControl();
  const deleteRun = useDeleteRun();

  function handleRunAction(runId: string, action: RunActionId) {
    switch (action) {
      case "pause":
        pause.mutate(runId, { onError: (e) => addToast("error", `Pause failed: ${(e as Error).message}`) });
        break;
      case "resume":
        resume.mutate(runId, { onError: (e) => addToast("error", `Resume failed: ${(e as Error).message}`) });
        break;
      case "cancel":
        cancel.mutate(runId, { onError: (e) => addToast("error", `Cancel failed: ${(e as Error).message}`) });
        break;
      case "delete":
        if (!window.confirm("Delete this run and all its data? This cannot be undone.")) return;
        deleteRun.mutate(runId, { onError: (e) => addToast("error", `Delete failed: ${(e as Error).message}`) });
        break;
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading command center...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--accent-red)] bg-[var(--bg-secondary)] p-6 text-center">
        <p className="text-[var(--accent-red)] font-medium">Failed to load command center</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (!data || data.runs.length === 0) {
    return (
      <div
        data-testid="cc-idle"
        className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center"
      >
        <EmptyState
          icon="⚙️"
          message="No active pipeline"
          detail="Start a pipeline from the CLI to see runs here."
        />
        <code className="inline-block text-xs font-mono text-[var(--accent-blue)] bg-[var(--bg-tertiary)] px-3 py-1.5 rounded mt-3">
          formiga run --task &quot;predict churn&quot; --rounds 5
        </code>
      </div>
    );
  }

  return (
    <div data-testid="command-center">
      <PipelineTable runs={data.runs} onRunAction={handleRunAction} />
    </div>
  );
}
