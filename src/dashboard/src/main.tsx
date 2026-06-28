// ══════════════════════════════════════════════════════════════════════
// main.tsx — React entry point: providers + router
// ══════════════════════════════════════════════════════════════════════

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import App from "./App";
import CommandCenter from "./screens/CommandCenter";
import ExperimentBoard from "./screens/ExperimentBoard";
import Leaderboard from "./screens/Leaderboard";
import AgentDetail from "./screens/AgentDetail";
import { ToastContainer } from "./components/Toast";
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
      { index: true, element: <CommandCenter /> },
      { path: "kanban", element: <ExperimentBoard /> },
      { path: "leaderboard", element: <Leaderboard /> },
      { path: "agents/:name", element: <AgentDetail /> },
      { path: "runs/:id/kanban", element: <Navigate to="/kanban" replace /> },
      { path: "*", element: <CommandCenter /> },
    ],
  },
]);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ToastContainer />
      </QueryClientProvider>
    </StrictMode>,
  );
}
