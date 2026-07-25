// ══════════════════════════════════════════════════════════════════════
// repository-immutable.test.ts — Verdict immutability (ISSUE-06).
//
// The arena auditor commits a verdict pre-write; `registerArena` locks it.
// Subsequent verdict mutations (reject/autoAudit/updateTestMetric) must throw.
// Uses a lightweight Prisma stub — we test the lock contract, not the DB.
// ══════════════════════════════════════════════════════════════════════

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LeaderboardRepositoryImpl } from "./repository.js";

// Minimal stub matching the subset of PrismaClient.experiment used by the
// lock logic. Each test configures the return values it needs.
interface ExperimentStub {
  experiment_id: number;
  verdict_locked_at: Date | null;
}

function makeRepo(rows: Map<number, ExperimentStub>): LeaderboardRepositoryImpl {
  const experiment = {
    create: mock.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const id = rows.size + 1;
      rows.set(id, {
        experiment_id: id,
        verdict_locked_at: (data.verdict_locked_at as Date) ?? null,
      });
      return { experiment_id: id };
    }),
    findUnique: mock.fn(async ({ where, select }: { where: { experiment_id: number }; select?: Record<string, boolean> }) => {
      void select; // not asserted here
      return rows.get(where.experiment_id) ?? null;
    }),
    update: mock.fn(async () => ({})),
    updateMany: mock.fn(async () => ({ count: 0 })),
  };
  // Monkey-patch the private getter by injecting a fake prisma onto the
  // instance. The getter returns getPrisma(); we override the prototype.
  const repo = new LeaderboardRepositoryImpl();
  Object.defineProperty(repo, "prisma", { get: () => ({ experiment }) });
  return repo;
}

const sampleArenaEntry = {
  run_id: "run-1",
  round_number: 1,
  agent_name: "modeler-classic",
  model_type: "lightgbm",
  measured_metric: 0.82,
  metric_name: "auc",
  artifact_path: "artifacts/x.pkl",
  decision: "keep" as const,
  status: "AUDITED",
};

describe("LeaderboardRepositoryImpl — verdict immutability (ISSUE-06)", () => {
  let rows: Map<number, ExperimentStub>;

  beforeEach(() => {
    rows = new Map();
  });

  it("registerArena locks the verdict on insert", async () => {
    const repo = makeRepo(rows);
    const id = await repo.registerArena(sampleArenaEntry);
    const row = rows.get(id);
    assert.ok(row, "experiment should be inserted");
    assert.ok(row!.verdict_locked_at instanceof Date, "verdict_locked_at must be set on registerArena");
  });

  it("reject() throws when the verdict is locked", async () => {
    const repo = makeRepo(rows);
    const id = await repo.registerArena(sampleArenaEntry);
    await assert.rejects(
      () => repo.reject(id, "late rejection"),
      /Ledger immutability violation/,
    );
  });

  it("autoAudit() throws when the verdict is locked", async () => {
    const repo = makeRepo(rows);
    const id = await repo.registerArena(sampleArenaEntry);
    await assert.rejects(
      () => repo.autoAudit(id),
      /Ledger immutability violation/,
    );
  });

  it("updateTestMetric() throws when the verdict is locked", async () => {
    const repo = makeRepo(rows);
    const id = await repo.registerArena(sampleArenaEntry);
    await assert.rejects(
      () => repo.updateTestMetric(id, 0.9, "AUDITED"),
      /Ledger immutability violation/,
    );
  });

  it("setDatasetSignature() is allowed even after lock (pre-verdict metadata)", async () => {
    const repo = makeRepo(rows);
    const id = await repo.registerArena(sampleArenaEntry);
    // Must not throw — dataset_signature is warm-start metadata, not a verdict.
    await repo.setDatasetSignature(id, "sig-abc");
  });

  it("reject() works when the verdict is NOT locked (legacy step path)", async () => {
    // A row inserted without verdict_locked_at (e.g., via the legacy `register`
    // path) remains mutable — the lock is opt-in via registerArena.
    rows.set(1, { experiment_id: 1, verdict_locked_at: null });
    const repo = makeRepo(rows);
    await repo.reject(1, "normal rejection"); // must not throw
  });
});
