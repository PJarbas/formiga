# Formiga v2 Redesign — Implementation Checklist

> Branch: `feat/redesign-v2`

## Phase 0 — Backend Bug Fixes

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 0.1 | Wire AgentMessenger to AgentContext (BUG-2, BUG-1) | ✅ Done | `interfaces.ts`, `communication.ts`, `round-manager.ts` |
| 0.2 | Fix fromArenaExperiment train/val metric (BUG-3) | ✅ Done | `repository.ts`, `arena-types.ts` |
| 0.3 | Unify toExperimentRow() (BUG-8) | ✅ Done | New `serializers.ts`, `repository.ts`, `queries.ts` |
| 0.4 | Fix agent_name match in queries (BUG-4) | ✅ Done | `queries.ts` |
| 0.5 | Fix hardcoded metric_name in fan-in (BUG-5) | ✅ Done | `fan-in.ts`, `interfaces.ts`, `pi-executor.ts` |
| 0.6 | Fix extractFailureReason() patterns (BUG-6) | ✅ Done | `pi-executor.ts` |
| 0.7 | Unify sidecar JSON path (BUG-7) | ✅ Done | `pi-executor.ts` |
| 0.8 | Arena: safe spawn + real model_type | ✅ Done | `arena-engine.ts`, `arena-types.ts` |

## Phase 0.9 — Auto-Research Loop

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 0.9.1-2 | Inject previousFailures/previousSuccesses into context | ✅ Done | `interfaces.ts`, `round-manager.ts` |
| 0.9.3 | Arena warm-start with getBestByDatasetSignature | ✅ Done | `arena-engine.ts`, `arena-types.ts` |
| 0.9.4 | Protocol in AGENTS.md files | ✅ Done | Modeler AGENTS.md already have failure avoidance |
| 0.10.3 | Split checksum in AGENTS.md | ✅ Done | Modeler AGENTS.md — checksum section added |

## Phase 0.10 — Artifact Validation

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 0.10.1 | Sidecar validation schema | ✅ Done | New `sidecar-schema.ts`, `ingest.ts` |
| 0.10.2 | Validate artifact_path existence | ✅ Done | `fan-in.ts` |
| 0.10.3 | Split checksum in AGENTS.md | ⬜ Pending | `workflows/*/AGENTS.md` |
| 0.10.4 | onSpawn callback in piFanOutExecutor | ✅ Done | `fan-out.ts` |

## Phase 1 — Backend Infrastructure for New UI

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 1.1 | Extend AgentInfo with harness, artifactsOut, messagesCount | ✅ Done | `dashboard-types.ts` |
| 1.2 | PipelineFlowNode/Edge types | ✅ Done | `dashboard-types.ts` |
| 1.3 | GET /api/pipeline/flow endpoint | ✅ Done | `dashboard.ts` |
| 1.4 | GET /api/agents/:name/messages endpoint | ✅ Done | `dashboard.ts` |
| 1.5 | Harness field in streaming metadata | ✅ Done | `streaming-metadata-extractor.ts` |

## Phase 2 — ML Leaderboard Redesign

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 2.1 | StatTiles component | ✅ Done | New `StatTiles.tsx` |
| 2.2 | AucBarChart (CSS pure) | ✅ Done | New `AucBarChart.tsx` |
| 2.3 | GapPill + FoldSparkline | ✅ Done | New `GapPill.tsx`, `FoldSparkline.tsx` |
| 2.4 | Refactor ExperimentsTable | ✅ Done | `Leaderboard.tsx` (redesigned) |
| 2.5 | ArenaSectionCollapsible | ✅ Done | New `ArenaSectionCollapsible.tsx` |
| 2.6 | Remove ECharts from main view | ✅ Done | `Leaderboard.tsx` (replaced with AucBarChart) |

## Phase 3 — Pipeline Flow (replaces kanban)

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 3.1 | PipelineFlowScreen (DAG + CSS Grid) | ✅ Done | New `PipelineFlowScreen.tsx` |
| 3.2 | AgentNode (with timeout progress) | ✅ Done | New `AgentNode.tsx` |
| 3.3 | ArtifactEdge (SVG animated) | ✅ Done | New `ArtifactEdge.tsx` |
| 3.4 | AgentSidePanel (5 tabs) | ✅ Done | New `AgentSidePanel.tsx` |
| 3.5 | /pipeline route, remove /kanban | ✅ Done | `main.tsx`, `App.tsx` |

## Phase 4 — App Shell Refinement

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 4.1 | Nav: Command Center | Pipeline Flow | ML Leaderboard | ✅ Done | `App.tsx` |
| 4.2 | Remove Phase/Agent toggle | ✅ Done | `Leaderboard.tsx` (removed chart toggle) |
| 4.3 | Update breadcrumbs | ✅ Done | Nav items updated |

## Phase 5 — Dead Code Cleanup

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 5.1 | Remove unused workflows | ✅ Done | `workflows/` |
| 5.2 | Remove legacy agent implementations | ✅ N/A | All agents in active use by RoundManager |
| 5.3 | Remove orchestrator legacy | ✅ N/A | All orchestrator files in active use |
| 5.4 | Remove kanban components | ✅ Done | `ExperimentBoard.tsx`, `kanban-data.ts`, routes |
| 5.5 | Clean tests | ✅ Done | Removed `dashboard-kanban.test.ts`, `kanban-data.test.ts` |
| 5.6 | CLI simplification | ✅ Done | `cli.ts` — added deprecation warnings |
| 5.7 | Validation checklist | ✅ Done | See below |
| 5.8 | Migration docs | ✅ Done | `docs/MIGRATION-v2.md` |

## Build Verification

- [x] `tsc --noEmit` passes
- [x] All existing tests pass (76/76 real tests)
- [x] `npm run build` passes
- [ ] Full test suite green (empty test files report as failures — 76 actual tests pass)