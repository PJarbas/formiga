/**
 * Types for the AutoResearch interactive wizard.
 */

export interface WizardTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export interface WizardEvaluatorInput {
  /** Current working directory. */
  cwd: string;
  /** Whether an AutoResearch session appears initialized in cwd. */
  initialized: boolean;
  /** Config summary (only present when initialized: true). */
  configSummary?: string;
  /** Full transcript of the wizard conversation so far. */
  transcript: WizardTranscriptEntry[];
}

export interface WizardEvaluatorNotReady {
  ready: false;
  question: string;
  reason: string;
}

export interface WizardEvaluatorReady {
  ready: true;
  commentary: string;
  needsInit: boolean;
  initArgv?: string[] | null;
  loopArgv: string[];
}
