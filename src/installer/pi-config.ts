import fs from "node:fs/promises";
import { resolvePiConfigPath, resolvePiAuthPath } from "./paths.js";

export type PiConfig = {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  lastChangelogVersion?: string;
};

export type PiAuthEntry = {
  type: "api_key" | "oauth";
  key?: string;
};

export type PiAuth = Record<string, PiAuthEntry>;

export async function readPiConfig(): Promise<{ path: string; config: PiConfig }> {
  const configPath = resolvePiConfigPath();
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as PiConfig;
    return { path: configPath, config };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read pi config at ${configPath}: ${message}`);
  }
}

export async function writePiConfig(path: string, config: PiConfig): Promise<void> {
  const content = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(path, content, "utf-8");
}

export async function readPiAuth(): Promise<{ path: string; auth: PiAuth }> {
  const authPath = resolvePiAuthPath();
  try {
    const raw = await fs.readFile(authPath, "utf-8");
    const auth = JSON.parse(raw) as PiAuth;
    return { path: authPath, auth };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read pi auth at ${authPath}: ${message}`);
  }
}
