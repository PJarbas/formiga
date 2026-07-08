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
| 0.9.3 | Arena warm-start with getBestByDatasetSignature | ⬜ Pending | `arena-engine.ts` |
| 0.9.4 | Protocol in AGENTS.md files | ⬜ Pending | `workflows/*/AGENTS.md` |

## Phase 0.10 — Artifact Validation

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 0.10.1 | Sidecar validation schema | ✅ Done | New `sidecar-schema.ts`, `ingest.ts` |
| 0.10.2 | Validate artifact_path existence | ✅ Done | `fan-in.ts` |
| 0.10.3 | Split checksum in AGENTS.md | ⬜ Pending | `workflows/*/AGENTS.md` |
| 0.10.4 | onSpawn callback in piFanOutExecutor | ⬜ Pending | `pi-executor.ts` |

## Phase 1 — Backend Infrastructure for New UI

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 1.1 | Extend AgentInfo with harness, artifactsOut, messagesCount | ✅ Done | `dashboard-types.ts` |
| 1.2 | PipelineFlowNode/Edge types | ✅ Done | `dashboard-types.ts` |
| 1.3 | GET /api/pipeline/flow endpoint | ✅ Done | `dashboard.ts` |
| 1.4 | GET /api/agents/:name/messages endpoint | ✅ Done | `dashboard.ts` |
| 1.5 | Harness field in streaming metadata | ⬜ Pending | `streaming-metadata-extractor.ts` |

## Phase 2 — ML Leaderboard Redesign

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 2.1 | StatTiles component | ⬜ Pending | New `StatTiles.tsx` |
| 2.2 | AucBarChart (CSS pure) | ⬜ Pending | New `AucBarChart.tsx` |
| 2.3 | GapPill + FoldSparkline | ⬜ Pending | New components |
| 2.4 | Refactor ExperimentsTable | ⬜ Pending | `ExperimentsTable.tsx` |
| 2.5 | ArenaSectionCollapsible | ⬜ Pending | New component |
| 2.6 | Remove ECharts from main view | ⬜ Pending | Leaderboard screen |

## Phase 3 — Pipeline Flow (replaces kanban)

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 3.1 | PipelineFlowScreen (DAG + CSS Grid) | ⬜ Pending | New component |
| 3.2 | AgentNode (with timeout progress) | ⬜ Pending | New component |
| 3.3 | ArtifactEdge (SVG animated) | ⬜ Pending | New component |
| 3.4 | AgentSidePanel (5 tabs) | ⬜ Pending | New component |
| 3.5 | /pipeline route, remove /kanban | ⬜ Pending | `App.tsx`, routing |

## Phase 4 — App Shell Refinement

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 4.1 | Nav: Command Center \| Pipeline Flow \| ML Leaderboard | ⬜ Pending | `App.tsx` |
| 4.2 | Remove Phase/Agent toggle | ⬜ Pending | `App.tsx` |
| 4.3 | Update breadcrumbs | ⬜ Pending | `App.tsx` |

## Phase 5 — Dead Code Cleanup

| # | Task | Status | Files Changed |
|---|------|--------|---------------|
| 5.1 | Remove unused workflows | ⬜ Pending | `workflows/` |
| 5.2 | Remove legacy agent implementations | ⬜ Pending | `src/agents/` |
| 5.3 | Remove orchestrator legacy | ⬜ Pending | `src/orchestrator/` |
| 5.4 | Remove kanban components | ⬜ Pending | `screens/` |
| 5.5 | Clean tests | ⬜ Pending | Tests |
| 5.6 | CLI simplification | ⬜ Pending | `cli.ts` |
| 5.7 | Validation checklist | ⬜ Pending | — |
| 5.8 | Migration docs | ⬜ Pending | `docs/MIGRATION-v2.md` |

## Build Verification

- [x] `tsc --noEmit` passes
- [x] All existing tests pass (3/3 real tests)
- [ ] `npm run build` passes
- [ ] Full test suite green