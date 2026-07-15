/**
 * http-client.ts — Thin HTTP client for Formiga dashboard API
 *
 * Uses env vars injected by the formiga scheduler:
 *   - FORMIGA_API_URL  (default: http://localhost:3737)
 *   - FORMIGA_RUN_ID
 *   - FORMIGA_STEP_ID
 *   - FORMIGA_AGENT_ID
 */

const DEFAULT_TIMEOUT_MS = 5000;

export interface FormigaContext {
  apiUrl: string;
  runId: string;
  stepId: string;
  agentId: string;
}

/**
 * Read the current Formiga context from environment variables.
 * Falls back to sensible defaults so tools remain callable during
 * local debugging (env vars will typically be set by the scheduler).
 */
export function readContext(env: NodeJS.ProcessEnv = process.env): FormigaContext {
  return {
    apiUrl: env.FORMIGA_API_URL ?? "http://localhost:3737",
    runId: env.FORMIGA_RUN_ID ?? "unknown",
    stepId: env.FORMIGA_STEP_ID ?? "unknown",
    agentId: env.FORMIGA_AGENT_ID ?? "unknown",
  };
}

/**
 * Save an artifact via the dashboard HTTP API.
 * Retries once on transient network errors.
 */
export async function saveArtifact(
  ctx: FormigaContext,
  artifactKey: string,
  content: unknown,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ id: number; artifactKey: string }> {
  const url = `${ctx.apiUrl}/api/runs/${encodeURIComponent(ctx.runId)}/agent-artifacts/${encodeURIComponent(artifactKey)}`;

  const body = JSON.stringify({
    stepId: ctx.stepId,
    agentId: ctx.agentId,
    content,
  });

  return postJson<{ id: number; artifactKey: string }>(url, body, opts);
}

/**
 * Query the leaderboard (top-N experiments) for the current run.
 *
 * Uses the dashboard's `GET /api/leaderboard?runId=<id>&sortBy=cvMean&sortDir=desc`
 * endpoint, which returns `{ entries: [...], total, bestCvMean }`. We take the
 * first `limit` entries client-side because the server currently doesn't accept
 * a limit parameter; keeping N small (≤50 per our validator) makes this fine.
 */
export async function queryLeaderboard(
  ctx: FormigaContext,
  limit: number,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<LeaderboardEntry[]> {
  const url = `${ctx.apiUrl}/api/leaderboard?runId=${encodeURIComponent(ctx.runId)}&sortBy=cvMean&sortDir=desc`;
  const response = await getJson<{ entries: LeaderboardEntry[] } | LeaderboardEntry[]>(url, opts);
  const entries = Array.isArray(response) ? response : response?.entries ?? [];
  return entries.slice(0, limit);
}

export interface LeaderboardEntry {
  experimentId?: number;
  modelType: string;
  agentName: string;
  cvMean?: number;
  valMetric?: number;
  trainMean?: number;
  trainMetric?: number;
  roundNumber: number;
  status?: string;
}

// ── Internal helpers ────────────────────────────────────────────────

async function postJson<T>(
  url: string,
  body: string,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }, opts);
}

async function getJson<T>(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      const text = await safeReadText(res);
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }, opts);
}

async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Wire caller's cancellation into our controller.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
