import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations.js";

// Module-scoped singleton with a short TTL. The TTL exists to recover from
// fork()/exec() scenarios where the parent connection becomes unsafe in a
// child process; removing it is scheduled for Branch 4 (perf hot paths).
let _db: DatabaseSync | null = null;
let _dbOpenedAt = 0;
let _dbPath: string | null = null;
const DB_MAX_AGE_MS = 5000;

function resolveDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  return path.join(os.homedir(), ".formiga", "formiga.db");
}

export function getDb(): DatabaseSync {
  const now = Date.now();
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath && (now - _dbOpenedAt) < DB_MAX_AGE_MS) return _db;
  // Only close if the ref is non-null (avoid double-close warnings)
  if (_db) {
    try {
      _db.close();
    } catch {
      // Don't throw on double-close — we just want a fresh connection
    }
    _db = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  _dbOpenedAt = now;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  migrate(_db);
  return _db;
}

export function getDbPath(): string {
  return resolveDbPath();
}
