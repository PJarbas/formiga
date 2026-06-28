// ══════════════════════════════════════════════════════════════════════
// CommandCenter.tsx — Tela 1 / front-specs §3
// Aggregated header + PipelineStepper + Pending Decisions + Quick Stats
// + Best Model card (with sparkline) + Agent Strip.
// Powered by GET /api/command-center (3s poll inside useCommandCenter).
// ══════════════════════════════════════════════════════════════════════

import { useState } from "react";
import {
  useCommandCenter,
  useSpecActions,
} from "../api/api";
import { PipelineStepper } from "../components/PipelineStepper";
import { StatusCard } from "../components/StatusCard";
import { ActionBar } from "../components/ActionBar";
import { Sparkline } from "../components/Sparkline";
import { useHumanStatus } from "../hooks/useHumanStatus";
import { getStatusConfig } from "../lib/status-config";
import type { Action, PendingDecision } from "@shared/dashboard-types";

function decisionToActions(d: PendingDecision): Action[] {
  return d.actions.map((a) => ({
    id: a.id,
    label: a.label,
    primary: a.primary,
    variant:
      a.id.startsWith("reject") || a.id === "discard"
        ? ("destructive" as const)
        : a.id.startsWith("approve") || a.id === "promote"
          ? ("success" as const)
          : ("default" as const),
  }));
}

export default function CommandCenter() {
  const { data, isLoading, error } = useCommandCenter();
  const { approve: approveSpec, reject: rejectSpec } = useSpecActions();
  const humanStatus = useHumanStatus();
  const [toast, setToast] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--text-muted)]">
        Loading command center...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--accent-red)] bg-[var(--bg-secondary)] p-6 text-center">
        <p className="text-[var(--accent-red)] font-medium">Failed to load command center</p>
        <p className="text-[var(--text-muted)] text-sm mt-1">{(error as Error).message}</p>
      </div>
    );
  }

  if (!data || data.run.status === "idle") {
    return (
      <div
        data-testid="cc-idle"
        className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8 text-center"
      >
        <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">No Active Pipeline</h2>
        <p className="text-[var(--text-secondary)] max-w-md mx-auto">
          No ML pipeline is currently running. Start one to see decisions, best models, and
          agent activity here.
        </p>
      </div>
    );
  }

  function dispatchDecision(d: PendingDecision, actionId: string) {
    setToast(null);
    if (d.type === "spec_approval") {
      const specId = d.id.startsWith("spec:") ? d.id.slice(5) : d.id;
      if (actionId.startsWith("approve")) {
        approveSpec.mutate(
          { specId },
          {
            onSuccess: () => setToast(`Approved ${specId}`),
            onError: (e) => setToast(`Approve failed: ${(e as Error).message}`),
          },
        );
      } else if (actionId.startsWith("reject")) {
        const reason = window.prompt("Reject reason (optional):") ?? undefined;
        rejectSpec.mutate(
          { specId, reason },
          {
            onSuccess: () => setToast(`Rejected ${specId}`),
            onError: (e) => setToast(`Reject failed: ${(e as Error).message}`),
          },
        );
      } else {
        setToast(`"${actionId}" not yet wired`);
      }
      return;
    }
    if (d.type === "overfitting_warning") {
      setToast(`"${actionId}" not yet wired`);
      return;
    }
    setToast(`"${actionId}" not yet wired`);
  }

  const { run, phases, pendingDecisions, bestModel, bestModelTrend, agentStrip, quickStats } = data;

  // Find the currently-running agent for StatusCard
  const runningAgent = agentStrip.find((a) => a.status === "running");

  return (
    <div className="space-y-6" data-testid="command-center">
      {/* Status Card — hero element */}
      {humanStatus && (
        <StatusCard
          status={humanStatus}
          startedAt={run.startedAt}
          updatedAt={run.updatedAt}
          currentAgent={runningAgent?.name}
        />
      )}

      {toast && (
        <div
          data-testid="cc-toast"
          className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border border-[var(--border-default)] rounded px-3 py-1.5"
        >
          {toast}
        </div>
      )}

      {/* Stepper */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <PipelineStepper phases={phases} currentPhase={run.currentPhase} />
      </div>

      {/* Decisions Pending */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Decisions Pending</h3>
          <span data-testid="decisions-count" className="text-xs text-[var(--text-muted)]">
            {pendingDecisions.length}
          </span>
        </div>
        {pendingDecisions.length === 0 ? (
          <p data-testid="decisions-empty" className="text-xs text-[var(--text-muted)] italic">
            Nothing waiting on you right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {pendingDecisions.map((d) => (
              <li
                key={d.id}
                data-testid={`decision-${d.id}`}
                data-type={d.type}
                className="border border-[var(--border-default)] rounded p-3"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{d.title}</p>
                    <p className="text-xs text-[var(--text-secondary)] mt-0.5">{d.description}</p>
                  </div>
                  <ActionBar
                    actions={decisionToActions(d)}
                    onAction={(actionId) => dispatchDecision(d, actionId)}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {([
          { label: "Experiments", value: quickStats.totalExperiments },
          { label: "Best CV Mean", value: quickStats.bestCvMean?.toFixed(4) ?? "—" },
          { label: "Rounds", value: `${quickStats.roundsCompleted}/${run.maxRounds}` },
          { label: "Tokens", value: quickStats.tokensSpent.toLocaleString() },
        ] as const).map((stat) => (
          <div
            key={stat.label}
            className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4"
          >
            <p className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
              {stat.label}
            </p>
            <p className="text-2xl font-bold text-[var(--text-primary)] mt-1">{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Best model card */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Best Model</h3>
          {bestModelTrend.length >= 2 && (
            <Sparkline data={bestModelTrend} width={140} height={32} stroke="var(--accent-green)" />
          )}
        </div>
        {!bestModel ? (
          <p className="text-xs text-[var(--text-muted)] italic">No experiments yet.</p>
        ) : (
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="font-mono text-sm text-[var(--text-primary)]">{bestModel.modelId}</p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                {bestModel.modelType} · CV{" "}
                <span className="text-[var(--accent-blue)] font-mono">
                  {bestModel.cvMean.toFixed(4)}
                </span>{" "}
                · Round {bestModel.roundNumber}
              </p>
            </div>
            <ActionBar
              actions={[
                { id: "details", label: "Details" },
                { id: "compare", label: "Compare" },
              ]}
              onAction={(actionId) => {
                setToast(`"${actionId}" not yet wired`);
              }}
            />
          </div>
        )}
      </div>

      {/* Agent strip */}
      <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">Agents</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {agentStrip.map((a) => {
            const config = getStatusConfig(a.status);
            return (
              <div
                key={a.name}
                data-testid={`agent-${a.name}`}
                className={`border rounded p-3 ${a.status === "running" ? `${config.borderClass} ${config.bgClass}` : "border-[var(--border-default)]"}`}
              >
                <div className="flex items-center gap-1.5 mb-2">
                  <span className="text-sm" aria-hidden="true">{config.emoji}</span>
                  <span className="text-xs font-medium text-[var(--text-primary)] truncate">
                    {a.label}
                  </span>
                </div>
                <p className="text-[10px] text-[var(--text-muted)]">{a.trials} trial(s)</p>
                {a.bestCvMean != null && (
                  <p className="text-[10px] text-[var(--accent-blue)] font-mono">
                    best {a.bestCvMean.toFixed(4)}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}