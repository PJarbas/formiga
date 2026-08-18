// ══════════════════════════════════════════════════════════════════════
// main.tsx — React entry point: providers + router
// ══════════════════════════════════════════════════════════════════════

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import App from "./App";
import Runs from "./screens/Runs";
import PipelineFlowScreen from "./screens/PipelineFlowScreen";
import Leaderboard from "./screens/Leaderboard";
import { KanbanRedirect } from "./components/KanbanRedirect";
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
      { index: true, element: <Runs /> },
      { path: "pipeline", element: <PipelineFlowScreen /> },
      { path: "leaderboard", element: <Leaderboard /> },
      { path: "kanban", element: <KanbanRedirect /> },
      { path: "runs/:id/kanban", element: <KanbanRedirect /> },
      { path: "*", element: <Runs /> },
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
