// ══════════════════════════════════════════════════════════════════════
// ReportSummaryCards.test.tsx — key-metric cards extracted from a report
// ══════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportSummaryCards } from "./ReportSummaryCards";
import type { BaselineMetrics } from "../../lib/parseReportMarkdown";

function makeBaseline(overrides: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    model: "LightGBM",
    cvMean: 0.9789,
    cvStd: 0.0288,
    trainMean: 0.9789,
    trainR2: 0.9789,
    valR2: null,
    testR2: null,
    metric: "R²",
    ...overrides,
  };
}

describe("ReportSummaryCards", () => {
  it("renders all five summary cards from a parsed baseline", () => {
    render(<ReportSummaryCards baseline={makeBaseline()} featureCount={6} />);

    // Labels
    expect(screen.getByText("R² CV")).toBeTruthy();
    expect(screen.getByText("R² Treino")).toBeTruthy();
    expect(screen.getByText("Gap Treino/Val")).toBeTruthy();
    expect(screen.getByText("Features Selecionadas")).toBeTruthy();
    expect(screen.getByText("Modelo Base")).toBeTruthy();

    // Values (pt-BR formatting: comma decimal separator)
    expect(screen.getAllByText("0,9789")).toHaveLength(2); // CV + Treino
    expect(screen.getByText("± 0,0288")).toBeTruthy();
    expect(screen.getByText("✅ Baixo")).toBeTruthy(); // gap 0 → low
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("LightGBM")).toBeTruthy();
  });

  it("renders nothing when there is no baseline and no feature count", () => {
    const { container } = render(
      <ReportSummaryCards baseline={null} featureCount={null} />,
    );
    expect(container.textContent).toBe("");
  });

  it("omits the CV ± sub-value when cvStd is null", () => {
    render(
      <ReportSummaryCards baseline={makeBaseline({ cvStd: null })} featureCount={null} />,
    );
    expect(screen.queryByText(/±/)).toBeNull();
  });

  it("uses container queries instead of viewport lg breakpoints (fits the 480px drawer)", () => {
    const { container } = render(
      <ReportSummaryCards baseline={makeBaseline()} featureCount={6} />,
    );
    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain("@container");
    expect(grid.className).toContain("@min-[560px]:grid-cols-4");
    expect(grid.className).not.toContain("lg:grid-cols-4");
  });
});
