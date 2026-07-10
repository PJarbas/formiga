# Workflow Architecture

Este documento descreve a arquitetura dos workflows ML do Formiga, seus agentes, fluxos de dados e integração com o dashboard.

## Visão Geral

O Formiga possui dois workflows principais para machine learning:

| Workflow | Descrição | Execução | Agente Final |
|----------|-----------|----------|--------------|
| **ml-pipeline** | Pipeline single-pass com auditoria | Sequencial + Paralelo | `ml-critic` |
| **ml-autoresearch** | Arena competitiva iterativa | Sequencial + Arena Loop | `reporter` |

---

## 1. ML-Pipeline

### Fluxo de Execução

```
┌─────────────────┐
│   Data Analyst  │  ← EDA, data quality, preprocessing recommendations
│   (data-analyst)│
└────────┬────────┘
         │ eda_report.json
         ▼
┌─────────────────┐
│Feature Engineer │  ← Features, split, baseline model
│(feature-engineer)│
└────────┬────────┘
         │ features.parquet, split.pkl
         ├─────────────────────────────┐
         ▼                             ▼
┌─────────────────┐           ┌─────────────────┐
│ Modeler Classic │           │Modeler Advanced │
│(modeler-classic)│           │(modeler-advanced)│
│                 │           │                 │
│ GBM, Linear,    │  parallel │ NN, TabNet,     │
│ Trees, SVM      │  group    │ AutoML, TabPFN  │
└────────┬────────┘           └────────┬────────┘
         │ classic_submission           │ advanced_submission
         └─────────────┬───────────────┘
                       ▼
              ┌─────────────────┐
              │    ML Critic    │  ← Adversarial audit (READ-ONLY)
              │   (ml-critic)   │     8 audit checks per experiment
              └─────────────────┘
                       │
                       ▼
                 audit_report.json
```

### Agentes

| ID | Nome | Role | Step ID | Descrição |
|----|------|------|---------|-----------|
| `data-analyst` | Data Analyst | analysis | `eda` | EDA, data quality, preprocessing |
| `feature-engineer` | Feature Engineer | coding | `features` | Features, split, baseline |
| `modeler-classic` | Modeler Classic | coding | `model-classic` | GBM, Linear, Trees, SVM, Stacking |
| `modeler-advanced` | Modeler Advanced | coding | `model-advanced` | NN, TabNet, AutoML, TabPFN |
| `ml-critic` | ML Critic | analysis | `audit` | Adversarial audit (read-only) |

### Artefatos

| Agente | Artifacts OUT | Artifacts IN |
|--------|---------------|--------------|
| data-analyst | `eda_report.json`, `eda_config.json` | dataset |
| feature-engineer | `features.parquet`, `split.pkl`, `baseline.json` | `eda_report.json` |
| modeler-classic | `modeler-classic_submission.json`, `classic_predictions.csv` | `features.parquet`, `split.pkl` |
| modeler-advanced | `modeler-advanced_submission.json`, `advanced_predictions.csv` | `features.parquet`, `split.pkl` |
| ml-critic | `audit_report.json` | Todos os anteriores (READ-ONLY) |

### Características

- **Single-pass**: Cada agente executa uma vez
- **Parallel group**: `modeler-classic` e `modeler-advanced` executam em paralelo
- **Leaderboard**: Modelers submetem experimentos ao leaderboard
- **Audit**: ML Critic valida TODOS os experimentos com 8 checks
- **Read-only audit**: Critic não pode modificar artefatos de outros agentes

---

## 2. ML-AutoResearch

### Fluxo de Execução

```
┌─────────────────┐
│   Data Analyst  │  ← EDA (igual ao ml-pipeline)
│  (data-analyst) │
└────────┬────────┘
         │ eda_report.json
         ▼
┌─────────────────┐
│Feature Engineer │  ← Features + benchmark scripts
│(feature-engineer)│     (benchmark_runner.py, autoresearch.sh)
└────────┬────────┘
         │ features.parquet, split.pkl, benchmark_config.json
         ▼
┌─────────────────────────────────────────────────────────────┐
│                     ARENA ENGINE                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    Round N                             │  │
│  │  ┌─────────────────┐     ┌─────────────────┐          │  │
│  │  │Arena Modeler    │     │Arena Modeler    │          │  │
│  │  │    Classic      │ vs  │   Advanced      │          │  │
│  │  │(modeler-classic)│     │(modeler-advanced)│          │  │
│  │  └────────┬────────┘     └────────┬────────┘          │  │
│  │           │                       │                    │  │
│  │           └───────────┬───────────┘                    │  │
│  │                       ▼                                │  │
│  │              ┌─────────────────┐                       │  │
│  │              │   Benchmark     │  ← Executa script,    │  │
│  │              │   Evaluation    │    mede métrica       │  │
│  │              └────────┬────────┘                       │  │
│  │                       │                                │  │
│  │              ┌────────▼────────┐                       │  │
│  │              │    Decision     │  ← keep/discard/crash │  │
│  │              │     Engine      │                       │  │
│  │              └─────────────────┘                       │  │
│  └───────────────────────────────────────────────────────┘  │
│                          │                                   │
│            (repete até convergir ou max_rounds)              │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Arena Reporter  │  ← Relatório final
                    │   (reporter)    │     da competição
                    └─────────────────┘
```

### Agentes

| ID | Nome | Role | Step ID | Descrição |
|----|------|------|---------|-----------|
| `data-analyst` | Data Analyst | analysis | `eda` | EDA (igual ml-pipeline) |
| `feature-engineer` | Feature Engineer | coding | `features` | Features + benchmark scripts |
| `arena-modeler-classic` | Arena Modeler Classic | coding | `arena` | Competidor clássico na arena |
| `arena-modeler-advanced` | Arena Modeler Advanced | coding | `arena` | Competidor avançado na arena |
| `reporter` | Arena Reporter | analysis | `report` | Relatório final da competição |

### Artefatos

| Agente | Artifacts OUT | Artifacts IN |
|--------|---------------|--------------|
| data-analyst | `eda_report.json`, `eda_config.json` | dataset |
| feature-engineer | `features.parquet`, `split.pkl`, `benchmark_config.json`, `benchmark_runner.py`, `autoresearch.sh` | `eda_report.json` |
| arena-modeler-classic | `modeler-classic_round{N}.py`, modelo | `features.parquet`, `benchmark_config.json`, histórico arena |
| arena-modeler-advanced | `modeler-advanced_round{N}.py`, modelo | `features.parquet`, `benchmark_config.json`, histórico arena |
| reporter | `arena_report.json` | Todos os artefatos + leaderboard + arena session |

### Arena Engine

O passo `arena` é especial e executado pelo **arena-engine.ts**, não por um agente único:

```typescript
// src/arena/arena-workflow.ts
const ARENA_AGENTS: ArenaAgentConfig[] = [
  { id: "modeler-classic", agentPersona: "arena-modeler-classic", ... },
  { id: "modeler-advanced", agentPersona: "arena-modeler-advanced", ... },
];
```

**Nota importante**: Os IDs internos da arena são `modeler-classic` e `modeler-advanced`, mas os agentes no workflow.yml são `arena-modeler-classic` e `arena-modeler-advanced`.

### Características

- **Iterativo**: Arena executa N rounds até convergir
- **Competitivo**: Dois agentes competem em cada round
- **Benchmark automático**: Script Python avalia cada modelo
- **Decisões**: `keep` (melhoria), `discard` (pior), `crash` (erro)
- **Warm-start**: Usa resultados de datasets similares anteriores
- **Reporter**: Gera relatório final (não existe no ml-pipeline)

---

## 3. Diferenças Chave

| Aspecto | ml-pipeline | ml-autoresearch |
|---------|-------------|-----------------|
| **Execução** | Single-pass | Iterativo (N rounds) |
| **Modelers** | `modeler-classic`, `modeler-advanced` | `arena-modeler-classic`, `arena-modeler-advanced` |
| **Agente final** | `ml-critic` (audit) | `reporter` (relatório) |
| **Passo arena** | Não existe | Sim (arena engine) |
| **Benchmark** | Leaderboard manual | Benchmark automático |
| **Convergência** | N/A | `maxRounds`, `maxNoImprove`, `targetMetric` |

---

## 4. Integração com Dashboard

### AGENT_INFO_REGISTRY

O dashboard usa um registro de agentes em `src/shared/dashboard-types.ts`:

```typescript
export const AGENT_INFO_REGISTRY: Record<string, AgentInfo> = {
  "data-analyst": { ... },
  "feature-engineer": { ... },
  "modeler-classic": { ... },      // ml-pipeline ONLY
  "modeler-advanced": { ... },     // ml-pipeline ONLY
  "ml-critic": { ... },            // ml-pipeline ONLY
  // FALTAM:
  // "arena-modeler-classic"       // ml-autoresearch
  // "arena-modeler-advanced"      // ml-autoresearch
  // "reporter"                    // ml-autoresearch
};
```

### Pipeline Flow (Dashboard)

O componente `PipelineFlowScreen.tsx` renderiza o DAG de agentes:

```typescript
// PROBLEMA: gridPositions é hardcoded para ml-pipeline
const gridPositions: Record<string, { row: number; col: number }> = {
  "data-analyst": { row: 0, col: 1 },
  "feature-engineer": { row: 1, col: 1 },
  "modeler-classic": { row: 2, col: 0 },
  "modeler-advanced": { row: 2, col: 2 },
  "ml-critic": { row: 3, col: 1 },          // NÃO existe no ml-autoresearch
};
```

### PipelineStatus Type

```typescript
// PROBLEMA: phaseStats assume sempre os 5 agentes de ml-pipeline
interface PipelineStatus {
  phaseStats: {
    dataAnalyst: AgentStatus;
    featureEngineer: AgentStatus;
    modelerClassic: AgentStatus;
    modelerAdvanced: AgentStatus;
    mlCritic: AgentStatus;              // NÃO existe no ml-autoresearch
  };
}
```

---

## 5. Problemas Conhecidos

### Dashboard Hardcoded para ml-pipeline

| Arquivo | Linha | Problema |
|---------|-------|----------|
| `PipelineFlowScreen.tsx` | 38-44 | `gridPositions` hardcoded para 5 agentes |
| `dashboard.ts` | 977-983 | Filtro de agentes retorna ml-pipeline mesmo para ml-autoresearch |
| `dashboard.ts` | 1004-1022 | Edges referenciam `ml-critic` em ml-autoresearch |
| `dashboard-types.ts` | 278-339 | `AGENT_INFO_REGISTRY` não tem agentes de arena |
| `dashboard-types.ts` | 126-132 | `PipelineStatus.phaseStats` hardcoded |
| `dashboard.ts` | 923-929 | `phaseStats` tenta buscar `ml-critic` em todos workflows |

### Solução Recomendada

1. **Dinamizar AGENT_INFO_REGISTRY** por workflow type
2. **Criar registros separados** para ml-pipeline e ml-autoresearch
3. **gridPositions dinâmico** baseado no workflow atual
4. **edges dinâmicas** baseadas no workflow
5. **phaseStats genérico** que aceita qualquer conjunto de agentes

---

## 6. API Endpoints Relevantes

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/pipeline/status` | Status do pipeline (inclui phaseStats) |
| `GET /api/pipeline/flow` | Nodes e edges para o DAG |
| `GET /api/runs/:runId/agent-artifacts` | Lista artefatos de um run |
| `GET /api/runs/:runId/agent-artifacts/:key` | Lê artefato específico |
| `POST /api/runs/:runId/agent-artifacts/:key` | Salva artefato |
| `GET /api/arena/:runId/session` | Sessão da arena |
| `GET /api/arena/:runId/rounds` | Rounds da arena |
| `GET /api/leaderboard/*` | Endpoints do leaderboard |

---

## 7. Referências de Arquivos

### Definições de Workflow
- `workflows/ml-pipeline/workflow.yml`
- `workflows/ml-autoresearch/workflow.yml`

### Arena Engine
- `src/arena/arena-engine.ts` — Loop principal da arena
- `src/arena/arena-workflow.ts` — Bridge com workflow scheduler
- `src/arena/arena-types.ts` — Tipos TypeScript
- `src/arena/arena-benchmark.ts` — Execução de benchmark

### Dashboard
- `src/dashboard/src/screens/PipelineFlowScreen.tsx` — Visualização DAG
- `src/server/dashboard.ts` — API endpoints
- `src/shared/dashboard-types.ts` — Tipos compartilhados

### Agentes
- `workflows/ml-pipeline/agents/` — Agentes do ml-pipeline
- `workflows/ml-autoresearch/agents/` — Agentes do ml-autoresearch
