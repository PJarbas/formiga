// Thin re-export shim. The implementation lives in ./database/.
// Existing callers can keep `import ... from "./db.js"` without churn.
export {
  getPrisma,
  resetPrisma,
  disconnectPrisma,
  initDatabase,
  getDb,
  getDbPath,
  nextRunNumber,
  getSystemTokenSpend,
  incrementSystemTokenSpend,
  upsertAutoresearchSession,
  getAutoresearchSessions,
  getAutoresearchSessionById,
  deleteAutoresearchSession,
  type AutoresearchSessionRow,
} from "./database/index.js";
