import { getPrisma } from "../db.js";

export type LogsSelector =
  | { kind: "global-recent"; limit: number }
  | { kind: "global-limit"; limit: number }
  | { kind: "run-id"; runId: string }
  | { kind: "run-number"; runNumber: number; raw: string };

export function parseLogsSelector(arg?: string): LogsSelector {
  if (!arg) return { kind: "global-recent", limit: 50 };
  if (/^\d+$/.test(arg)) return { kind: "global-limit", limit: parseInt(arg, 10) || 50 };
  if (/^#\d+$/.test(arg)) return { kind: "run-number", runNumber: parseInt(arg.slice(1), 10), raw: arg };
  return { kind: "run-id", runId: arg };
}

export async function lookupRunIdByNumber(runNumber: number): Promise<string | undefined> {
  const prisma = getPrisma();
  const run = await prisma.run.findFirst({
    where: { run_number: runNumber },
    select: { id: true },
  });
  return run?.id;
}
