// ══════════════════════════════════════════════════════════════════════
// Prisma Client singleton
// Replaces the raw DatabaseSync singleton from connection.ts
// ══════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function resolveDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  const dbPath = explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return dbPath;
}

function createPrismaClient(): PrismaClient {
  const dbPath = resolveDbPath();
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

// Module-scoped singleton
let _prisma: PrismaClient | null = null;
let _prismaPath: string | null = null;

/**
 * Get the PrismaClient singleton.
 * Safe to call from any module; lazily-created on first use.
 *
 * Re-binds automatically when the resolved DB path changes (e.g. tests
 * swapping FORMIGA_DB_PATH per test, or a long-lived process pointing at
 * a new database) — same path-aware behavior as connection.ts getDb().
 */
export function getPrisma(): PrismaClient {
  const dbPath = resolveDbPath();
  if (_prisma && _prismaPath === dbPath) return _prisma;

  if (_prisma) {
    // Sync getter can't await — fire-and-forget the old pool teardown;
    // the new client opens immediately on the current path.
    void _prisma.$disconnect().catch(() => {});
    _prisma = null;
  }

  _prisma = createPrismaClient();
  _prismaPath = dbPath;
  return _prisma;
}

/**
 * Resets the singleton. Useful in tests that change FORMIGA_DB_PATH
 * or need a fresh connection.
 */
export async function resetPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

/**
 * Gracefully disconnect. Call during process shutdown.
 */
export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
  }
}
