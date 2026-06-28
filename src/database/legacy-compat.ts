// ══════════════════════════════════════════════════════════════════════
// legacy-compat.ts — Temporary compatibility shim for raw SQLite callers
//
// Unmigrated modules still import { getDb } from "./db.js".  This shim
// returns a real DatabaseSync pointing at the same SQLite file that
// Prisma uses.  Both connections share the underlying database (WAL mode
// ensures safe concurrent access) so existing raw-SQL code keeps working
// while Prisma-migrated modules use the PrismaClient.
//
// Remove this file once every consumer is fully Prisma-native.
// ══════════════════════════════════════════════════════════════════════

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

function resolveDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
}

let _db: DatabaseSync | null = null;

/** Return a raw DatabaseSync handle on the same file Prisma uses.
 *  This is a transitional shim for modules that have not been migrated yet.
 *  Consumers should migrate to getPrisma() and stop calling this.
 */
export function getDb(): DatabaseSync {
  if (!_db) {
    const dbPath = resolveDbPath();
    _db = new DatabaseSync(dbPath);
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA foreign_keys=ON");
  }
  return _db;
}

export function getDbPath(): string {
  return resolveDbPath();
}
