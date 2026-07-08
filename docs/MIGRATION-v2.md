# Formiga v2 Migration Guide

## Overview

Formiga v2 introduces a redesigned dashboard, inter-agent communication, and several bug fixes. This guide covers breaking changes and migration steps.

## Breaking Changes

### 1. Kanban API Removed

The following endpoints are **gone**:

- `GET /runs/:id/kanban` (HTML redirect — removed)
- `GET /api/runs/:id/kanban` (JSON snapshot — removed)
- `GET /api/runs/:id/kanban/card-detail?cardId=...` (removed)

**Replacement**: Use `GET /api/pipeline/flow` for the pipeline DAG view and `GET /api/pipeline/status` for status.

### 2. Removed Workflows

The following workflow templates are **removed**:

- `workflows/just-do-it/`
- `workflows/do-now/`
- `workflows/do-review-do-verify/`

Active workflows (`ml-pipeline`, `ml-autoresearch`) are unchanged.

### 3. Dashboard Routes

| Old Route | New Route |
|-----------|-----------|
| `/kanban` | `/pipeline` |
| `/runs/:id/kanban` | `/pipeline` |
| `/` (Experiment Board) | `/` (Command Center) |

### 4. New API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/pipeline/flow` | Pipeline DAG with nodes + edges |
| `GET /api/agents/:name/messages` | Inter-agent messages for an agent |
| `GET /api/agents/:name/logs?limit=N` | Paginated agent logs |

### 5. `toExperimentRow()` Unified

Previously, `repository.ts` and `queries.ts` had separate `toExperimentRow()` implementations that could diverge. Both now import from `serializers.ts` — a single source of truth.

### 6. Agent Context Enrichment

`AgentContext` now includes:

- `messenger?: AgentMessenger` — inter-agent mailbox
- `previousFailures` — cross-run failed configs
- `previousSuccesses` — cross-run succeeded configs
- `metricName?: string` — dynamic metric name

### 7. Arena Warm-Start

`ArenaConfig` has a new optional field:

```typescript
datasetSignature?: string  // for warm-start lookups
```

When provided, round 1 prompts include past best results from `getBestByDatasetSignature()`.

### 8. Sidecar Validation

Submission sidecar JSON (`artifacts/{agent}_submission.json`) is now validated against a schema before ingestion. Invalid sidecars are rejected with a log error. Required fields:

- `model_type` (string)
- `cv_mean` (number)
- `train_mean` (number)
- `artifact_path` (string)

## Non-Breaking Changes

- ECharts removed from leaderboard main view (replaced with CSS-only AucBarChart)
- Pipeline Flow screen replaces Kanban board
- Agent side panel shows 5 tabs: Logs, Reasoning, Messages, Artifacts, History
- Streaming metadata extractor now extracts `harness` field from `HARNESS:` markers
- Fan-out executor supports optional `onSpawn` callback in config

## Upgrade Steps

1. **Update dependencies**: `npm install`
2. **Rebuild dashboard**: `npm run build:dashboard`
3. **Update any external tools** that called `/api/runs/:id/kanban` to use `/api/pipeline/flow`
4. **Update workflow configs** that referenced removed workflows — switch to `ml-pipeline` or `ml-autoresearch`