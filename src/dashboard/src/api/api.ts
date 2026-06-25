// ══════════════════════════════════════════════════════════════════════
// api.ts — TanStack Query hooks for ML dashboard API
// ══════════════════════════════════════════════════════════════════════

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PipelineStatus,
  AgentDetail,
  AgentLogsResponse,
  MLKanbanSnapshot,
  LeaderboardResponse,
  LeaderboardEntry,
  RoundSummary,
  CrossFinding,
  AgentInfo,
} from "@shared/dashboard-types";

const BASE = "/api";

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Pipeline status ─────────────────────────────────────────────────

export function usePipelineStatus() {
  return useQuery({
    queryKey: ["pipeline", "status"],
    queryFn: () => fetchJSON<PipelineStatus>(`${BASE}/pipeline/status`),
  });
}

// ── Agents ──────────────────────────────────────────────────────────

export function useAgents() {
  return useQuery({
    queryKey: ["agents"],
    queryFn: () => fetchJSON<AgentInfo[]>(`${BASE}/agents`),
  });
}

export function useAgentDetail(agentName: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentName],
    queryFn: () => fetchJSON<AgentDetail>(`${BASE}/agents/${encodeURIComponent(agentName ?? "")}`),
    enabled: !!agentName,
  });
}

export function useAgentLogs(agentName: string | undefined, offset = 0, limit = 50) {
  return useQuery({
    queryKey: ["agents", agentName, "logs", offset, limit],
    queryFn: () =>
      fetchJSON<AgentLogsResponse>(
        `${BASE}/agents/${encodeURIComponent(agentName ?? "")}/logs?offset=${offset}&limit=${limit}`,
      ),
    enabled: !!agentName,
  });
}

// ── Kanban ──────────────────────────────────────────────────────────

export function useKanbanSnapshot(runId: string | undefined) {
  return useQuery({
    queryKey: ["kanban", runId],
    queryFn: () => fetchJSON<MLKanbanSnapshot>(`${BASE}/pipeline/kanban?runId=${encodeURIComponent(runId ?? "")}`),
    enabled: !!runId,
  });
}

// ── Leaderboard ─────────────────────────────────────────────────────

export function useLeaderboard(params?: {
  agentName?: string;
  roundNumber?: number;
  status?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}) {
  const search = new URLSearchParams();
  if (params?.agentName) search.set("agentName", params.agentName);
  if (params?.roundNumber !== undefined) search.set("roundNumber", String(params.roundNumber));
  if (params?.status) search.set("status", params.status);
  if (params?.sortBy) search.set("sortBy", params.sortBy);
  if (params?.sortDir) search.set("sortDir", params.sortDir);
  const qs = search.toString();
  return useQuery({
    queryKey: ["leaderboard", qs],
    queryFn: () => fetchJSON<LeaderboardResponse>(`${BASE}/leaderboard${qs ? `?${qs}` : ""}`),
  });
}

export function useLeaderboardEntry(id: string | undefined) {
  return useQuery({
    queryKey: ["leaderboard", id],
    queryFn: () => fetchJSON<LeaderboardEntry>(`${BASE}/leaderboard/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
  });
}

// ── Rounds ──────────────────────────────────────────────────────────

export function useRounds(runId: string | undefined) {
  return useQuery({
    queryKey: ["rounds", runId],
    queryFn: () => fetchJSON<RoundSummary[]>(`${BASE}/rounds?runId=${encodeURIComponent(runId ?? "")}`),
    enabled: !!runId,
  });
}

// ── Cross-findings ──────────────────────────────────────────────────

export function useCrossFindings(runId: string | undefined) {
  return useQuery({
    queryKey: ["cross-findings", runId],
    queryFn: () => fetchJSON<CrossFinding[]>(`${BASE}/cross-findings?runId=${encodeURIComponent(runId ?? "")}`),
    enabled: !!runId,
  });
}

// ── Pipeline control mutations ──────────────────────────────────────

export function usePipelineControl() {
  const qc = useQueryClient();

  const pause = useMutation({
    mutationFn: (runId: string) => fetchJSON(`${BASE}/pipeline/pause`, { method: "POST", body: JSON.stringify({ runId }), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  });

  const resume = useMutation({
    mutationFn: (runId: string) => fetchJSON(`${BASE}/pipeline/resume`, { method: "POST", body: JSON.stringify({ runId }), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => fetchJSON(`${BASE}/pipeline/cancel`, { method: "POST", body: JSON.stringify({ runId }), headers: { "Content-Type": "application/json" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline"] }),
  });

  return { pause, resume, cancel };
}
