// ══════════════════════════════════════════════════════════════════════
// database/index.ts — Main database entrypoint
// Exports Prisma-based helpers (migrated from raw SQLite)
// ══════════════════════════════════════════════════════════════════════

export { getPrisma, resetPrisma, disconnectPrisma } from "./prisma.js";
export { initDatabase } from "./init.js";
export { getDb, getDbPath } from "./legacy-compat.js";

// Legacy compat exports — now return Promises (callers must await)
export { nextRunNumber, getSystemTokenSpend, incrementSystemTokenSpend } from "./token-repo.js";
export {
  upsertAutoresearchSession,
  getAutoresearchSessions,
  getAutoresearchSessionById,
  deleteAutoresearchSession,
  type AutoresearchSessionRow,
} from "./session-repo.js";
