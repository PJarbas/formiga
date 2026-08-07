import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ModelDetailPanel } from "./ModelDetailPanel.js";
import type { LeaderboardEntry } from "@shared/dashboard-types";

function makeEntry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    id: "entry-1",
    runId: "run-1",
    roundNumber: 3,
    agentName: "researcher",
    modelId: "xgb-001",
    modelType: "xgboost",
    modelAlgorithm: "xgboost",
    problemType: "classification",
    status: "SUCCESS",
    cvMean: 0.95,
    cvStd: 0.02,
    trainMean: 0.99,
    trainValGap: 0.04,
    hyperparameters: { learning_rate: 0.1, n_estimators: 100 },
    featureImportancesTop10: [["f1", 0.5], ["f2", 0.3]],
    trainTimeSeconds: 12,
    inferenceTimeMsPer1k: 30,
    createdAt: "2026-01-01T00:00:00Z",
    promotedAt: null,
    rejectedAt: null,
    rejectReason: null,
    artifactPath: "/tmp/artifact.pkl",
    hypothesis: "Higher learning rate helps",
    learned: "Smaller trees converge faster",
    metrics: {
      classification: { f1: 0.93, precision: 0.92, recall: 0.91, rocAuc: 0.96, logLoss: 0.21 },
    },
    ...overrides,
  };
}

function renderDrawer(entry: LeaderboardEntry = makeEntry(), onClose = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ModelDetailPanel entry={entry} onClose={onClose} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ModelDetailPanel", () => {
  it("opens as a drawer showing the model id and status", () => {
    renderDrawer();
    const drawer = screen.getByTestId("model-detail-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByText("xgb-001")).toBeTruthy();
    expect(screen.getByText("SUCCESS")).toBeTruthy();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    renderDrawer(makeEntry(), onClose);
    fireEvent.click(screen.getByLabelText("Close panel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderDrawer(makeEntry(), onClose);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the metrics grid and hyperparameters in the overview tab", () => {
    renderDrawer();
    expect(screen.getByText("Métricas")).toBeTruthy();
    // hyperparameter key/value rows
    expect(screen.getByText("learning_rate")).toBeTruthy();
    expect(screen.getByText("0.1")).toBeTruthy();
    expect(screen.getByText("n_estimators")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("switches to the report tab and renders fetched content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ content: "# Relatório de teste", filename: "report.md" }),
      }),
    );
    renderDrawer();
    fireEvent.click(screen.getByText("Relatório"));
    expect(await screen.findByText(/Relatório de teste/)).toBeTruthy();
  });

  it("switches to the script tab and renders fetched script", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          script: "print('reproduce me')",
          filename: "reproduce.py",
          language: "python",
        }),
      }),
    );
    renderDrawer();
    fireEvent.click(screen.getByText("Script de Reprodução"));
    expect(await screen.findByText("Baixar .py")).toBeTruthy();
  });
});
