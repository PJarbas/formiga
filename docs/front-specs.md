# Frontend Spec — ML Dashboard Redesign

**Projeto:** Formiga
**Versão atual:** Branch 6 (`feat/dashboard-ml-views`)
**Status:** Spec para Branch 7

---

## 1. Crítica das Telas Atuais

### Tela 1: Pipeline Overview (`/ml/`)

**Bom:**
- Quick stats com métricas certas (experiments, best CV, rounds, tokens)
- Status dots nos agentes dão visibilidade imediata de quem está ativo

**Ruim:**
- Cards de agents são apenas badges de status — zero insight sobre o que o agente produziu
- Phase progress bar é genérica demais (não mostra tempo gasto vs estimado)
- **Não há ações** — o cientista só observa, não pode intervir

### Tela 2: Kanban (`/ml/kanban`)

**Ruim:**
- Lanes por agent é a perspectiva errada para o cientista — ele pensa em fases do experimento, não em quem fez
- Cards minimalistas: título + subtítulo sem contexto (features criadas? métricas? artefatos?)
- Dialog de detalhe mostra apenas o ID — inútil
- Nenhuma affordance para aprovação/rejeição
- Não mostra dependências entre cards

### Tela 3: Leaderboard (`/ml/leaderboard`)

**Bom:**
- Tabela sortable + chart de evolução (ECharts)

**Ruim:**
- Sem comparação side-by-side de modelos
- Feature importances e hyperparameters existem no tipo mas não são renderizados
- Sem ação de "promover modelo" ou "rejeitar/excluir"
- Chart mostra sequência linear mas não relaciona com rounds

---

## 2. Proposta de Redesign

### 2.1 Arquitetura de Navegação

Rotas mantidas com React Router:

```
/                  → Command Center (substitui Overview)
/kanban            → Experiment Board (Kanban reimaginado)
/leaderboard       → Model Arena (Leaderboard com comparação)
/agents/:name      → Agent Deep Dive (mantido, com trace visual)
```

---

## 3. Tela 1: Command Center (`/`)

### 3.1 Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│ HEADER: Formiga ML  ▸ Run abc123  ● running  Round 2/5  ⏱ 12m      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ PIPELINE STEPPER (horizontal) ────────────────────────────────┐ │
│  │  ●━━━●━━━◉━━━○━━━○                                            │ │
│  │  EDA   Feat   Model   Audit   Complete                         │ │
│  │  2m     3m    ▸ 7m     —       —                               │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ DECISIONS PENDING (action center) ────────────────────────────┐ │
│  │                                                                │ │
│  │  ⚠ Feature spec needs approval          [Review] [Auto-approve]│ │
│  │  ⚠ ML Critic rejected model xgb-042     [See reason] [Override]│ │
│  │  ✓ 3 models passed audit this round                            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ QUICK STATS ─────┐  ┌─ BEST MODEL (sparkline) ──────────────┐ │
│  │  Experiments: 47   │  │  ◆ xgb-038  CV: 0.8734 ± 0.012       │ │
│  │  Best CV: 0.8734   │  │  Gap: 0.003  Train: 12.4s            │ │
│  │  Tokens: 142k      │  │  [Compare] [Promote] [Details]        │ │
│  │  Failures: 2       │  │  ┄┄┄╱╲╱╲╱╲╱╲╱╲╱╲ (mini chart)       │ │
│  └────────────────────┘  └───────────────────────────────────────┘ │
│                                                                     │
│  ┌─ AGENT STATUS STRIP ──────────────────────────────────────────┐ │
│  │  📊 Analyst ✓   🔧 FeatEng ✓   🤖 Classic ▸   🧠 Adv ○  🔍 ○ │ │
│  │     2m12s          3m45s          running        queued   queued│ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Diferenças-chave

| Antes | Depois |
|-------|--------|
| Cards estáticos sem ação | "Decisions Pending" no topo — o cientista vê o que precisa de atenção |
| Sem best model visível | Best model destacado com ação direta (promote/compare) |
| Progress bar genérico | Stepper mostra tempo real por fase, não apenas dots |
| Sem intervenção | Botões de ação em cada seção |

### 3.3 Estados

| Seção | Loading | Empty | Error | Normal |
|-------|---------|-------|-------|--------|
| Pipeline Stepper | Skeleton bars | Stepper com fases futuras cinzas (○) | Toast + retry button | Fases preenchidas com tempo |
| Decisions Pending | Skeleton list | "No pending decisions" + check verde | Toast + retry button | Lista de ações com botões |
| Best Model | Skeleton card | "Waiting for first model" | Toast + retry button | Modelo com sparkline e ações |
| Agent Strip | Pulse animation | 5 agentes com status ○ (queued) | Toast + retry button | Status dots + timers |

---

## 4. Tela 2: Experiment Board (`/kanban`)

### 4.1 Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  View: [● Phase] [Agent] [Status]     Filter: [All rounds ▾]       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  SPEC/PLAN        IN PROGRESS       VALIDATION       APPROVED       │
│  ───────────      ───────────       ──────────       ────────       │
│                                                                     │
│  ┌──────────┐    ┌──────────┐     ┌──────────┐    ┌──────────┐    │
│  │ 📋 feat  │    │ 🤖 xgb   │     │ 🔍 audit │    │ ✅ rf-012 │    │
│  │ spec v2  │    │ trial-043│     │ xgb-038  │    │ CV: 0.871│    │
│  │          │    │          │     │          │    │          │    │
│  │ agent:   │    │ CV: 0.87 │     │ 6/8 pass │    │ promoted │    │
│  │ feat-eng │    │ ⏱ 2m34s  │     │ ⚠ 2 warn │    │ round 2  │    │
│  │          │    │          │     │          │    │          │    │
│  │ [Approve]│    │ ▓▓▓░░ 60%│     │ [Accept] │    │ [Compare]│    │
│  │ [Edit]   │    │          │     │ [Reject] │    │          │    │
│  │ [Reject] │    │          │     │          │    │          │    │
│  └──────────┘    └──────────┘     └──────────┘    └──────────┘    │
│                                                                     │
│  ┌──────────┐    ┌──────────┐                                      │
│  │ 📋 model │    │ 🧠 tabnet│                                      │
│  │ strategy │    │ trial-044│                                      │
│  │          │    │          │                                      │
│  │ [Review] │    │ CV: 0.86 │                                      │
│  └──────────┘    └──────────┘                                      │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ DETAIL PANEL (expandable, shows when card selected)                 │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │  feat spec v2 — Feature Engineer                                │ │
│ │                                                                 │ │
│ │  SPEC DIFF:                          CHECKLIST:                 │ │
│ │  ┌──────────────────────┐            ☑ No data leakage         │ │
│ │  │ + lag_7d feature     │            ☑ Deterministic split     │ │
│ │  │ + rolling_mean_30d   │            ☐ Feature correlation < 0.9│ │
│ │  │ - removed: raw_date  │            ☐ Null ratio < 5%         │ │
│ │  └──────────────────────┘            ☐ VIF check passed        │ │
│ │                                                                 │ │
│ │  TRACE:                                                         │ │
│ │  12:03:04 → Agent started feat-eng plan                         │ │
│ │  12:03:12 → Read train.csv (42k rows × 18 cols)                │ │
│ │  12:03:45 → Generated 12 candidate features                     │ │
│ │  12:04:02 → Wrote features_v2.py                                │ │
│ │                                                                 │ │
│ │  [✓ Approve Spec] [✗ Reject] [✎ Edit & Re-run]                 │ │
│ └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Mudanças Fundamentais

| Antes | Depois |
|-------|--------|
| Lanes = agent | Lanes = lifecycle (Spec → In Progress → Validation → Approved) |
| View fixa | Toggle de view: fase / agent / status |
| Cards sem ação | Ações inline: Approve / Reject / Edit |
| Dialog só com ID | Detail panel com 3 seções: diff, checklist, trace |
| Sem checklist | Checklist interativo — cientista marca/desmarca e persiste via API |

### 4.3 View Toggles

O toggle `View` no topo alterna o agrupamento das lanes:

| View Mode | Lanes |
|-----------|-------|
| **Phase** (default) | Spec/Plan → In Progress → Validation → Approved |
| **Agent** | data-analyst → feature-engineer → modeler-classic → modeler-advanced → ml-critic |
| **Status** | Pending → Running → Success → Failed → Audited |

### 4.4 Estados

| Seção | Loading | Empty | Error | Normal |
|-------|---------|-------|-------|--------|
| Board lanes | Skeleton cards (4 por lane) | "No experiments yet" com botão de refresh | Toast + retry | Cards com ações |
| Detail panel | Skeleton (diff + checklist + trace) | Hidden (só abre quando card clicado) | Toast inline no panel | 3 seções preenchidas |
| Checklist | Checkboxes disabled com spinner | Todos unchecked | Toast + retry save | Checkboxes interativos |

---

## 5. Tela 3: Model Arena (`/leaderboard`)

### 5.1 Wireframe

```
┌─────────────────────────────────────────────────────────────────────┐
│  Leaderboard    47 experiments  │  [Compare selected (2)]           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─ CV EVOLUTION CHART ──────────────────────────────────────────┐ │
│  │  (ECharts: scatter plot, X=round, Y=cv_mean, size=train_time) │ │
│  │  Color by model family (GBM=blue, RF=green, NN=purple, etc)   │ │
│  │  Hover: model ID, hyperparams summary, agent                  │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ TABLE ───────────────────────────────────────────────────────┐ │
│  │  ☐  #  Model     Agent    Type  Round  CV Mean  Std   Gap     │ │
│  │  ─────────────────────────────────────────────────────────────│ │
│  │  ☑  1  xgb-038   classic  GBM    2    0.8734  .012  .003  ⭐ │ │
│  │  ☑  2  rf-012    classic  RF     2    0.8710  .015  .005     │ │
│  │  ☐  3  tabnet-05 advanced TabNet 2    0.8690  .018  .008     │ │
│  │  ☐  4  lgbm-021  classic  GBM    1    0.8650  .014  .004     │ │
│  └───────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌─ COMPARE PANEL (when 2+ selected) ────────────────────────────┐ │
│  │                                                                │ │
│  │  METRICS           xgb-038        rf-012                       │ │
│  │  ─────────         ───────        ──────                       │ │
│  │  CV Mean           0.8734 ✓       0.8710                      │ │
│  │  CV Std            0.012          0.015 ✓                     │ │
│  │  Train/Val Gap     0.003 ✓        0.005                       │ │
│  │  Train Time        12.4s          3.2s ✓                      │ │
│  │  Inference/1k      0.8ms          1.2ms                       │ │
│  │                                                                │ │
│  │  TOP FEATURES      xgb-038        rf-012                       │ │
│  │  ─────────         ───────        ──────                       │ │
│  │  price_lag7     ▓▓▓▓▓▓ 0.23   ▓▓▓▓▓ 0.19                    │ │
│  │  rolling_30d    ▓▓▓▓▓ 0.18    ▓▓▓▓▓▓ 0.22                   │ │
│  │  category       ▓▓▓▓ 0.14     ▓▓▓ 0.11                      │ │
│  │                                                                │ │
│  │  HYPERPARAMS       xgb-038        rf-012                       │ │
│  │  ─────────         ───────        ──────                       │ │
│  │  n_estimators      500            1000                         │ │
│  │  max_depth         6              12                           │ │
│  │  learning_rate     0.05           —                            │ │
│  │                                                                │ │
│  │  [Promote xgb-038] [Export comparison] [Re-run with tweaks]   │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 Melhorias

| Antes | Depois |
|-------|--------|
| Tabela plana sem seleção | Checkbox para comparação — seleciona 2+ modelos |
| Line chart simples | Scatter plot (round × cv_mean), tamanho = train_time, cor = model family |
| Sem feature importance | Barras horizontais visuais no compare panel |
| Sem hyperparameters | Diff de hyperparams entre modelos selecionados |
| Sem ação | Promote — marca modelo como candidato a produção |

### 5.3 Estados

| Seção | Loading | Empty | Error | Normal |
|-------|---------|-------|-------|--------|
| Chart | ECharts loading skeleton | "No experiments yet" placeholder | Toast + retry | Scatter plot interativo |
| Table | Skeleton rows (8) | "No experiments match filters" | Toast + retry | Tabela sortable com checkboxes |
| Compare Panel | Hidden até selecionar 2+ | N/A | Toast inline no panel | Side-by-side metrics + features + params |

---

## 6. Tela 4: Agent Deep Dive (`/agents/:name`)

Mantida da Branch 6 com as seguintes melhorias:

- **Trace visual**: timeline vertical com steps do agente (substitui lista de logs plana)
- **Checklist persistido**: se o agente está em fase de spec (feat-eng), renderiza `<InteractiveChecklist>`
- **Diff do output**: quando o agente reescreve um spec, mostra antes/depois

---

## 7. Componentes Compartilhados (novos)

| Componente | Responsabilidade | Props principais |
|------------|-----------------|------------------|
| `<SpecDiffViewer>` | Mostra before/after de specs com highlight de mudanças | `before: string`, `after: string`, `format: 'unified' \| 'split'` |
| `<InteractiveChecklist>` | Checkbox list persistido via mutation | `runId: string`, `phase: string`, `items: ChecklistItem[]` |
| `<TraceTimeline>` | Timeline vertical com steps do agent, colapsável | `entries: TraceEntry[]`, `collapsed: boolean` |
| `<ComparePanel>` | Side-by-side de N modelos com métricas + features + params | `experiments: LeaderboardEntry[]` |
| `<ActionBar>` | Botões contextuais (Approve/Reject/Compare/Promote) | `actions: Action[]`, `onAction: (action) => void` |
| `<StatusBadge>` | Consistente em todas as telas | `status: ExperimentStatus`, `size: 'sm' \| 'md' \| 'lg'` |
| `<PipelineStepper>` | Stepper horizontal com fases e tempos | `phases: PhaseInfo[]`, `currentPhase: string` |
| `<Sparkline>` | Mini chart inline para best model card | `data: number[]`, `width: number`, `height: number` |

---

## 8. Novos Endpoints

### 8.1 Approval Flow

```
PATCH /api/specs/:specId/approve     → { approved: true, approvedBy, approvedAt }
PATCH /api/specs/:specId/reject       → { approved: false, reason?, rejectedBy }
```

### 8.2 Checklist

```
PUT  /api/checklist/:runId/:phase     → { items: [{id: string, checked: boolean}] }
GET  /api/checklist/:runId/:phase     → { items: ChecklistItem[] }
```

### 8.3 Experiment Actions

```
GET   /api/experiments/compare?ids=x,y,z  → { experiments: LeaderboardEntry[] }
POST  /api/experiments/:id/promote        → { promoted: true, experimentId, promotedAt }
POST  /api/experiments/:id/reject         → { rejected: true, reason? }
```

### 8.4 Trace

```
GET /api/trace/:agentName/:roundNumber  → { entries: TraceEntry[] }
```

---

## 9. Tipos TypeScript (extensões em `dashboard-types.ts`)

```typescript
// Checklist
interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  required: boolean;
}

interface ChecklistState {
  runId: string;
  phase: string;          // "feat-eng" | "modeler-classic" | "modeler-advanced"
  items: ChecklistItem[];
  updatedAt: string;
}

// Spec Diff
interface SpecDiff {
  before: string;
  after: string;
  changes: DiffHunk[];
}

interface DiffHunk {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number;
}

// Trace
interface TraceEntry {
  timestamp: string;
  event: string;
  detail?: string;
  level: "info" | "warn" | "error";
}

// Experiment Actions
type ExperimentAction = "promote" | "reject" | "compare" | "re-run";
type SpecAction = "approve" | "reject" | "edit";

// Pipeline Phase (extended)
interface PhaseInfo {
  id: string;
  label: string;
  status: "done" | "running" | "pending" | "failed";
  elapsedMs: number;
  estimatedMs: number;
}

// Decisions
interface PendingDecision {
  id: string;
  type: "spec_approval" | "model_rejected" | "model_promoted" | "overfitting_warning";
  title: string;
  description: string;
  actions: DecisionAction[];
  createdAt: string;
}

interface DecisionAction {
  label: string;
  id: string;
  primary: boolean;
}
```

---

## 10. Resumo: O Que Muda na Experiência do Cientista

| Antes | Depois |
|-------|--------|
| Kanban passivo, só observa | Kanban com approve/reject/edit inline |
| Leaderboard = tabela plana | Arena com comparação visual side-by-side |
| Overview sem ação | Command Center com "decisions pending" |
| Checklist inexistente | Checklist interativo persistido por fase |
| Trace escondido em logs | Timeline visual por card/step |
| Spec = texto estático | Spec diff com ação direta |

## 11. Ordem de Implementação Sugerida

1. **Tipos base** — estender `dashboard-types.ts` com os novos tipos
2. **Componentes compartilhados** — `<StatusBadge>`, `<ActionBar>`, `<TraceTimeline>`, `<SpecDiffViewer>`, `<InteractiveChecklist>`, `<ComparePanel>`, `<PipelineStepper>`, `<Sparkline>`
3. **Endpoints backend** — 8 novos endpoints REST em `dashboard.ts`
4. **Experiment Board** (`/kanban`) — maior impacto, introduz approval flow
5. **Model Arena** (`/leaderboard`) — comparação side-by-side
6. **Command Center** (`/`) — pipeline stepper + decisions pending
7. **Agent Deep Dive** (`/agents/:name`) — trace visual + checklist
8. **Testes** — unitários (componentes) + integração (API)
