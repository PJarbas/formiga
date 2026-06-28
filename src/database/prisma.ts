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
  // Dynamic import to avoid bundling issues in environments that don't need it.
  // Using require() for better-sqlite3 since it's a native C++ addon.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require("better-sqlite3");
  const database = new Database(dbPath);
  // Enable WAL mode and foreign keys for consistency with the legacy connection
  database.pragma("journal_mode=WAL");
  database.pragma("foreign_keys=ON");
  const adapter = new PrismaBetterSqlite3(database);
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });
}

// Module-scoped singleton
let _prisma: PrismaClient | null = null;

/**
 * Get the PrismaClient singleton.
 * Safe to call from any module; lazily-created on first use.
 *
 * NOTE: In test scenarios that swap the DB path via FORMIGA_DB_PATH,
 * call `resetPrisma()` *before* to force a re-bind to the new database.
 */
export function getPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = createPrismaClient();
  }
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
