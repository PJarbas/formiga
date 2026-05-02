const DEFAULT_MAX_ARG_PREVIEW_LENGTH = 120;
const DEFAULT_MAX_COMMAND_PREVIEW_LENGTH = 500;
const DEFAULT_PROMPT_MARKER = "<prompt elided>";
const ELLIPSIS = "…";

const FLAGS_WITH_VALUE = new Set([
  "-m",
  "-p",
  "--model",
  "--work-model",
  "--session",
  "--profile",
  "--cwd",
  "--output",
  "--temperature",
  "--max-tokens",
  "--provider",
  "--api-key",
  "--config",
  "--role",
  "--timeout",
  "--state-dir",
]);

export interface PiCommandPreview {
  argvPreview: string[];
  commandPreview: string;
  redactedIndices: number[];
  truncatedIndices: number[];
  argCount: number;
  promptElided: boolean;
  commandTruncated: boolean;
}

export interface PiCommandPreviewOptions {
  promptMarker?: string;
  maxArgPreviewLength?: number;
  maxCommandPreviewLength?: number;
}

function quoteForPreview(arg: string): string {
  if (arg.length === 0) return '""';
  if (/^[a-zA-Z0-9_/:=.,@%+\-]+$/.test(arg)) return arg;
  return JSON.stringify(arg);
}

function truncate(value: string, maxLength: number): { value: string; truncated: boolean } {
  if (value.length <= maxLength) return { value, truncated: false };
  const safeLength = Math.max(1, maxLength - ELLIPSIS.length);
  return { value: `${value.slice(0, safeLength)}${ELLIPSIS}`, truncated: true };
}

function collectOptionValueIndices(args: string[]): Set<number> {
  const indices = new Set<number>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg.startsWith("--") && arg.includes("=")) continue;

    if (FLAGS_WITH_VALUE.has(arg) && i + 1 < args.length) {
      indices.add(i + 1);
      i += 1;
    }
  }

  return indices;
}

function collectPromptIndices(args: string[]): number[] {
  const indices = new Set<number>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-p" || arg === "--prompt") && i + 1 < args.length) {
      indices.add(i + 1);
      i += 1;
      continue;
    }

    if (arg.startsWith("--prompt=")) {
      indices.add(i);
    }
  }

  const hasPrintFlag = args.includes("--print");
  if (!hasPrintFlag) {
    return [...indices].sort((a, b) => a - b);
  }

  const optionValueIndices = collectOptionValueIndices(args);
  const positionalIndices: number[] = [];
  let forcePositional = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (optionValueIndices.has(i)) continue;

    if (arg === "--") {
      forcePositional = true;
      continue;
    }

    if (forcePositional || !arg.startsWith("-")) {
      positionalIndices.push(i);
    }
  }

  if (positionalIndices.length > 0) {
    indices.add(positionalIndices[positionalIndices.length - 1]);
  }

  return [...indices].sort((a, b) => a - b);
}

export function formatPiCommandPreview(
  piPath: string,
  args: string[],
  options: PiCommandPreviewOptions = {},
): PiCommandPreview {
  const promptMarker = options.promptMarker ?? DEFAULT_PROMPT_MARKER;
  const maxArgPreviewLength = options.maxArgPreviewLength ?? DEFAULT_MAX_ARG_PREVIEW_LENGTH;
  const maxCommandPreviewLength = options.maxCommandPreviewLength ?? DEFAULT_MAX_COMMAND_PREVIEW_LENGTH;

  const redactedSet = new Set<number>(collectPromptIndices(args));
  const truncatedIndices: number[] = [];

  const argvPreview = args.map((arg, index) => {
    if (redactedSet.has(index)) {
      if (arg.startsWith("--prompt=")) {
        return `--prompt=${promptMarker}`;
      }
      return promptMarker;
    }

    const shortened = truncate(arg, maxArgPreviewLength);
    if (shortened.truncated) {
      truncatedIndices.push(index);
    }
    return shortened.value;
  });

  const commandParts = [piPath, ...argvPreview].map(quoteForPreview);
  const joinedCommand = commandParts.join(" ");
  const commandPreviewResult = truncate(joinedCommand, maxCommandPreviewLength);

  return {
    argvPreview,
    commandPreview: commandPreviewResult.value,
    redactedIndices: [...redactedSet].sort((a, b) => a - b),
    truncatedIndices,
    argCount: args.length,
    promptElided: redactedSet.size > 0,
    commandTruncated: commandPreviewResult.truncated,
  };
}
