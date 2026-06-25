// ══════════════════════════════════════════════════════════════════════
// main.tsx — React entry point: providers + router
// ══════════════════════════════════════════════════════════════════════

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import PipelineOverview from "./screens/PipelineOverview";
import Kanban from "./screens/Kanban";
import Leaderboard from "./screens/Leaderboard";
import AgentDetail from "./screens/AgentDetail";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 3000,
      staleTime: 2000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <PipelineOverview /> },
      { path: "kanban", element: <Kanban /> },
      { path: "leaderboard", element: <Leaderboard /> },
      { path: "agents/:name", element: <AgentDetail /> },
    ],
  },
]);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
