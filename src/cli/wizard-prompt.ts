/**
 * Pure function that builds the evaluator prompt sent to pi.
 *
 * No I/O — pure string construction. Testable with simple assertions.
 */

import type { WizardEvaluatorInput } from "./wizard-types.js";

const ALLOWED_INIT_FLAGS = [
  "--goal",
  "--metric",
  "--unit",
  "--direction",
  "--command",
  "--metric-regex",
  "--checks-command",
  "--cwd",
  "--overwrite",
];

const ALLOWED_LOOP_FLAGS = [
  "--target-metric",
  "--max-iterations",
  "--max-consecutive-failures",
  "--timeout",
  "--cwd",
];

function buildTranscriptText(transcript: WizardEvaluatorInput["transcript"]): string {
  if (transcript.length === 0) {
    return "(transcript is empty — this is the first question)";
  }
  return transcript
    .map((entry) => {
      const label = entry.role === "user" ? "USER" : "WIZARD";
      return `${label}: ${entry.text}`;
    })
    .join("\n\n");
}

function buildInitStatusSection(input: WizardEvaluatorInput): string {
  if (input.initialized) {
    const summary = input.configSummary ?? "(config summary not available)";
    return `AutoResearch IS initialized in ${input.cwd}.\nCurrent config: ${summary}`;
  }
  return `AutoResearch is NOT initialized in ${input.cwd}. An init step will be needed.`;
}

/**
 * Build the full evaluator prompt for the pi subprocess.
 */
export function buildEvaluatorPrompt(input: WizardEvaluatorInput): string {
  const transcriptText = buildTranscriptText(input.transcript);
  const initStatus = buildInitStatusSection(input);

  return `You are an AutoResearch wizard evaluator. Your job is to decide whether you have enough information to generate AutoResearch commands.

Current working directory: ${input.cwd}
${initStatus}

WIZARD TRANSCRIPT:
${transcriptText}

Based on the transcript above, decide if you have gathered enough information to configure an AutoResearch session.

If more information IS needed, return ONLY a JSON object:

{
  "ready": false,
  "question": "one next question to ask",
  "reason": "short reason why this question is needed"
}

If enough information IS gathered, return ONLY a JSON object:

{
  "ready": true,
  "commentary": "user-facing explanation of how and why the command sequence was composed from the user's responses",
  "needsInit": true,
  "initArgv": ["autoresearch", "init", "..."],
  "loopArgv": ["autoresearch", "loop", "--prompt", "..."]
}

When ready: true:
- The "commentary" field is REQUIRED — explain how you composed these commands.
- If the session is already initialized, set "needsInit": false and "initArgv": null.
- If the session needs initialization, set "needsInit": true and provide initArgv.

ALLOWED INIT ARGV FLAGS (initArgv must start with ["autoresearch", "init"]):
${ALLOWED_INIT_FLAGS.map((f) => `  ${f}`).join("\n")}

ALLOWED LOOP ARGV FLAGS (loopArgv must start with ["autoresearch", "loop", "--prompt"]):
  --target-metric <number>          OPTIONAL. A numeric target value to stop at (e.g. 100). Only
                                    include if the user explicitly mentions a numeric target.
                                    NEVER pass the metric name here — the metric name goes in
                                    initArgv --metric, NOT in loopArgv --target-metric. If the
                                    user says "optimize features" with no numeric target, OMIT
                                    --target-metric entirely.
  --max-iterations <number>         OPTIONAL. Maximum number of iterations to run.
  --max-consecutive-failures <number> OPTIONAL. Stop after N consecutive failures.
  --timeout <seconds>               OPTIONAL. Maximum runtime in seconds.
  --cwd <path>                      REQUIRED. Working directory.

IMPORTANT: --prompt is a flag (takes NO value). Do NOT follow --prompt with a value.

Do NOT invent flags that are not in the allowed lists above.

CRITICAL: --target-metric takes a number, never a name. The metric name (e.g. "features")
is configured in initArgv --metric. loopArgv --target-metric is for the numeric target
value (e.g. 100 to stop when the metric reaches 100). Only include --target-metric if the
user explicitly says they want to stop at a specific numeric value.

Return ONLY the JSON object. Prefer raw JSON. If you must wrap it, use at most ONE \`\`\`json fenced block. Do not include any other text.`;
}
