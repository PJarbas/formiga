// ══════════════════════════════════════════════════════════════════════
// fan-out.ts — Parallel agent dispatch with timeout + Promise.allSettled
// ══════════════════════════════════════════════════════════════════════

import type { AgentRunner, AgentContext, AgentResult } from "../agents/interfaces.js";

/**
 * Executor injected by the caller — runs the agent through whatever harness
 * (pi, hermes, mock) and returns a structured AgentResult. fan-out itself
 * stays harness-agnostic: it only handles parallelism, batching, and timeout.
 *
 * The workflow YAML path (`workflows/ml-pipeline/workflow.yml`) does NOT use
 * fan-out — its scheduler invokes agents via `src/installer/scheduler/pi-runner.ts`
 * and parses output server-side. fan-out remains here as a programmatic
 * helper for callers that drive `FormigaEngine`/`RoundManager` directly.
 */
export type FanOutExecutor = (
  agent: AgentRunner,
  context: AgentContext,
) => Promise<AgentResult>;

export interface FanOutConfig {
  agents: AgentRunner[];
  context: AgentContext;
  timeoutMs: number;
  executor: FanOutExecutor;
  maxConcurrency?: number;
}

export interface FanOutResult {
  agentName: string;
  result: AgentResult | null;
  error: string | null;
  timedOut: boolean;
}

/** Dispatch multiple agents in parallel. Each gets its own timeout. */
export async function fanOut(config: FanOutConfig): Promise<FanOutResult[]> {
  const { agents, context, timeoutMs, executor, maxConcurrency } = config;

  // If maxConcurrency is set, run in batches
  if (maxConcurrency && maxConcurrency > 0 && agents.length > maxConcurrency) {
    const results: FanOutResult[] = [];
    for (let i = 0; i < agents.length; i += maxConcurrency) {
      const batch = agents.slice(i, i + maxConcurrency);
      const batchResults = await runBatch(batch, context, timeoutMs, executor);
      results.push(...batchResults);
    }
    return results;
  }

  return runBatch(agents, context, timeoutMs, executor);
}

async function runBatch(
  agents: AgentRunner[],
  context: AgentContext,
  timeoutMs: number,
  executor: FanOutExecutor,
): Promise<FanOutResult[]> {
  const promises = agents.map((agent) => runWithTimeout(agent, context, timeoutMs, executor));
  const settlements = await Promise.allSettled(promises);

  return settlements.map((s, i) => {
    if (s.status === "fulfilled") {
      return s.value;
    }
    return {
      agentName: agents[i].name,
      result: null,
      error: s.reason?.message ?? String(s.reason),
      timedOut: false,
    };
  });
}

async function runWithTimeout(
  agent: AgentRunner,
  context: AgentContext,
  timeoutMs: number,
  executor: FanOutExecutor,
): Promise<FanOutResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<FanOutResult>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        agentName: agent.name,
        result: null,
        error: `Timeout after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
  });

  const workPromise = (async (): Promise<FanOutResult> => {
    try {
      const result = await executor(agent, context);
      return { agentName: agent.name, result, error: null, timedOut: false };
    } catch (err) {
      return {
        agentName: agent.name,
        result: null,
        error: err instanceof Error ? err.message : String(err),
        timedOut: false,
      };
    }
  })();

  const result = await Promise.race([workPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
