import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations.js";

// Module-scoped singleton. The 5-second TTL was removed in Branch 4
// (fix-perf-hot-paths) because the fork()/exec() scenarios that
// required connection recycling were eliminated in Branch 1
// (remove-orphan-code). A true singleton avoids re-running PRAGMAs
// and migrations on every getDb() call — the previous TTL path was
// wasting CPU on re-connection + re-migration cycles.
let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;
let _migrated = false;

function resolveDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  if (explicit) return path.resolve(explicit);

  return path.join(os.homedir(), ".formiga", "formiga.db");
}

export function getDb(): DatabaseSync {
  const dbPath = resolveDbPath();
  if (_db && _dbPath === dbPath) return _db;

  // Different path requested — close old connection
  if (_db) {
    try {
      _db.close();
    } catch {
      // Don't throw on double-close
    }
    _db = null;
    _migrated = false;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new DatabaseSync(dbPath);
  _dbPath = dbPath;
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");

  // Lazy migration: only run once per connection
  if (!_migrated) {
    migrate(_db);
    _migrated = true;
  }

  return _db;
}

export function getDbPath(): string {
  return resolveDbPath();
}
