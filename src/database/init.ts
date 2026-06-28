// ══════════════════════════════════════════════════════════════════════
// init.ts — One-shot database bootstrap on server startup
// Replaces run-once DDL + PRAGMA setup from the raw sqlite era.
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "./prisma.js";

/** Run once before the dashboard or CLI main path starts.
 *  Ensures WAL mode, foreign keys, and the singleton stats row exist.
 *  Prisma migrations already created the schema, but SQLite PRAGMAs
 *  and seed rows (formiga_stats) need a raw-query pass.
 */
export async function initDatabase(): Promise<void> {
  const prisma = getPrisma();

  // SQLite-specific pragmas (not available via Prisma DSL for SQLite)
  await prisma.$executeRawUnsafe(`PRAGMA journal_mode=WAL;`);
  await prisma.$executeRawUnsafe(`PRAGMA foreign_keys=ON;`);

  // Ensure the singleton stats row exists
  await prisma.formigaStat.upsert({
    where: { id: 1 },
    create: { id: 1, system_tokens_spent: 0 },
    update: {},
  });
}
