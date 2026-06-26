import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initDashboardStoreSchema } from "./schema.js";

describe("dashboard-store schema", () => {
  it("creates spec_approvals and checklist_state tables", () => {
    const db = new DatabaseSync(":memory:");
    initDashboardStoreSchema(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("spec_approvals");
    expect(names).toContain("checklist_state");
  });

  it("is idempotent — running twice does not throw", () => {
    const db = new DatabaseSync(":memory:");
    initDashboardStoreSchema(db);
    expect(() => initDashboardStoreSchema(db)).not.toThrow();
  });

  it("spec_approvals enforces status CHECK constraint", () => {
    const db = new DatabaseSync(":memory:");
    initDashboardStoreSchema(db);

    expect(() =>
      db
        .prepare(
          "INSERT INTO spec_approvals (spec_id, run_id, phase, status, updated_at) VALUES (?,?,?,?,datetime('now'))",
        )
        .run("a:b", "a", "b", "bogus-status"),
    ).toThrow();
  });

  it("checklist_state PK is (run_id, phase)", () => {
    const db = new DatabaseSync(":memory:");
    initDashboardStoreSchema(db);

    db.prepare(
      "INSERT INTO checklist_state (run_id, phase, items_json, updated_at) VALUES (?,?,?,datetime('now'))",
    ).run("run-1", "feat-eng", "[]");

    expect(() =>
      db
        .prepare(
          "INSERT INTO checklist_state (run_id, phase, items_json, updated_at) VALUES (?,?,?,datetime('now'))",
        )
        .run("run-1", "feat-eng", "[]"),
    ).toThrow();
  });
});
