// ══════════════════════════════════════════════════════════════════════
// Prisma Client singleton
// Replaces the raw DatabaseSync singleton from connection.ts
// ══════════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

function resolveDbUrl(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  const dbPath = explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return `file:${dbPath}`;
}

function ensureEnvDbUrl(): void {
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = resolveDbUrl();
  }
}

function createPrismaClient(): PrismaClient {
  ensureEnvDbUrl();
  return new PrismaClient({
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
