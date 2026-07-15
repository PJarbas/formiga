import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled workflows ship with formiga (in the repo's workflows/ directory)
export function resolveBundledWorkflowsDir(): string {
  // From dist/installer/paths.js -> ../../workflows
  return path.resolve(__dirname, "..", "..", "workflows");
}

export function resolveSourcePath(): string {
  // From dist/installer/paths.js -> ../.. (the checkout/package root)
  const sourcePath = path.resolve(__dirname, "..", "..");
  try {
    return fs.realpathSync(sourcePath);
  } catch {
    return sourcePath;
  }
}

export function resolveSkillPath(): string {
  // From dist/installer/paths.js -> ../../skills/formiga-agents/SKILL.md
  const skillPath = path.resolve(__dirname, "..", "..", "skills", "formiga-agents", "SKILL.md");
  try {
    return fs.realpathSync(skillPath);
  } catch {
    return skillPath;
  }
}

/**
 * Path to the bundled `formiga-agent-tools` pi extension directory.
 *
 * Returns the path to the extension package (the parent of `extensions/`),
 * which is what `pi --extension <path>` expects.
 * Returns `null` when the extension is missing (e.g. running from a partial
 * checkout) — callers must treat this as best-effort.
 */
export function resolveFormigaAgentToolsExtension(): string | null {
  const override = process.env.FORMIGA_AGENT_TOOLS_EXTENSION?.trim();
  if (override) {
    return fs.existsSync(override) ? override : null;
  }
  // From dist/installer/paths.js -> ../../extensions/formiga-agent-tools
  const extPath = path.resolve(
    __dirname,
    "..",
    "..",
    "extensions",
    "formiga-agent-tools",
  );
  if (!fs.existsSync(extPath)) return null;
  try {
    return fs.realpathSync(extPath);
  } catch {
    return extPath;
  }
}

export function resolveBundledWorkflowDir(workflowId: string): string {
  return path.join(resolveBundledWorkflowsDir(), workflowId);
}

export function resolvePiStateDir(): string {
  const env = process.env.FORMIGA_STATE_DIR?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".formiga");
}

export function resolvePiConfigPath(): string {
  const env = process.env.PI_SETTINGS_PATH?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function resolvePiAuthPath(): string {
  const env = process.env.PI_AUTH_PATH?.trim();
  if (env) return env;
  return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

export function resolveFormigaRoot(): string {
  return resolvePiStateDir();
}

export function resolveWorkflowRoot(): string {
  return path.join(resolveFormigaRoot(), "workflows");
}

export function resolveWorkflowDir(workflowId: string): string {
  return path.join(resolveWorkflowRoot(), workflowId);
}

export function resolveWorkflowWorkspaceRoot(): string {
  return path.join(resolveFormigaRoot(), "workspaces", "workflows");
}

export function resolveWorkflowWorkspaceDir(workflowId: string): string {
  return path.join(resolveWorkflowWorkspaceRoot(), workflowId);
}

export function resolveRunRoot(): string {
  return path.join(resolveFormigaRoot(), "runs");
}

export function resolveFormigaCli(): string {
  // From dist/installer/paths.js -> ../../bin/formiga. Use the shell
  // launcher rather than dist/cli/cli.js so Node runtime flags stay centralized.
  return path.resolve(__dirname, "..", "..", "bin", "formiga");
}

export function resolvePiOutputDir(): string {
  const env = process.env.FORMIGA_PI_OUTPUT_DIR?.trim();
  if (env) return env;
  return path.join(resolvePiStateDir(), "tmp", "pi-output");
}
