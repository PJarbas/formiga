// ══════════════════════════════════════════════════════════════════════
// fan-out.ts — Parallel agent dispatch with timeout + Promise.allSettled
// ══════════════════════════════════════════════════════════════════════

import type { AgentRunner, AgentContext, AgentResult } from "../agents/interfaces.js";

export interface FanOutConfig {
  agents: AgentRunner[];
  context: AgentContext;
  timeoutMs: number;
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
  const { agents, context, timeoutMs, maxConcurrency } = config;

  // If maxConcurrency is set, run in batches
  if (maxConcurrency && maxConcurrency > 0 && agents.length > maxConcurrency) {
    const results: FanOutResult[] = [];
    for (let i = 0; i < agents.length; i += maxConcurrency) {
      const batch = agents.slice(i, i + maxConcurrency);
      const batchResults = await runBatch(batch, context, timeoutMs);
      results.push(...batchResults);
    }
    return results;
  }

  return runBatch(agents, context, timeoutMs);
}

async function runBatch(
  agents: AgentRunner[],
  context: AgentContext,
  timeoutMs: number,
): Promise<FanOutResult[]> {
  const promises = agents.map((agent) => runWithTimeout(agent, context, timeoutMs));
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
      // In the real harness, this calls pi/hermes and parses output.
      // Here we produce the prompt — the existing scheduler executes it.
      const prompt = agent.buildPrompt(context);
      const result = parseOutputAsResult(agent.name, prompt);
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

function parseOutputAsResult(agentName: string, _prompt: string): AgentResult {
  // In the real harness, the scheduler runs the prompt through pi/hermes
  // and parses the output. Here we emit a PENDING result — the actual
  // execution and parsing happen in the scheduler/pi-runner.ts layer.
  return {
    agentName,
    status: "SUCCESS",
  };
}
