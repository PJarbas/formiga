import type { AgentReasoningResponse } from "@shared/dashboard-types";
import { SpecDiffViewer } from "./SpecDiffViewer";

interface Props {
  reasoning: AgentReasoningResponse;
}

function DecisionIcon({ status }: { status: string }) {
  if (status === "AUDITED" || status === "SUCCESS") {
    return <span className="text-[var(--accent-green)]">&#10003;</span>;
  }
  if (status === "FAILED" || status === "OVERFITTED") {
    return <span className="text-[var(--accent-red)]">&#10007;</span>;
  }
  return <span className="text-[var(--text-muted)]">&#183;</span>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <h4 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">
        {title}
      </h4>
      {children}
    </div>
  );
}

export function AgentReasoning({ reasoning }: Props) {
  const { hypothesis, learned, nextFocus, approaches, keyDecisions, specDiff, summary } = reasoning;
  const hasContent = hypothesis || learned || nextFocus || approaches.models.length > 0 || keyDecisions.length > 0 || summary;

  if (!hasContent) {
    return (
      <p className="text-xs text-[var(--text-muted)] italic py-4 text-center">
        No reasoning data available yet. Agent has not produced outputs for this run.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {hypothesis && (
        <Section title="Hypothesis">
          <blockquote className="border-l-2 border-[var(--accent-blue)] pl-3 text-sm text-[var(--text-primary)] italic">
            {hypothesis}
          </blockquote>
        </Section>
      )}

      {approaches.models.length > 0 && (
        <Section title="Approach">
          <ul className="text-sm text-[var(--text-secondary)] space-y-1">
            {approaches.models.length > 0 && (
              <li>
                <span className="text-[var(--text-muted)]">Models: </span>
                {approaches.models.join(", ")}
              </li>
            )}
            {approaches.overfittingMitigation && (
              <li>
                <span className="text-[var(--text-muted)]">Overfitting mitigation: </span>
                {approaches.overfittingMitigation}
              </li>
            )}
          </ul>
        </Section>
      )}

      {keyDecisions.length > 0 && (
        <Section title="Key Decisions">
          <div className="space-y-1.5">
            {keyDecisions.slice(0, 8).map((d, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <DecisionIcon status={d.status} />
                <span className="text-[var(--text-primary)] font-medium">{d.modelType}</span>
                <span className="font-mono text-xs text-[var(--accent-blue)]">
                  {d.cvMean.toFixed(4)}
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                  R{d.roundNumber}
                </span>
                {d.reason && (
                  <span className="text-xs text-[var(--accent-red)] truncate max-w-[200px]" title={d.reason}>
                    {d.reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {learned && (
        <Section title="Learned">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{learned}</p>
        </Section>
      )}

      {nextFocus && (
        <Section title="Next Focus">
          <p className="text-sm text-[var(--accent-blue)] leading-relaxed">{nextFocus}</p>
        </Section>
      )}

      {specDiff && (
        <Section title="Spec Evolution">
          <SpecDiffViewer before={specDiff.before} after={specDiff.after} />
        </Section>
      )}

      {!hypothesis && !approaches.models.length && summary && (
        <Section title="Step Output">
          <pre className="whitespace-pre-wrap text-xs text-[var(--text-secondary)] leading-relaxed max-h-[300px] overflow-y-auto">
            {summary}
          </pre>
        </Section>
      )}
    </div>
  );
}
