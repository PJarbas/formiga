import { getDb } from "./connection.js";

export function nextRunNumber(): number {
  const db = getDb();
  const row = db.prepare("SELECT COALESCE(MAX(run_number), 0) + 1 AS next FROM runs").get() as { next: number };
  return row.next;
}

export function getSystemTokenSpend(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT system_tokens_spent FROM formiga_stats WHERE id = 1",
  ).get() as { system_tokens_spent: number } | undefined;
  return row?.system_tokens_spent ?? 0;
}

export function incrementSystemTokenSpend(amount: number): number {
  const db = getDb();
  const row = db.prepare(`
    UPDATE formiga_stats
    SET system_tokens_spent = system_tokens_spent + ?
    WHERE id = 1
    RETURNING system_tokens_spent
  `).get(amount) as { system_tokens_spent: number } | undefined;
  return row?.system_tokens_spent ?? 0;
}
