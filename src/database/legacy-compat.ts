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
import fs from "node:fs";

import { migrate } from "./migrations.js";

function resolveDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
}

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

/** Return a raw DatabaseSync handle on the same file Prisma uses.
 *  This is a transitional shim for modules that have not been migrated yet.
 *  Consumers should migrate to getPrisma() and stop calling this.
 */
export function getDb(): DatabaseSync {
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;

  // Path changed (e.g. tests swapping FORMIGA_DB_PATH) — reopen like connection.ts.
  if (_db) {
    try {
      _db.close();
    } catch {
      // Ignore double-close errors.
    }
    _db = null;
  }

  // Mirror connection.ts: create the parent dir so a bare new HOME (or a
  // custom FORMIGA_DB_PATH) doesn't fail with "unable to open database file",
  // and ensure the schema exists before any raw-SQL caller seeds data.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

export function getDbPath(): string {
  return resolveDbPath();
}
