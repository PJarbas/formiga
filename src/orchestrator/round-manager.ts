// ══════════════════════════════════════════════════════════════════════
// round-manager.ts — Sequential phase orchestration for ML pipeline
// ══════════════════════════════════════════════════════════════════════

import type { AgentRunner, AgentContext, AgentResult } from "../agents/interfaces.js";
import { dataAnalyst } from "../agents/data-analyst.js";
import { featureEngineer } from "../agents/feature-engineer.js";
import { modelerClassic } from "../agents/modeler-classic.js";
import { modelerAdvanced } from "../agents/modeler-advanced.js";
import { mlCritic } from "../agents/ml-critic.js";
import type { LeaderboardRepository } from "../leaderboard/repository.js";
import { AgentMessengerImpl } from "./communication.js";
import { fanOut, type FanOutResult } from "./fan-out.js";
import { collectAndRegister } from "./fan-in.js";

export interface RoundConfig {
  runId: string;
  roundNumber: number;
  workspacePath: string;
  timeoutMs: number;
  maxConcurrency?: number;
}

export interface RoundResult {
  runId: string;
  roundNumber: number;
  phaseResults: PhaseResult[];
  leaderboardRegistered: number;
  leaderboardRejected: number;
}

export interface PhaseResult {
  agentName: string;
  status: "completed" | "failed" | "timed_out";
  error?: string;
}

export class RoundManager {
  private messenger = new AgentMessengerImpl();

  constructor(private repository: LeaderboardRepository) {}

  /** Execute one full round of the ML pipeline. */
  async executeRound(config: RoundConfig): Promise<RoundResult> {
    const phaseResults: PhaseResult[] = [];
    const context = this.buildContext(config);

    // Phase 1: Data Analyst (sequential — no dependencies)
    const analystResult = await this.runSingle(dataAnalyst, context, config.timeoutMs);
    phaseResults.push(analystResult);

    if (analystResult.status !== "completed") {
      return this.buildResult(config, phaseResults, 0, 1);
    }

    // Phase 2: Feature Engineer (depends on analyst's report)
    const engineerResult = await this.runSingle(featureEngineer, context, config.timeoutMs);
    phaseResults.push(engineerResult);

    if (engineerResult.status !== "completed") {
      return this.buildResult(config, phaseResults, 0, 1);
    }

    // Phase 3: Modelers in parallel (classic ∥ advanced)
    const modelerResults = await fanOut({
      agents: [modelerClassic, modelerAdvanced],
      context,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
    });

    for (const mr of modelerResults) {
      phaseResults.push({
        agentName: mr.agentName,
        status: mr.error ? "failed" : mr.timedOut ? "timed_out" : "completed",
        error: mr.error ?? undefined,
      });
    }

    // Phase 4: ML Critic (reviews all modelers)
    const criticResult = await this.runSingle(mlCritic, context, config.timeoutMs);
    phaseResults.push(criticResult);

    // Collect and register all valid results in leaderboard
    const allFanOut: FanOutResult[] = modelerResults.map((mr) => ({
      agentName: mr.agentName,
      result: mr.result,
      error: mr.error,
      timedOut: mr.timedOut,
    }));

    const fanIn = collectAndRegister(allFanOut, this.repository, config.runId, config.roundNumber);

    return this.buildResult(config, phaseResults, fanIn.registered, fanIn.failed);
  }

  getMessenger(): AgentMessengerImpl {
    return this.messenger;
  }

  private async runSingle(
    agent: AgentRunner,
    context: AgentContext,
    timeoutMs: number,
  ): Promise<PhaseResult> {
    const results = await fanOut({ agents: [agent], context, timeoutMs });
    const r = results[0];
    return {
      agentName: agent.name,
      status: r.error ? "failed" : r.timedOut ? "timed_out" : "completed",
      error: r.error ?? undefined,
    };
  }

  private buildContext(config: RoundConfig): AgentContext {
    return {
      runId: config.runId,
      roundNumber: config.roundNumber,
      workspacePath: config.workspacePath,
    };
  }

  private buildResult(
    config: RoundConfig,
    phaseResults: PhaseResult[],
    registered: number,
    rejected: number,
  ): RoundResult {
    return {
      runId: config.runId,
      roundNumber: config.roundNumber,
      phaseResults,
      leaderboardRegistered: registered,
      leaderboardRejected: rejected,
    };
  }
}
