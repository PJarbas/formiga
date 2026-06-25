// ══════════════════════════════════════════════════════════════════════
// store.ts — Artifact store interface
// ══════════════════════════════════════════════════════════════════════

export interface ArtifactStore {
  /** Store model artifact and return its path. */
  saveModel(runId: string, modelId: string, data: Buffer): Promise<string>;

  /** Store a result JSON file. */
  saveResult(runId: string, filename: string, data: Record<string, unknown>): Promise<string>;

  /** Store a report (markdown). */
  saveReport(runId: string, filename: string, content: string): Promise<string>;

  /** Resolve the workspace path for a run. */
  resolveWorkspace(runId: string): string;

  /** Ensure workspace directory structure exists. */
  ensureWorkspace(runId: string): Promise<void>;
}
