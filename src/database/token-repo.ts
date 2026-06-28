// ══════════════════════════════════════════════════════════════════════
// token-repo.ts — Global accounting helpers
// MIGRATED TO PRISMA — no raw SQL
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "./prisma.js";

export async function nextRunNumber(): Promise<number> {
  const prisma = getPrisma();
  const agg = await prisma.run.aggregate({
    _max: { run_number: true },
  });
  return (agg._max.run_number ?? 0) + 1;
}

export async function getSystemTokenSpend(): Promise<number> {
  const prisma = getPrisma();
  const stat = await prisma.formigaStat.findUnique({
    where: { id: 1 },
    select: { system_tokens_spent: true },
  });
  return stat?.system_tokens_spent ?? 0;
}

export async function incrementSystemTokenSpend(amount: number): Promise<number> {
  const prisma = getPrisma();
  const updated = await prisma.formigaStat.update({
    where: { id: 1 },
    data: { system_tokens_spent: { increment: amount } },
    select: { system_tokens_spent: true },
  });
  return updated.system_tokens_spent;
}
