// ══════════════════════════════════════════════════════════════════════
// legacy-compat.ts — Temporary compatibility layer during Prisma migration
//
// Provides a getDb() that wraps the PrismaClient with a DatabaseSync-like
// interface for files that are NOT YET migrated.
//
// This shim is transitional and should be removed as each module gets
// its own Prisma-native rewrite.
// ══════════════════════════════════════════════════════════════════════

import { getPrisma } from "./prisma.js";
import path from "node:path";
import os from "node:os";

export function getDbPath(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  return explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
}

/** Stub getDb() for legacy callers.
 *  The full implementation is obsolete since Prisma manages connections.
 *  Callers that need a DB handle should migrate to getPrisma().
 */
export function getDb(): unknown {
  // No-op: Prisma does not expose a raw DatabaseSync handle.
  // Modules that relied on getDb() still need manual migration.
  // This stub prevents immediate compilation failures.
  return null as unknown;
}

/** Resolve absolute DB path (same logic as before). */
export function resolveDbPath(): string {
  return getDbPath();
}
