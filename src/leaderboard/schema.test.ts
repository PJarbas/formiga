import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initLeaderboardSchema } from "./schema.js";

describe("leaderboard schema", () => {
  it("creates experiments table with promote/reject columns", () => {
    const db = new DatabaseSync(":memory:");
    initLeaderboardSchema(db);

    const cols = db.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);

    expect(names).toContain("promoted_at");
    expect(names).toContain("rejected_at");
    expect(names).toContain("reject_reason");
  });

  it("is idempotent — running twice does not throw or duplicate columns", () => {
    const db = new DatabaseSync(":memory:");
    initLeaderboardSchema(db);
    expect(() => initLeaderboardSchema(db)).not.toThrow();

    const cols = db.prepare("PRAGMA table_info(experiments)").all() as Array<{ name: string }>;
    const promotedCount = cols.filter((c) => c.name === "promoted_at").length;
    expect(promotedCount).toBe(1);
  });

  it("creates idx_experiments_promoted partial index", () => {
    const db = new DatabaseSync(":memory:");
    initLeaderboardSchema(db);

    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_experiments_promoted") as { name: string } | undefined;

    expect(idx?.name).toBe("idx_experiments_promoted");
  });
});
