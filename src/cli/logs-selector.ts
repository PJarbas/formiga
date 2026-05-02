import { getDb } from "../db.js";

export type LogsSelector =
  | { kind: "global-recent"; limit: number }
  | { kind: "global-limit"; limit: number }
  | { kind: "run-id"; runId: string }
  | { kind: "run-number"; runNumber: number; raw: string };

export interface RunNumberLookupDb {
  prepare(sql: string): {
    get(runNumber: number): unknown;
  };
}

export function parseLogsSelector(arg?: string): LogsSelector {
  if (!arg) return { kind: "global-recent", limit: 50 };
  if (/^\d+$/.test(arg)) return { kind: "global-limit", limit: parseInt(arg, 10) || 50 };
  if (/^#\d+$/.test(arg)) return { kind: "run-number", runNumber: parseInt(arg.slice(1), 10), raw: arg };
  return { kind: "run-id", runId: arg };
}

export function lookupRunIdByNumber(runNumber: number, db: RunNumberLookupDb = getDb()): string | undefined {
  const row = db.prepare("SELECT id FROM runs WHERE run_number = ?").get(runNumber) as { id?: string } | undefined;
  return row?.id;
}
