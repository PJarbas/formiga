// ══════════════════════════════════════════════════════════════════════
// local-store.ts — Filesystem-backed artifact store
// ══════════════════════════════════════════════════════════════════════

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ArtifactStore } from "./store.js";

const WORKSPACE_ROOT_DEFAULT = ".formiga/workspaces/ml";

export class LocalArtifactStore implements ArtifactStore {
  private root: string;

  constructor(root?: string) {
    this.root = root ?? path.resolve(process.cwd(), WORKSPACE_ROOT_DEFAULT);
  }

  resolveWorkspace(runId: string): string {
    return path.join(this.root, runId);
  }

  async ensureWorkspace(runId: string): Promise<void> {
    const ws = this.resolveWorkspace(runId);
    const dirs = [
      ws,
      path.join(ws, "data"),
      path.join(ws, "artifacts", "models"),
      path.join(ws, "artifacts", "encoders"),
      path.join(ws, "results"),
      path.join(ws, "reports", "figures"),
      path.join(ws, "holdout"),
    ];
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  async saveModel(runId: string, modelId: string, data: Buffer): Promise<string> {
    const dir = path.join(this.resolveWorkspace(runId), "artifacts", "models");
    await fs.mkdir(dir, { recursive: true });
    const filename = `${modelId}.pkl`;
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, data);
    return filepath;
  }

  async saveResult(runId: string, filename: string, data: Record<string, unknown>): Promise<string> {
    const dir = path.join(this.resolveWorkspace(runId), "results");
    await fs.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), "utf-8");
    return filepath;
  }

  async saveReport(runId: string, filename: string, content: string): Promise<string> {
    const dir = path.join(this.resolveWorkspace(runId), "reports");
    await fs.mkdir(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    await fs.writeFile(filepath, content, "utf-8");
    return filepath;
  }

  /** Compute SHA-256 checksum of a file. */
  async checksum(filepath: string): Promise<string> {
    const data = await fs.readFile(filepath);
    return createHash("sha256").update(data).digest("hex");
  }
}
