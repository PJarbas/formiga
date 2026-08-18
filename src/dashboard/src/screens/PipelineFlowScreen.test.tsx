// ══════════════════════════════════════════════════════════════════════
// PipelineFlowScreen.test.tsx — ?run= is forwarded to /api/pipeline/flow
// and the /kanban redirect preserves it (regression for issue #128).
// ══════════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PipelineFlowScreen from "./PipelineFlowScreen.js";
import { KanbanRedirect } from "../components/KanbanRedirect.js";

// The DAG canvas and side panel pull in heavy React Flow / data wiring that
// isn't relevant to the URL→fetch behaviour under test.
vi.mock("../components/PipelineFlow/DagCanvas", () => ({
  default: () => null,
}));
vi.mock("../components/PipelineFlow/AgentSidePanel", () => ({
  AgentSidePanel: () => null,
}));

const fetchMock = vi.fn();

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
    },
  });
}

function renderScreen(initialUrl: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ nodes: [], edges: [], runId: null, runStatus: null, workflowType: "ml-pipeline" }),
  });
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <PipelineFlowScreen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="probe">{location.pathname}{location.search}</div>;
}

describe("PipelineFlowScreen", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the URL ?run= to /api/pipeline/flow", async () => {
    renderScreen("/pipeline?run=run-abc-123");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/pipeline/flow?run=run-abc-123");
  });

  it("requests the flow without ?run= when the URL has no run param", async () => {
    renderScreen("/pipeline");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/pipeline/flow");
  });
});

describe("KanbanRedirect", () => {
  it("preserves the ?run= query when redirecting /kanban → /pipeline", async () => {
    render(
      <MemoryRouter initialEntries={["/kanban?run=run-xyz"]}>
        <Routes>
          <Route path="/kanban" element={<KanbanRedirect />} />
          <Route path="/pipeline" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("/pipeline?run=run-xyz"));
  });

  it("redirects without a query when none is present", async () => {
    render(
      <MemoryRouter initialEntries={["/kanban"]}>
        <Routes>
          <Route path="/kanban" element={<KanbanRedirect />} />
          <Route path="/pipeline" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("/pipeline"));
  });
});
