// ══════════════════════════════════════════════════════════════════════
// api.ts — TanStack Query hooks for ML dashboard API
// ══════════════════════════════════════════════════════════════════════

import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import type {
  PipelineStatus,
  AgentDetail,
  AgentLogsResponse,
  AgentReasoningResponse,
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
  ModelReportResponse,
  ReproductionScriptResponse,
  ArenaSessionResponse,
  ArenaRoundResponse,
  ArenaConvergenceResponse,
  ArenaConfidenceResponse,
  ArenaAgentHistoryResponse,
  ArenaRoundExperiment,
  ConvergencePoint,
  ArenaDashboardStatus,
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
  opts?: { refetchInterval?: number | false; runId?: string },
) {
  const runId = opts?.runId;
  return useQuery({
    queryKey: ["agents", agentName, "logs", offset, limit, runId],
    queryFn: () => {
      const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
      if (runId) params.set("runId", runId);
      return fetchJSON<AgentLogsResponse>(
        `${BASE}/agents/${encodeURIComponent(agentName ?? "")}/logs?${params}`,
      );
    },
    enabled: !!agentName,
    refetchInterval: opts?.refetchInterval,
  });
}

// ── Agent Reasoning ────────────────────────────────────────────────

export function useAgentReasoning(agentName: string | undefined, runId: string | undefined) {
  return useQuery({
    queryKey: ["agents", agentName, "reasoning", runId],
    queryFn: () => {
      const params = runId ? `?runId=${encodeURIComponent(runId)}` : "";
      return fetchJSON<AgentReasoningResponse>(
        `${BASE}/agents/${encodeURIComponent(agentName ?? "")}/reasoning${params}`,
      );
    },
    enabled: !!agentName,
    refetchInterval: false,
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
  runId?: string;
  agentName?: string;
  roundNumber?: number;
  status?: string;
  sortBy?: string;
  sortDir?: "asc" | "desc";
}) {
  const search = new URLSearchParams();
  if (params?.runId) search.set("runId", params.runId);
  if (params?.agentName) search.set("agentName", params.agentName);
  if (params?.roundNumber !== undefined) search.set("roundNumber", String(params.roundNumber));
  if (params?.status) search.set("status", params.status);
  if (params?.sortBy) search.set("sortBy", params.sortBy);
  if (params?.sortDir) search.set("sortDir", params.sortDir);
  const qs = search.toString();
  return useQuery({
    queryKey: ["leaderboard", qs],
    queryFn: () => fetchJSON<LeaderboardResponse>(`${BASE}/leaderboard${qs ? `?${qs}` : ""}`),
    placeholderData: keepPreviousData,
  });
}

export function useLeaderboardEntry(id: string | undefined) {
  return useQuery({
    queryKey: ["leaderboard", id],
    queryFn: () => fetchJSON<LeaderboardEntry>(`${BASE}/leaderboard/${encodeURIComponent(id ?? "")}`),
    enabled: !!id,
  });
}

export function useModelReport(entryId: string | undefined) {
  return useQuery({
    queryKey: ["leaderboard", entryId, "report"],
    queryFn: () =>
      fetchJSON<ModelReportResponse>(`${BASE}/leaderboard/${encodeURIComponent(entryId ?? "")}/report`),
    enabled: !!entryId,
  });
}

export function useReproductionScript(entryId: string | undefined) {
  return useQuery({
    queryKey: ["leaderboard", entryId, "script"],
    queryFn: () =>
      fetchJSON<ReproductionScriptResponse>(`${BASE}/leaderboard/${encodeURIComponent(entryId ?? "")}/script`),
    enabled: !!entryId,
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

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => fetchJSON(`${BASE}/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["command-center"] });
      qc.invalidateQueries({ queryKey: ["pipeline"] });
    },
  });
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

export function useArenaSession(runId: string | undefined) {
  return useQuery({
    queryKey: ["arena", "session", runId],
    queryFn: () => fetchJSON<ArenaSessionResponse>(`${BASE}/arena/${encodeURIComponent(runId ?? "")}/session`),
    enabled: !!runId,
    refetchInterval: 5000,
  });
}

export function useArenaRounds(runId: string | undefined) {
  return useQuery({
    queryKey: ["arena", "rounds", runId],
    queryFn: () => fetchJSON<ArenaRoundResponse[]>(`${BASE}/arena/${encodeURIComponent(runId ?? "")}/rounds`),
    enabled: !!runId,
  });
}

export function useArenaConvergence(runId: string | undefined) {
  return useQuery({
    queryKey: ["arena", "convergence", runId],
    queryFn: () => fetchJSON<ArenaConvergenceResponse>(`${BASE}/arena/${encodeURIComponent(runId ?? "")}/convergence`),
    enabled: !!runId,
  });
}

export function useArenaConfidence(runId: string | undefined) {
  return useQuery({
    queryKey: ["arena", "confidence", runId],
    queryFn: () => fetchJSON<ArenaConfidenceResponse>(`${BASE}/arena/${encodeURIComponent(runId ?? "")}/confidence`),
    enabled: !!runId,
  });
}

export function useArenaAgentHistory(runId: string | undefined, agentName: string | undefined) {
  return useQuery({
    queryKey: ["arena", "agent-history", runId, agentName],
    queryFn: () =>
      fetchJSON<ArenaAgentHistoryResponse>(
        `${BASE}/arena/${encodeURIComponent(runId ?? "")}/agent-history/${encodeURIComponent(agentName ?? "")}`,
      ),
    enabled: !!runId && !!agentName,
  });
}

export function useArenaControls(runId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ action }: { action: "pause" | "resume" | "skip" | "stop" }) =>
      fetchJSON<{ status: string }>(`${BASE}/arena/${encodeURIComponent(runId ?? "")}/${action}`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["arena", "session", runId] });
      qc.invalidateQueries({ queryKey: ["arena", "rounds", runId] });
      qc.invalidateQueries({ queryKey: ["arena", "convergence", runId] });
      qc.invalidateQueries({ queryKey: ["arena", "confidence", runId] });
    },
  });
}

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

// ── Agent Activity Stream ───────────────────────────────────────────

import type { AgentEventsResponse, AgentArtifactsResponse } from "@shared/dashboard-types";

export function useAgentEvents(
  runId: string | undefined,
  options?: { stepId?: string; since?: string; limit?: number; refetchInterval?: number | false },
) {
  const params = new URLSearchParams();
  if (options?.stepId) params.set("stepId", options.stepId);
  if (options?.since) params.set("since", options.since);
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : "";

  return useQuery({
    queryKey: ["agent-events", runId, options?.stepId, options?.since, options?.limit],
    queryFn: () => fetchJSON<AgentEventsResponse>(`${BASE}/runs/${encodeURIComponent(runId ?? "")}/agent-events${qs}`),
    enabled: !!runId,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useAgentArtifacts(runId: string | undefined) {
  return useQuery({
    queryKey: ["agent-artifacts", runId],
    queryFn: () => fetchJSON<AgentArtifactsResponse>(`${BASE}/runs/${encodeURIComponent(runId ?? "")}/agent-artifacts`),
    enabled: !!runId,
  });
}
