# Formiga — Visão Geral da Arquitetura

Esse documento resume o conhecimento acumulado sobre a estrutura, fluxos e decisões do projeto **Formiga**.

---

## O que é

Formiga é uma plataforma de workflows com agentes de IA competitivos (
**competitive-agents**) orquestrados localmente.  O primeiro (e principal) workflow implementado é o **ml-pipeline**:

```
Data Analyst → Feature Engineer → (Modeler Classic ∥ Modeler Advanced) → ML Critic
```

Cada passo exige que o anterior entregue artefatos imutáveis (`features.parquet`, `split.pkl`, `baseline.json`) — um pipeline de dados determinístico no qual os modeladores competem para atingir o melhor `val_metric` e submeter no leaderboard.

---

## Entidades Principais

| Entidade | O que é | Persistência |
|----------|---------|-------------|
| **Run** | Uma execução inteira de workflow | SQLite (`runs`) |
| **Step** | Um passo do workflow (ex: `features`, `model-classic`) | SQLite (`steps`) |
| **Experiment** | Um modelo submetido ao leaderboard | SQLite (`experiments`) |
| **Leaderboard** | Tabela com todos os experimentos de um run | SQLite + REST API |
| **Workflow** | Especificação YAML com 5 agentes | Arquivo `workflow.yml` |

---

## Arquitetura em Camadas

```
┌─────────────────────────────────────┐
│  Dashboard (React SPA + REST API)     │
│  GET /api/leaderboard                 │
│  GET /api/leaderboard/agent-history   │
│  GET /api/leaderboard/current-best    │
├─────────────────────────────────────┤
│  Dashboard Server (Node.js)           │
│  – Serve HTML estático               │
│  – Mapeia rotas → handlers SQLite    │
│  – Backfill AutoResearch             │
├─────────────────────────────────────┤
│  SQLite (`~/.formiga/formiga.db`)     │
│  – `runs`, `steps`, `experiments`    │
│  – `dataset_signatures`               │
│  – `autoresearch_sessions`            │
├─────────────────────────────────────┤
│  Formiga CLI (`bin/formiga`)          │
│  – `workflow run`, `step claim`       │
│  – `get-ready` (daemon + dashboard)    │
├─────────────────────────────────────┤
│  Workflow Runner / Round Manager      │
│  – Resolve template variables          │
│  – Poluição de workspace (runs/{id})  │
│  – Ingestão de resultados no board    │
└─────────────────────────────────────┘
```

---

## Fluxo do ML Pipeline (rodando com CSV)

1. **Criação do run**
   * Usuário executa: `formiga workflow run ml-pipeline 'dataset_path=... target_column=price'`
   * O runner resolve `{{workspace}}` para `<cwd>/runs/<runId>/` (isolamento per-run)
   * Computa **dataset signature** (hash MD5 das colunas + bucket de linhas) e injeta no contexto

2. **EDA (`data-analyst`)**
   * Lê o CSV, gera relatório em `reports/01_eda.md`
   * Produz `artifacts/eda_config.json` com recomendações de pré-processamento

3. **Feature Engineering (`feature-engineer`)**
   * Lê EDA + CSV → produz:
     * `features.parquet` (matriz de features + coluna `__split`)
     * `split.pkl` (índices de treino/val/teste, `random_state=42`)
     * `baseline.json` + `baseline.pkl` (modelo baseline honesto)
   * Submete **baseline** ao leaderboard via sidecar JSON

4. **Modelagem paralela (`modelers`)**
   * **Modeler Classic** (gradient boosting, linear, trees, SVM/KNN, L1 stacking)
   * **Modeler Advanced** (MLP, TabNet, FT-Transformer, AutoML, stacking L2+)
   * Ambos leem `features.parquet` e **usam `split.pkl` sem recriá-lo**
   * Cada um treina várias famílias e submete o melhor experimento

5. **ML Critic (`ml-critic`)**
   * Agente **somente leitura** (Read, Bash, Glob, Grep — **sem Write**)
   * Baixa todos os experimentos do leaderboard via `GET /api/leaderboard?runId=...`
   * Executa **8 checks de audit**:
     1. Schema válido (todos os campos obrigatórios)
     2. Estratégia de validação confere com `split.pkl`
     3. Ganho sobre baseline é razoável (detecta leakage)
     4. Estabilidade do CV (cv_std / cv_mean)
     5. Gap treino/validação (overfitting)
     6. Integridade do split (índices corretos)
     7. Leakage check (importância de features, metadados)
     8. Tempo de treino plausível
   * Escreve rejeições como `[AUDIT REJECTED] model_id=...`
   * Status pode mudar: `PENDING` → `AUDITED` ou `OVERFITTED`

---

## Template Variables e Passagem de Contexto

O workflow usa **template substitution** (`{{key}}`) na criação do run:

| Variável | Origem |
|----------|--------|
| `{{dataset_path}}`, `{{target_column}}` | Extraídas da string do task via `extractContextKvFromTaskString` |
| `{{workspace}}` | Resolvido para `<cwd>/runs/<runId>/` (especialmente para `ml-pipeline`) |
| `{{run_id}}` | UUID gerado pelo runner |
| `{{dataset_signature}}` | Computado automaticamente no `run.ts` a partir do CSV |
| `{{report_path}}`, `{{baseline_json_path}}` | Resolvido do output do passo anterior |

Isso permite que o YAML seja declarativo sem hard-codar caminhos.

---

## Sidecar JSON — Fonte da Verdade

O `report` tool do harness (`pi`) **normaliza o stdout** e pode descartar linhas personalizadas.  Por isso, os modelos **devem** escrever um sidecar JSON antes de emitir `STATUS: done`:

```
artifacts/{agent}_submission.json      # ex: modeler-classic_submission.json
```

**Formato** (case-insensitive, mas `MODEL_TYPE` em maiúsculo no JSON do sidecar):
```json
{
  "MODEL_TYPE": "lightgbm",
  "CV_MEAN": 0.6812,
  "TRAIN_MEAN": 0.6403,
  "HYPERPARAMETERS": {"n_estimators": 500, "learning_rate": 0.05},
  "ARTIFACT_PATH": "artifacts/lgbm-trial-22.pkl",
  "METRIC_NAME": "rmse"
}
```

O scanner de output (`ingest.ts`) lê esse JSON para inserir no `experiments` — sem ele, o experimento **não registra** no leaderboard.

---

## Lifecycle do Experimento

```
PENDING → SUCCESS → AUDITED            (modelo bom)
  └→ FAILED / OVERFITTED               (critic rejeitou)
```

- `PENDING` → inserido pelo `register()`
- `SUCCESS` → quando o modeler conclui sem erro
- `AUDITED` → critic aprovou (ou auto-audit passou)
- `FAILED` → critic rejeitou (escreve `reject_reason`)
- `OVERFITTED` → holdout test mostra overfitting

A query `getBestByMetric()` filtra `"status IN ('SUCCESS','AUDITED')"` e ordena por `val_metric DESC`.

---

## Cross-Pollinação entre Modeladores

A única comunicação intencional entre os dois modelers é via **`reports/cross_findings.md`** (arquivo markdown compartilhado, append-only):

- Cada modeler LÊ o arquivo se existir
- Cada modeler ADICIONA suas descobertas ao final
- Cada modeler EVITA reinventar o que o outro já descobriu

**Limitação**: o formato é livre (markdown), sem schema ou validação.  É possível que modelers ignorem o arquivo.

---

## Melhorias Implementadas Recentemente

### 1. Active Failure Avoidance
- Novas queries `getFailedConfigsForAgent()` e `getSucceededConfigsForAgent()` — buscam configs falhas/sucedidas **em todos os runs**
- Endpoint `GET /api/leaderboard/agent-history?agent=<name>`
- Prompts de modelers: "não repita hyperparameters que já falharam"

### 2. Dataset Signature para Transfer Learning entre Runs
- Tabela `dataset_signatures` + coluna `dataset_signature` em `experiments`
- `computeDatasetSignature()` — hash MD5 das colunas (ordenadas) + bucket de linhas (`<1K`, `1K-10K`, ...)
- Injeta `dataset_signature` no contexto do run automaticamente
- Modelers podem buscar: "melhores experimentos para datasets similares"

### 3. Auto-Critique / Early Stopping
- `getCurrentBestForRun()` — retorna o melhor experimento do run atual
- Endpoint `GET /api/leaderboard/current-best?runId=<id>`
- Prompts: parar se a melhor modelo do agente estiver >10% (classic) ou >5% (advanced) abaixo do líder

---

## Padrões Arquiteturais

| Padrão | Aplicação |
|--------|-----------|
| **Repository Pattern** | `LeaderboardRepositoryImpl` isola o SQLite da lógica de negócio |
| **Interface Segregation (ISP)** | `LeaderboardReadonly` separado de `LeaderboardRepository` |
| **Additive Migration** | `initLeaderboardSchema` usa `PRAGMA table_info()` para não duplicar colunas |
| **Sidecar JSON** | Arquivo separado do stdout para garantir que dados não são normalizados pelo harness |
| **Template Substitution** | Chaves `{{...}}` resolvidas no YAML do workflow para passar caminhos entre passos |
| **Determinism** | `random_state=42` obrigatório em todos os agentes; `split.pkl` imutável |
| **Read-Only Audit** | ML Critic tem apenas ferramentas de leitura, evitando mutação acidental |

---

## Limitações Conhecidas

| Limitação | Impacto |
|-----------|---------|
| `cross_findings.md` é desestruturado | Modelers podem ignorar ou mal interpretar |
| `AgentContext.previousResults` não é populado | Mecanismo existe no TS, mas não é usado no workflow YAML |
| Não há early stopping automático na orquestração | Modelers rodam até o timeout ou concluem pela própria lógica |
| 174 testes falham pré-existentemente | Não são causados pelas melhorias, mas sinalizam débito técnico |
| O harness (`pi`) normaliza o stdout | Explica a necessidade do sidecar JSON |

---

## Decisões Técnicas que Sustentam o Sistema

1. **Dataset signature é computada no runner, não nos agentes** — garante determinismo e que todos os agentes usam a mesma signature
2. **Workspace é isolado em `runs/<runId>/`** — evita poluição do diretório raiz do projeto e permite auditoria posterior
3. **Baseline é definido pelo Feature Engineer, não pelos modelers** — garante um piso honesto e comparável entre runs
4. **Critic é read-only** — qualquer aprovação ou rejeição é auditável e reversível
5. **Leaderboard usa `val_metric` como score primário** — critic pode depois avaliar com teste, mas a classificação é por validação
6. **Schema é additive** — novas colunas (ex: `dataset_signature`) podem ser adicionadas sem destruir bancos antigos

---

## Como Documentar Novas Melhorias

Ao implementar novas funcionalidades, preferir:

1. **Additive schema** (`ALTER TABLE ADD COLUMN`) ao invés de recriar tabelas
2. **Novas queries em `queries.ts`** ao invés de escrever SQL inline no dashboard
3. **Novos endpoints em `dashboard.ts`** seguindo o padrão dos existentes
4. **Atualizar o `AGENTS.md`** com instruções claras do que o agente deve/consulta
5. **Incluir o novo campo no `mapExperimentRow()`** se for exposto via API
6. **Adicionar à constante `EXPERIMENTS_DDL`** se for coluna nova (com fallback de migration)
