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
import { fanOut, type FanOutResult, type FanOutExecutor } from "./fan-out.js";
import { collectAndRegister } from "./fan-in.js";
import { piFanOutExecutor } from "./pi-executor.js";
import { getFailedConfigsForAgent, getSucceededConfigsForAgent } from "../leaderboard/queries.js";

export interface RoundConfig {
  runId: string;
  roundNumber: number;
  workspacePath: string;
  timeoutMs: number;
  maxConcurrency?: number;
  /**
   * Executor that actually runs an agent (e.g. via pi/hermes harness) and
   * returns a structured AgentResult.
   *
   * If omitted, defaults to `piFanOutExecutor` which spawns the pi binary
   * (`pi --print`) with disk streaming to prevent OOM on large outputs.
   */
  executor?: FanOutExecutor;
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
    const executor = config.executor ?? piFanOutExecutor;
    const phaseResults: PhaseResult[] = [];

    // Register all agents with the messenger so broadcast reaches them
    const agents: AgentRunner[] = [dataAnalyst, featureEngineer, modelerClassic, modelerAdvanced, mlCritic];
    for (const a of agents) this.messenger.register(a.name);

    const context = this.buildContext(config);

    // Phase 1: Data Analyst (sequential — no dependencies)
    const analystCtx = this.snapshotMessages(dataAnalyst.name, context);
    const analystResult = await this.runSingle(dataAnalyst, analystCtx, config.timeoutMs, executor);
    phaseResults.push(analystResult);
    this.messenger.broadcast(dataAnalyst.name, `Data Analyst completed — status: ${analystResult.status}`);

    if (analystResult.status !== "completed") {
      return this.buildResult(config, phaseResults, 0, 1);
    }

    // Phase 2: Feature Engineer (depends on analyst's report)
    const engineerCtx = this.snapshotMessages(featureEngineer.name, context);
    const engineerResult = await this.runSingle(featureEngineer, engineerCtx, config.timeoutMs, executor);
    phaseResults.push(engineerResult);
    this.messenger.broadcast(featureEngineer.name, `Feature Engineer completed — status: ${engineerResult.status}`);

    if (engineerResult.status !== "completed") {
      return this.buildResult(config, phaseResults, 0, 1);
    }

    // Phase 3: Modelers in parallel (classic ∥ advanced)
    const modelerCtx = this.snapshotMessages(modelerClassic.name, context);
    const advancedCtx = this.snapshotMessages(modelerAdvanced.name, context);

    // Inject cross-run history for modelers
    const classicCtx = await this.enrichWithHistory(modelerClassic.name, modelerCtx);
    const enrichedAdvancedCtx = await this.enrichWithHistory(modelerAdvanced.name, advancedCtx);

    const modelerResults = await fanOut({
      agents: [modelerClassic, modelerAdvanced],
      context: classicCtx,
      timeoutMs: config.timeoutMs,
      maxConcurrency: config.maxConcurrency,
      executor,
    });

    for (const mr of modelerResults) {
      phaseResults.push({
        agentName: mr.agentName,
        status: mr.error ? "failed" : mr.timedOut ? "timed_out" : "completed",
        error: mr.error ?? undefined,
      });
      this.messenger.broadcast(mr.agentName, `Modeler ${mr.agentName} completed — status: ${mr.error ? "failed" : "completed"}`);
    }

    // Phase 4: ML Critic (reviews all modelers)
    const criticCtx = this.snapshotMessages(mlCritic.name, context);
    const criticResult = await this.runSingle(mlCritic, criticCtx, config.timeoutMs, executor);
    phaseResults.push(criticResult);

    // Collect and register all valid results in leaderboard
    const allFanOut: FanOutResult[] = modelerResults.map((mr) => ({
      agentName: mr.agentName,
      result: mr.result,
      error: mr.error,
      timedOut: mr.timedOut,
    }));

    const fanIn = await collectAndRegister(allFanOut, this.repository, config.runId, config.roundNumber, config.workspacePath);

    return this.buildResult(config, phaseResults, fanIn.registered, fanIn.failed);
  }

  getMessenger(): AgentMessengerImpl {
    return this.messenger;
  }

  private async runSingle(
    agent: AgentRunner,
    context: AgentContext,
    timeoutMs: number,
    executor: FanOutExecutor,
  ): Promise<PhaseResult> {
    const results = await fanOut({ agents: [agent], context, timeoutMs, executor });
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
      messenger: this.messenger,
    };
  }

  /** Snapshot current mailbox for an agent into context.messages. */
  private snapshotMessages(agentName: string, base: AgentContext): AgentContext {
    return { ...base, messages: this.messenger.peek(agentName) };
  }

  /** Inject cross-run history (failures + successes) into context. */
  private async enrichWithHistory(agentName: string, base: AgentContext): Promise<AgentContext> {
    const [previousFailures, previousSuccesses] = await Promise.all([
      getFailedConfigsForAgent(agentName, 5).catch(() => []),
      getSucceededConfigsForAgent(agentName, 3).catch(() => []),
    ]);
    return { ...base, previousFailures, previousSuccesses };
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
