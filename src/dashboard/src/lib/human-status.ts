// ══════════════════════════════════════════════════════════════════════
// human-status.ts — Resolve composite pipeline state into human-readable status
// ══════════════════════════════════════════════════════════════════════
// Pure function — no React dependency. Rules evaluated in priority order.
// Used by useHumanStatus() hook and consumed by App header + Runs.
// ══════════════════════════════════════════════════════════════════════

import { getStatusConfig } from "./status-config.js";
import type { PipelinePhase } from "@shared/dashboard-types";

export type HumanStatusLabel =
  | "idle"
  | "initializing"
  | "waiting_for_input"
  | "action_required"
  | "running"
  | "completed"
  | "failed"
  | "paused";

export interface HumanStatus {
  label: HumanStatusLabel;
  description: string;
  emoji: string;
  colorVar: string;
  isUrgent: boolean;
  /** Phase currently visible to user — null when idle */
  activePhase: PipelinePhase | null;
}

export interface HumanStatusInput {
  status: "idle" | "running" | "paused" | "completed" | "failed";
  currentPhase: PipelinePhase;
  currentRound: number;
  maxRounds: number;
  pendingDecisions: number;
  /** Highest consecutive-heartbeat count across agents (0 = healthy). RF-7. */
  maxConsecutiveHeartbeats?: number;
}

// ── Rules evaluated in priority order — first match wins ───────────
const RULES: Array<{
  match: (i: HumanStatusInput) => boolean;
  resolve: (i: HumanStatusInput) => Omit<HumanStatus, "emoji" | "colorVar">;
}> = [
  {
    match: (i) => i.status === "idle",
    resolve: () => ({
      label: "idle",
      description: "Start a pipeline to begin",
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.currentPhase === "idle" && i.currentRound === 0,
    resolve: () => ({
      label: "initializing",
      description: "Pipeline is setting up",
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.currentPhase === "idle" && i.currentRound > 0,
    resolve: () => ({
      label: "waiting_for_input",
      description: "Pipeline paused — awaiting decision",
      isUrgent: true,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "running" && i.pendingDecisions > 0,
    resolve: (i) => ({
      label: "action_required",
      description: `${i.pendingDecisions} decision${i.pendingDecisions > 1 ? "s" : ""} pending`,
      isUrgent: true,
      activePhase: i.currentPhase,
    }),
  },
  {
    // RF-7: an agent is stuck in a heartbeat loop (alive but producing no
    // work). Surface this as urgent so the operator sees the stall instead
    // of a frozen "running" status (run 367d0f4e hid this for >1h40m).
    match: (i) => i.status === "running" && (i.maxConsecutiveHeartbeats ?? 0) >= 2,
    resolve: (i) => ({
      label: "running",
      description: `Stuck in heartbeat loop (${i.maxConsecutiveHeartbeats} rounds, no progress)`,
      isUrgent: true,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "running",
    resolve: (i) => ({
      label: "running",
      description: `Round ${i.currentRound}/${i.maxRounds}`,
      isUrgent: false,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "completed",
    resolve: (i) => ({
      label: "completed",
      description: `${i.currentRound} round${i.currentRound > 1 ? "s" : ""} finished`,
      isUrgent: false,
      activePhase: null,
    }),
  },
  {
    match: (i) => i.status === "failed",
    resolve: (i) => ({
      label: "failed",
      description: `Failed at ${i.currentPhase.replace(/_/g, " ")}, round ${i.currentRound}`,
      isUrgent: true,
      activePhase: i.currentPhase,
    }),
  },
  {
    match: (i) => i.status === "paused",
    resolve: (i) => ({
      label: "paused",
      description: `Pipeline paused at round ${i.currentRound}`,
      isUrgent: false,
      activePhase: i.currentPhase,
    }),
  },
];

/** Resolve composite pipeline state into a human-readable status.
 *  Pure function — no React, no side effects. */
export function getHumanStatus(input: HumanStatusInput): HumanStatus {
  const rule = RULES.find((r) => r.match(input));
  const resolved = rule
    ? rule.resolve(input)
    : {
        label: "idle" as HumanStatusLabel,
        description: "",
        isUrgent: false,
        activePhase: null as PipelinePhase | null,
      };

  // Derive emoji and color from the underlying status config
  let configKey: string;
  if (input.status === "running" && input.pendingDecisions > 0) {
    configKey = "pending";
  } else if (input.status === "running" && input.currentPhase === "idle") {
    configKey = "running";
  } else {
    configKey = input.status;
  }

  const config = getStatusConfig(configKey);

  return {
    ...resolved,
    emoji: config.emoji,
    colorVar: config.colorVar,
  };
}

/** Map a HumanStatusLabel to its corresponding UIStatus key for StatusBadge.
 *  This avoids ternary chains in consumers. */
export function humanLabelToUIStatus(label: HumanStatusLabel): string {
  const mapping: Record<HumanStatusLabel, string> = {
    idle: "idle",
    initializing: "running",
    waiting_for_input: "running",
    action_required: "pending",
    running: "running",
    completed: "completed",
    failed: "failed",
    paused: "running",
  };
  return mapping[label];
}