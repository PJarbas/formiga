import http from "node:http";
import path from "node:path";

const BASE_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CI",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
];

export function cleanChildEnv(
  overrides: Record<string, string | undefined> = {},
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of BASE_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const homeDir = env.HOME?.trim();
  const configuredStateDir = env.TAMANDUA_STATE_DIR?.trim();
  const stateDir = configuredStateDir || (homeDir ? path.join(homeDir, ".tamandua") : undefined);
  if (stateDir) {
    env.TAMANDUA_STATE_DIR = stateDir;
    env.TAMANDUA_DB_PATH = env.TAMANDUA_DB_PATH?.trim() || path.join(stateDir, "tamandua.db");
    env.TAMANDUA_WORKTREE_ROOT =
      env.TAMANDUA_WORKTREE_ROOT?.trim() || path.join(stateDir, "worktrees");
  }

  return env;
}

export async function reserveRandomPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to reserve a random TCP port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export async function reserveDistinctRandomPorts(count: number): Promise<number[]> {
  const ports = new Set<number>();
  while (ports.size < count) {
    ports.add(await reserveRandomPort());
  }
  return [...ports];
}
