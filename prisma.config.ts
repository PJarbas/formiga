import { defineConfig } from "prisma/config";
import path from "node:path";
import os from "node:os";

function resolveDbUrl(): string {
  const explicit = process.env.FORMIGA_DB_PATH?.trim();
  const dbPath = explicit
    ? path.resolve(explicit)
    : path.join(os.homedir(), ".formiga", "formiga.db");
  return `file:${dbPath}`;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolveDbUrl(),
  },
});
