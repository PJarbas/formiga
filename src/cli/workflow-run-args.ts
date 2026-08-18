export interface WorkflowRunArgs {
  taskTitle: string;
  workingDirectoryForHarness?: string;
  worktreeOriginRepository?: string;
  worktreeOriginRef?: string;
  noHurrySaveTokensMode?: boolean;
  noRelaunchUponRugpull?: boolean;
  harnessAs?: "pi" | "hermes" | "opencode";
}

/**
 * Map a `--*-as-harness` flag onto its harness type, enforcing mutual
 * exclusion. Returns the harness type when `token` is a harness flag,
 * undefined otherwise. Throws when a second harness flag is seen.
 */
function parseHarnessFlag(
  token: string,
  current: "pi" | "hermes" | "opencode" | undefined,
): "pi" | "hermes" | "opencode" | undefined {
  const flagMap: Record<string, "pi" | "hermes" | "opencode"> = {
    "--pi-as-harness": "pi",
    "--hermes-as-harness": "hermes",
    "--opencode-as-harness": "opencode",
  };
  const harness = flagMap[token];
  if (!harness) return undefined;
  if (current !== undefined) {
    throw new Error(
      "Cannot specify more than one of --pi-as-harness, --hermes-as-harness, --opencode-as-harness. Choose one harness.",
    );
  }
  return harness;
}

export function parseWorkflowRunArgs(args: string[]): WorkflowRunArgs {
  const taskParts: string[] = [];
  let workingDirectoryForHarness: string | undefined;
  let worktreeOriginRepository: string | undefined;
  let worktreeOriginRef: string | undefined;
  let noHurrySaveTokensMode: boolean | undefined;
  let noRelaunchUponRugpull: boolean | undefined;
  let harnessAs: "pi" | "hermes" | "opencode" | undefined;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];

    if (token === "--no-hurry-please-save-tokens-mode") {
      noHurrySaveTokensMode = true;
      continue;
    }

    if (token === "--no-relaunch-upon-rugpull") {
      noRelaunchUponRugpull = true;
      continue;
    }

    const harnessFlag = parseHarnessFlag(token, harnessAs);
    if (harnessFlag) {
      harnessAs = harnessFlag;
      continue;
    }

    if (token === "--working-directory-for-harness") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      i++;
      continue;
    }

    const inlinePrefix = "--working-directory-for-harness=";
    if (token.startsWith(inlinePrefix)) {
      const value = token.slice(inlinePrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --working-directory-for-harness.");
      }
      workingDirectoryForHarness = value;
      continue;
    }

    if (token === "--worktree-origin-repository") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      i++;
      continue;
    }

    const wtRepoPrefix = "--worktree-origin-repository=";
    if (token.startsWith(wtRepoPrefix)) {
      const value = token.slice(wtRepoPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-repository.");
      }
      worktreeOriginRepository = value;
      continue;
    }

    if (token === "--worktree-origin-ref") {
      const value = args[i + 1]?.trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      i++;
      continue;
    }

    const wtRefPrefix = "--worktree-origin-ref=";
    if (token.startsWith(wtRefPrefix)) {
      const value = token.slice(wtRefPrefix.length).trim();
      if (!value) {
        throw new Error("Missing value for --worktree-origin-ref.");
      }
      worktreeOriginRef = value;
      continue;
    }

    taskParts.push(token);
  }

  return {
    taskTitle: taskParts.join(" ").trim(),
    workingDirectoryForHarness,
    worktreeOriginRepository,
    worktreeOriginRef,
    noHurrySaveTokensMode,
    noRelaunchUponRugpull,
    harnessAs,
  };
}
