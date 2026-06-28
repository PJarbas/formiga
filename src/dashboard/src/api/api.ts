// ══════════════════════════════════════════════════════════════════════
// api.ts — TanStack Query hooks for ML dashboard API
// ══════════════════════════════════════════════════════════════════════

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PipelineStatus,
  AgentDetail,
  AgentLogsResponse,
  MLKanbanSnapshot,
  KanbanCardDetail,
  LeaderboardResponse,
  LeaderboardEntry,
  RoundSummary,
  CrossFinding,
  AgentInfo,
  CompareResponse,
  SpecApproval,
  ChecklistState,
  ChecklistItem,
  TraceEntry,
  CommandCenterSnapshot,
  PendingDecision,
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

export function useAgentLogs(
  agentName: string | undefined,
  offset = 0,
  limit = 50,
  opts?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ["agents", agentName, "logs", offset, limit],
    queryFn: () =>
      fetchJSON<AgentLogsResponse>(
        `${BASE}/agents/${encodeURIComponent(agentName ?? "")}/logs?offset=${offset}&limit=${limit}`,
      ),
    enabled: !!agentName,
    refetchInterval: opts?.refetchInterval,
  });
}

// ── Kanban ──────────────────────────────────────────────────────────

export function useKanbanSnapshot(runId: string | undefined) {
  return useQuery({
    queryKey: ["kanban", runId],
    queryFn: () => fetchJSON<MLKanbanSnapshot>(`${BASE}/runs/${encodeURIComponent(runId ?? "")}/kanban`),
    enabled: !!runId,
  });
}

export function useKanbanCardDetail(runId: string | undefined, cardId: string | undefined) {
  return useQuery({
    queryKey: ["kanban", "card-detail", runId, cardId],
    queryFn: () =>
      fetchJSON<KanbanCardDetail>(
        `${BASE}/runs/${encodeURIComponent(runId ?? "")}/kanban/card-detail?cardId=${encodeURIComponent(cardId ?? "")}`,
      ),
    enabled: !!runId && !!cardId,
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

// ── Compare experiments (front-specs §5.1) ──────────────────────────

export function useCompareExperiments(ids: string[]) {
  const qs = ids.map((id) => `id=${encodeURIComponent(id)}`).join("&");
  return useQuery({
    queryKey: ["leaderboard", "compare", ids.slice().sort().join(",")],
    queryFn: () => fetchJSON<CompareResponse>(`${BASE}/leaderboard/compare?${qs}`),
    enabled: ids.length >= 2,
  });
}

// ── Experiment actions (now automated by leaderboard & critic) ────────
// Note: manual promote/reject removed; best models are determined
// automatically by CV mean on the leaderboard after audit.

// ── Spec approval ───────────────────────────────────────────────────

export function useSpecActions() {
  const qc = useQueryClient();

  const approve = useMutation({
    mutationFn: ({ specId, approvedBy }: { specId: string; approvedBy?: string }) =>
      fetchJSON<SpecApproval>(`${BASE}/specs/${encodeURIComponent(specId)}/approve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvedBy: approvedBy ?? null }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["specs", vars.specId] });
      qc.invalidateQueries({ queryKey: ["command-center"] });
      qc.invalidateQueries({ queryKey: ["decisions", "pending"] });
    },
  });

  const reject = useMutation({
    mutationFn: ({
      specId,
      reason,
      rejectedBy,
    }: {
      specId: string;
      reason?: string;
      rejectedBy?: string;
    }) =>
      fetchJSON<SpecApproval>(`${BASE}/specs/${encodeURIComponent(specId)}/reject`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason ?? null, rejectedBy: rejectedBy ?? null }),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["specs", vars.specId] });
      qc.invalidateQueries({ queryKey: ["command-center"] });
      qc.invalidateQueries({ queryKey: ["decisions", "pending"] });
    },
  });

  return { approve, reject };
}

// ── Checklist ───────────────────────────────────────────────────────

export function useChecklist(runId: string | undefined, phase: string | undefined) {
  return useQuery({
    queryKey: ["checklist", runId, phase],
    queryFn: () =>
      fetchJSON<ChecklistState>(
        `${BASE}/checklist/${encodeURIComponent(runId ?? "")}/${encodeURIComponent(phase ?? "")}`,
      ),
    enabled: !!runId && !!phase,
  });
}

export function useChecklistMutation(runId: string, phase: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: ChecklistItem[]) =>
      fetchJSON<ChecklistState>(
        `${BASE}/checklist/${encodeURIComponent(runId)}/${encodeURIComponent(phase)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        },
      ),
    onSuccess: (data) => {
      qc.setQueryData(["checklist", runId, phase], data);
    },
  });
}

// ── Trace ───────────────────────────────────────────────────────────

export function useTrace(
  agentName: string | undefined,
  roundNumber: number | undefined,
  opts?: { refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: ["trace", agentName, roundNumber],
    queryFn: () =>
      fetchJSON<TraceEntry[]>(
        `${BASE}/trace/${encodeURIComponent(agentName ?? "")}/${roundNumber ?? 0}`,
      ),
    enabled: !!agentName && roundNumber !== undefined,
    refetchInterval: opts?.refetchInterval,
  });
}

// ── Command Center aggregate ────────────────────────────────────────

export function useCommandCenter() {
  return useQuery({
    queryKey: ["command-center"],
    queryFn: () => fetchJSON<CommandCenterSnapshot>(`${BASE}/command-center`),
    refetchInterval: 3000,
  });
}

export function usePendingDecisions(runId?: string) {
  const qs = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  return useQuery({
    queryKey: ["decisions", "pending", runId ?? null],
    queryFn: () => fetchJSON<PendingDecision[]>(`${BASE}/decisions/pending${qs}`),
  });
}
