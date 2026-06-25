# Especificacao Tecnica: Formiga — Autoresearch Team Pipeline

**Projeto:** Formiga (anteriormente Tamandua)
**Stack:** TypeScript, Node.js, SQLite (WAL mode)
**Foco:** Data Science autonoma, ML competitivo, execucao paralela de agentes
**Arquitetura:** Event-driven, Daemon-based, Fan-Out/Fan-In (MapReduce)

---

## 1. Visao Geral

O **Formiga** e um framework autonomo de orquestracao de agentes de Data Science. Executa o pipeline completo de Machine Learning (EDA, Feature Engineering, Modelagem Paralela Competitiva e Auditoria Cega) isolando contextos em runtimes efemeros e centralizando estado em SQLite.

### 1.1. Problema que Resolve

- **Context window bloat**: agentes LLM perdem qualidade com contexto longo
- **Estagnacao de agente unico**: um so agente fica preso em minimos locais
- **Overfitting induzido por LLM**: sem auditoria cega, metricas sao infladas

### 1.2. Diagrama de Arquitetura

```text
                  [ Dataset Bruto + Objetivo ]
                               |
                               v
                      +----------------+
                      | Data Analyst   | (EDA rigorosa)
                      +-------+--------+
                              |
                              | reports/01_eda.md
                              v
                    +--------------------+
                    | Feature Engineer   | (Features + Split + Baseline)
                    +---------+----------+
                              |
                              | artifacts/features.parquet + split.pkl
                              |
           +------------------+------------------+
           v (Fan-Out: paralelo)                 v
  +------------------+                  +-------------------+
  | Modeler Classic  |  <-- cross -->   | Modeler Advanced  |
  | (GBM, Linear,   |   pollination    | (NN, AutoML,      |
  |  RF, SVM)       |                  |  Stacking multi)  |
  +--------+---------+                  +--------+----------+
           |                                     |
           +------------------+------------------+
                              |
                              | results/*.json + artifacts/models/
                              v
                 +---------------------------+
                 | SQLite: LEADERBOARD       |
                 +-------------+-------------+
                               |
                               v (Fan-In: auditoria)
                      +----------------+
                      | ML Critic      | (Auditor adversarial)
                      +----------------+
                               |
                               v
                      reports/05_audit.md
                      (modelos validados / rejeitados)
```

---

## 2. Principios de Engenharia

### 2.1. SOLID

| Principio | Aplicacao no Formiga |
|-----------|---------------------|
| **S** - Single Responsibility | Cada agente tem exatamente uma responsabilidade. `DataExplorer` nao faz feature engineering. `MetricVerifier` nao treina modelos. |
| **O** - Open/Closed | Novos agentes especialistas sao adicionados sem modificar o orquestrador. O sistema de personas e extensivel via configuracao. |
| **L** - Liskov Substitution | Todo agente implementa a interface `AgentRunner`. Qualquer implementacao pode substituir outra sem quebrar o pipeline. |
| **I** - Interface Segregation | Agentes de modelagem nao tem acesso ao holdout. O `MetricVerifier` nao tem acesso a hiperparametros de otimizacao. |
| **D** - Dependency Inversion | O orquestrador depende de abstraccoes (`AgentRunner`, `LeaderboardRepository`, `ArtifactStore`), nunca de implementacoes concretas. |

### 2.2. Clean Code

- **Nomes expressivos**: funcoes descrevem o que fazem (`calculateValidationMetric`, nao `calc`)
- **Funcoes pequenas**: max 20-30 linhas; se maior, extrair subfuncao
- **Sem side-effects ocultos**: funcoes puras quando possivel; side-effects explicitos via injecao
- **Fail fast**: validacao na entrada, erros claros com contexto
- **Sem magic numbers**: constantes nomeadas para thresholds, timeouts, limites

### 2.3. DRY (Don't Repeat Yourself)

- **Repositorios compartilhados**: acesso ao SQLite via `LeaderboardRepository` unico
- **Prompts parametrizados**: template base + interpolacao de persona (nao copiar prompts inteiros)
- **Utilitarios centralizados**: seed initialization, artifact I/O, metric calculation
- **Configuracao externalizada**: thresholds e politicas em arquivo de config, nao hardcoded

---

## 3. Arquitetura de Modulos

### 3.1. Estrutura de Diretorios

```
src/
  autoresearch/
    engine.ts              # Orquestrador principal do pipeline
    types.ts               # Interfaces e tipos compartilhados
    config.ts              # Configuracao externalizada (FormigaConfig)
  agents/
    interfaces.ts          # Interface AgentRunner (contrato base)
    data-analyst.ts        # Agente EDA (reports/01_eda.md)
    feature-engineer.ts    # Features + Split + Baseline
    modeler-classic.ts     # GBM, Lineares, RF, SVM, Stacking L1
    modeler-advanced.ts    # NNs, AutoML, Stacking multi-nivel
    ml-critic.ts           # Auditor adversarial (read-only)
  leaderboard/
    repository.ts          # Abstraction over SQLite (Repository Pattern)
    schema.ts              # DDL e migrations
    queries.ts             # Queries nomeadas e tipadas
  artifacts/
    store.ts               # Interface ArtifactStore
    local-store.ts         # Implementacao: filesystem local
  orchestrator/
    fan-out.ts             # Dispatch paralelo de agentes
    fan-in.ts              # Coleta e ranking de resultados
    round-manager.ts       # Gerencia rounds de otimizacao
    communication.ts       # Protocolo de mensagens inter-agente
  shared/
    seed.ts                # Inicializacao deterministica
    metrics.ts             # Calculo padronizado de metricas
    validation.ts          # Guards e validadores
    schemas.ts             # JSON schemas para results/*.json
tests/
  unit/                    # Testes unitarios (mocks, rapidos)
  integration/             # Testes com SQLite real
  e2e/                     # Pipeline completo em dados sinteticos
```

### 3.2. Workspace do Pipeline (diretorios de runtime)

```
workspace/
  data/                    # Dataset bruto (READ-ONLY para todos)
  artifacts/
    config.json            # Configuracao do problema (task_type, target, metrica)
    features.parquet       # Dataset processado (imutavel apos feature-engineer)
    split.pkl              # CV splits (imutavel, unico dono: feature-engineer)
    scaler.pkl             # Scaler se aplicado
    encoders/              # Encoders serializados
    models/                # Modelos treinados: {model_id}.{pkl,pt,zip}
  results/
    baseline.json          # Baseline do feature-engineer
    classic_*.json         # JSONs do modeler-classic
    advanced_*.json        # JSONs do modeler-advanced
  reports/
    01_eda.md              # Data Analyst
    02_features.md         # Feature Engineer
    03_models_classic.md   # Modeler Classic
    04_models_advanced.md  # Modeler Advanced
    05_audit.md            # ML Critic
    cross_findings.md      # Cross-pollination entre modeladores
    figures/               # PNGs referenciados nos reports
  holdout/                 # ACESSO RESTRITO: apenas ml-critic
    dataset_holdout.csv
```

### 3.2. Interfaces Fundamentais

```typescript
// src/agents/interfaces.ts

export interface AgentRunner {
  readonly name: string;
  readonly persona: string;
  readonly tools: readonly string[];       // tools disponiveis (ISP)
  execute(context: AgentContext): Promise<AgentResult>;
  plan?(context: AgentContext): Promise<AgentPlan>;  // plan mode (modeladores)
}

export interface AgentContext {
  runId: string;
  roundNumber: number;
  datasetPath: string;           // path para features.parquet (pos feature-engineer)
  metricName: string;
  configPath: string;            // artifacts/config.json
  splitPath: string;             // artifacts/split.pkl (imutavel)
  leaderboard: LeaderboardReadonly;  // ISP: apenas leitura
  messenger: AgentMessenger;     // comunicacao inter-agente
}

export interface AgentResult {
  status: 'SUCCESS' | 'FAILED';
  modelId: string;               // identificador unico do modelo
  modelType: string;
  hyperparameters: Record<string, unknown>;
  cvMean: number;
  cvStd: number;
  cvScores: number[];
  trainMean: number;
  trainValGap: number;
  artifactPath: string;
  secondaryMetrics?: Record<string, number>;
  trainTimeSeconds?: number;
  inferenceTimeMsPer1k?: number;
  featureImportancesTop10?: [string, number][];
  errorMessage?: string;
}

export interface AgentPlan {
  families: string[];            // familias/abordagens a testar
  searchSpaces: Record<string, unknown>;
  trialsPerFamily: number;
  overfitMitigation: string;
  justification: string;
}

export interface AgentMessenger {
  send(to: string, message: string): void;
  receive(): string[];
  broadcast(message: string): void;
}

// src/leaderboard/repository.ts

export interface LeaderboardReadonly {
  getBestByMetric(runId: string, limit?: number): Promise<ExperimentRow[]>;
  getByRound(runId: string, round: number): Promise<ExperimentRow[]>;
  getFailedConfigs(agentName: string): Promise<ExperimentRow[]>;
  getByAgent(agentName: string, runId: string): Promise<ExperimentRow[]>;
  getValidated(runId: string): Promise<ExperimentRow[]>;
}

export interface LeaderboardRepository extends LeaderboardReadonly {
  register(entry: NewExperiment): Promise<number>;
  updateTestMetric(experimentId: number, metric: number, status: string): Promise<void>;
  reject(experimentId: number, reason: string): Promise<void>;
}
```

---

## 4. Banco de Dados: Leaderboard (SQLite WAL)

### 4.1. Configuracao Obrigatoria de Conexao

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

### 4.2. Schema

```sql
CREATE TABLE IF NOT EXISTS experiments (
    experiment_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    round_number INTEGER NOT NULL,
    agent_name TEXT NOT NULL,
    model_type TEXT NOT NULL,
    hyperparameters TEXT NOT NULL,          -- JSON
    train_metric REAL NOT NULL,
    val_metric REAL NOT NULL,
    test_metric REAL,                       -- NULL ate auditoria
    metric_name TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    code_snippet_path TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING'
      CHECK(status IN ('PENDING','SUCCESS','FAILED','AUDITED','OVERFITTED')),
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiments_run_round
  ON experiments(run_id, round_number);
CREATE INDEX IF NOT EXISTS idx_experiments_val_metric
  ON experiments(val_metric DESC);
CREATE INDEX IF NOT EXISTS idx_experiments_status
  ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_experiments_agent
  ON experiments(agent_name, run_id);
```

### 4.3. Schema JSON dos Resultados (contrato entre agentes)

Cada `results/{prefix}_{model_id}.json` DEVE seguir este schema:

```json
{
  "model_id": "lgbm_v1",
  "agent": "modeler-classic",
  "model_type": "LightGBM",
  "iteration": 1,
  "hyperparameters": { "max_depth": 6, "learning_rate": 0.05, "...": "..." },
  "primary_metric": "f1_score",
  "cv_mean": 0.847,
  "cv_std": 0.012,
  "cv_scores": [0.841, 0.852, 0.839, 0.856, 0.847],
  "train_mean": 0.891,
  "train_val_gap": 0.044,
  "secondary_metrics": { "roc_auc": 0.912, "precision": 0.83, "recall": 0.86 },
  "validation_strategy": "stratified_5fold_seed42",
  "train_time_seconds": 45.2,
  "inference_time_ms_per_1k": 12.3,
  "artifact_path": "artifacts/models/lgbm_v1.pkl",
  "feature_importances_top10": [["feat_a", 0.15], ["feat_b", 0.12]],
  "notes": "..."
}
```

O `ml-critic` valida este schema antes de qualquer outra auditoria.

---

## 5. Agentes: Contratos, Prompts e Quality Bars

### 5.0. Principios Gerais de Design de Agentes

- **Frontmatter declarativo**: cada agente declara nome, tools, model
- **Output estruturado**: secoes fixas numeradas (contrato rigido)
- **Quality bar**: criterios mensuráveis que o output DEVE atender
- **Anti-padroes**: lista explicita do que o agente NAO deve fazer
- **Comunicacao**: protocolo de mensagens entre agentes
- **Plan mode**: modeladores devem submeter plano antes de treinar

---

### 5.1. Data Analyst (EDA)

```yaml
name: data-analyst
tools: Read, Write, Bash, Glob, Grep
model: sonnet
```

**Responsabilidade unica**: gerar EDA rigorosa e estruturada como input para o Feature Engineer.

| Campo | Valor |
|-------|-------|
| Input | Dataset bruto (CSV/parquet), `artifacts/config.json` (opcional), meta-objetivo |
| Output | `reports/01_eda.md`, figuras em `reports/figures/` |
| Constraint | Read-only sobre `data/` — nao modifica o dataset |
| Seed | N/A (nao treina nada) |

**System Prompt**:
```
Voce e um analista de dados senior. Sua unica responsabilidade e gerar uma
EDA rigorosa e estruturada que sirva de input deterministico para o
feature-engineer.

Pipeline:
1. Carregue o dataset. Reporte shape, dtypes, memoria.
2. Qualidade: missing %, duplicatas, constantes, alta cardinalidade,
   tipos suspeitos (strings que parecem datas/numeros, IDs vazando).
3. Univariada: estatisticas + distribuicoes. Gere histogramas em
   reports/figures/ (seaborn, PNG).
4. Target: distribuicao (balance se classificacao, skew se regressao).
5. Bivariada vs target: correlacoes (Pearson/Spearman/MI), boxplots
   top-10, target rate por categoria.
6. Deteccao de leakage potencial: features com correlacao suspeitamente
   alta, timestamps pos-evento, IDs codificados. Sinalize EXPLICITAMENTE.
7. Drift entre splits se houver splits pre-definidos.
8. Dimensao temporal: detecte colunas datetime, recomende TimeSeriesSplit.
```

**Output (contrato rigido)** — `reports/01_eda.md`:

```markdown
# EDA — {dataset_name}

## 1. Dataset Overview
## 2. Qualidade dos Dados
## 3. Analise Univariada
## 4. Target
## 5. Analise Bivariada vs Target
## 6. Alertas de Leakage
## 7. Drift / Dimensao Temporal
## 8. Hipoteses para Feature Engineering (min 5, acionaveis)
## 9. Recomendacoes de Pre-processamento
## 10. Proposta de config.json (JSON valido)
```

**Quality Bar**:
- Nenhuma secao vazia (se N/A, justifique)
- Toda afirmacao numerica deve ter o numero (nao "tem alguns missings", mas "23% missing em col X")
- Toda figura referenciada deve existir em `reports/figures/`
- Secao 8: minimo 5 hipoteses especificas ao dataset (nao receita generica)
- Secao 10: JSON valido (validavel via `json.loads()`)

**Anti-padroes**:
- NAO treine modelos — EDA only
- NAO modifique `data/` (read-only)
- NAO escreva em `artifacts/` (responsabilidade do feature-engineer)
- NAO use prints decorativos — o markdown e o entregavel

---

### 5.2. Feature Engineer

```yaml
name: feature-engineer
tools: Read, Write, Bash, Glob, Grep
model: sonnet
```

**Responsabilidade unica**: transformar hipoteses do EDA em dataset processado imutavel + split de validacao + baseline.

| Campo | Valor |
|-------|-------|
| Input | `reports/01_eda.md` (obrigatorio), `data/` (read-only), `artifacts/config.json` |
| Output | `artifacts/features.parquet`, `artifacts/split.pkl`, `results/baseline.json`, `reports/02_features.md` |
| Constraint | Zero data leakage — parametros APENAS no treino |
| Seed | `random_state=42` sempre |

**System Prompt**:
```
Voce e um engenheiro de features senior. Transforma hipoteses do EDA em
dataset processado IMUTAVEL que os modeladores vao consumir.

Pipeline:
1. Leia o EDA completamente. Cite hipoteses implementadas e descartadas.
2. Imputacao: estrategia por coluna (mediana/moda/constante/modelo-based).
3. Encoding:
   - Categoricas baixa cardinalidade (<10): one-hot
   - Alta cardinalidade: target encoding com K-fold (evitar leakage)
   - Ordinais: mapping explicito
4. Numericas: log/Box-Cox em skewed, clipping em outliers (>3sigma ou IQR).
5. Feature engineering criativa: implementar TODAS as hipoteses viaveis
   da secao 8 do EDA.
6. Scaling: StandardScaler apenas se modelo linear/NN sera treinado.
   Salve scaler como artifact.
7. CV split: gere artifacts/split.pkl:
   - StratifiedKFold / KFold / TimeSeriesSplit conforme EDA secao 7
   - random_state=42 SEMPRE
   - Voce e o UNICO que cria o split — modeladores USAM, nao recriam.
8. Salve artifacts/features.parquet (features + target + id se houver).
9. Baseline obrigatoria: Logistic/Ridge sem regularizacao agressiva,
   com split.pkl. Salve results/baseline.json no schema do leaderboard.
```

**Output (contrato rigido)** — `reports/02_features.md`:

```markdown
# Feature Engineering

## 1. Hipoteses do EDA implementadas
{tabela: hipotese | implementada S/N | justificativa se N}

## 2. Imputacao
{tabela por coluna ou grupo}

## 3. Encoding
{tabela por coluna, com nota de leakage-safety}

## 4. Features criadas
{lista numerada: nome, formula, motivacao}

## 5. Pre-processamento numerico
{transformacoes aplicadas}

## 6. Estrategia de validacao
{tipo de splitter, n_splits, seed, justificativa}

## 7. Baseline
{model_id, metricas, gap train/val}

## 8. Artifacts gerados
- artifacts/features.parquet (shape: ...)
- artifacts/split.pkl
- artifacts/scaler.pkl (se aplicado)
- results/baseline.json

## 9. Notas para modeladores
{features que podem ser dropadas em lineares vs trees,
tratamento especial necessario, etc.}
```

**Quality Bar**:
- `features.parquet` carrega sem erro com `pd.read_parquet`
- `split.pkl` tem exatamente n_splits indicados, sem overlap, cobertura completa
- Baseline em `results/baseline.json` com schema valido
- Nenhuma feature usa target diretamente ou info do futuro
- Re-execucao produz output bit-identico (determinismo)

**Anti-padroes**:
- NAO recrie o split nos modeladores — voce e o unico que cria
- NAO use `train_test_split` simples se EDA detectou dimensao temporal
- NAO treine modelos alem da baseline
- NAO escreva em reports/03+ (territorio dos modeladores)

---

### 5.3. Modeler Classic (ML Tabular Classico)

```yaml
name: modeler-classic
tools: Read, Write, Bash, Glob, Grep
model: sonnet
```

**Dominio exclusivo**: Gradient Boosting (XGBoost, LightGBM, CatBoost), Lineares (Ridge/Lasso/ElasticNet/Logistic), Tree-based (RF, ExtraTrees), SVM, KNN, Stacking desses.

**NAO toca em**: redes neurais, AutoML, TabNet — territorio do modeler-advanced.

| Campo | Valor |
|-------|-------|
| Input | `artifacts/features.parquet`, `artifacts/split.pkl`, `artifacts/config.json`, `results/baseline.json`, `reports/02_features.md` |
| Output | `artifacts/models/{model_id}.pkl`, `results/classic_{model_id}.json`, `reports/03_models_classic.md` |
| Min familias | 4 distintas |
| Min trials | >= 50 (Optuna) ou >= 100 (RandomSearch) por familia |
| Seed | `random_state=42` |

**System Prompt**:
```
Voce e especialista em ML tabular classico: GBM, lineares, trees, SVM.

PLAN MODE OBRIGATORIO no primeiro turno:
Antes de treinar, submeta plano com:
1. As 4+ familias que vai testar e justificativa para este dataset.
2. Espaco de hiperparametros por familia (bounds e tipos).
3. Quantos trials por familia.
4. Como vai mitigar overfitting / leakage.
5. Como vai medir o gap train/val.

Pipeline:
1. Carregue features + split.pkl (USE ESTE, nao recrie).
2. Para cada familia (min 4):
   - Modelo base com hiperparametros sensatos
   - Tuning com Optuna (>=50 trials) usando split.pkl para CV interna
   - Salve melhor modelo em artifacts/models/{model_id}.pkl
3. Stacking ao final: combine top-3 modelos como nivel 1 com
   Logistic/Ridge como meta-learner (OOF para meta-features).
4. Para cada modelo calcule:
   - Metrica primaria: mean +/- std nos folds
   - Metricas secundarias
   - Tempo treino, tempo inferencia por 1k samples
   - Gap train/val (overfit indicator)
   - Se cv_mean > baseline + 10%: audite pipeline antes de aceitar
5. Escreva um JSON por modelo em results/classic_{model_id}.json
```

**Output (contrato rigido)** — `reports/03_models_classic.md`:

```markdown
# Modeladores Classicos — Resultados

## 1. Familias testadas
{tabela: familia | n_trials | melhor cv_mean | tempo total}

## 2. Top-3 modelos individuais
{hiperparametros, importancias top-10, curvas de aprendizado}

## 3. Stacking
{composicao, ganho sobre melhor base, meta-learner config}

## 4. Analise de overfitting
{gap train/val por modelo, sinais de leakage investigados}

## 5. Trade-offs
{tabela: model_id | metrica | tempo treino | tempo infer | tamanho artifact}

## 6. JSONs gerados
{lista de results/classic_*.json}
```

**Anti-padroes**:
- NAO recrie split (USE artifacts/split.pkl)
- NAO treine neural nets ou AutoML
- NAO sobrescreva JSONs do modeler-advanced
- NAO reporte media sem desvio padrao dos folds
- NAO aceite modelo sem checar gap train/val
- NAO compare modelos com estrategia de CV diferente

---

### 5.4. Modeler Advanced (ML Tabular Avancado)

```yaml
name: modeler-advanced
tools: Read, Write, Bash, Glob, Grep
model: sonnet
```

**Dominio exclusivo**: Redes neurais tabulares (MLP, TabNet, FT-Transformer, NODE), AutoML (FLAML, AutoGluon), Stacking multi-nivel, Pseudo-labeling, Entity embeddings.

**NAO replica** trabalho do modeler-classic. Se usar GBM no stacking, usa artifacts dele.

| Campo | Valor |
|-------|-------|
| Input | `artifacts/features.parquet`, `artifacts/split.pkl`, `artifacts/config.json`, `results/baseline.json`, `results/classic_*.json` |
| Output | `artifacts/models/{model_id}.{pkl,pt,zip}`, `results/advanced_{model_id}.json`, `reports/04_models_advanced.md` |
| Min abordagens | 3 distintas |
| Min trials NN | >= 30 (Optuna) |
| Seed | `random_state=42` + `torch.manual_seed(42)` |

**System Prompt**:
```
Voce e especialista em ML tabular avancado: NNs, AutoML, stacking avancado.

PLAN MODE OBRIGATORIO no primeiro turno:
Submeta plano com:
1. As 3+ abordagens e por que se encaixam (tamanho, dimensionalidade).
2. Time budget e search space por abordagem.
3. Como vai prevenir overfitting (NNs em tabular sao propensos).
4. Como vai medir gap train/val.
5. Como vai usar ou nao artifacts do modeler-classic.

Pipeline:
1. Carregue features + split + config.
2. Escolha minimo 3 abordagens:
   - MLP com tuning (layers, hidden_dim, dropout, lr) via Optuna >=30
   - TabNet ou FT-Transformer com tuning
   - AutoML (FLAML ou AutoGluon) com time budget 10-20min
   - Stacking multi-nivel: use top modelos de classic como nivel 1
   - Entity embeddings para categoricas
3. Para NNs:
   - CUDA se disponivel
   - EarlyStopping com patience adequada
   - LR scheduling (cosine ou plateau)
   - Mixed precision se GPU compativel
4. Para cada modelo: metricas via split.pkl, JSON em
   results/advanced_{model_id}.json
5. Serialize em artifacts/models/{model_id}.{pkl,pt,zip}
```

**Output (contrato rigido)** — `reports/04_models_advanced.md`:

```markdown
# Modeladores Avancados — Resultados

## 1. Abordagens testadas
{tabela: abordagem | framework | tempo total | melhor cv_mean}

## 2. Detalhes por abordagem
{arquitetura, curvas de loss, hiperparametros finais}

## 3. Stacking avancado (se feito)
{composicao com artifacts de classic + seus + meta-learner}

## 4. Analise de overfitting
{NNs tabulares tendem a overfitar — mostre mitigacao}

## 5. Trade-offs vs classic
{quando vale vs GBM? latencia? interpretabilidade?}

## 6. JSONs gerados
{lista de results/advanced_*.json}
```

**Anti-padroes**:
- NAO recrie split
- NAO retreine XGBoost/LGBM (trabalho do classic)
- NAO use NN sem early stopping em tabular
- NAO reporte single-fold metric
- NAO faca stacking que vaza target via OOF mal feito
- NAO aceite gap train/val > 10% sem investigacao

---

### 5.5. ML Critic (Auditor Adversarial)

```yaml
name: ml-critic
tools: Read, Bash, Glob, Grep
model: sonnet
```

**Responsabilidade unica**: proteger a integridade do leaderboard. Nao treina — audita e REJEITA.

**Premissas operacionais** (cetico por padrao):
- Modelos bons demais geralmente tem leakage
- CV std baixo demais em dataset pequeno = suspeito
- Gap train/val < 1% em modelo complexo = leakage ate prova em contrario
- Ganho > 5% sobre baseline no primeiro tento = exige investigacao

| Campo | Valor |
|-------|-------|
| Input | `results/classic_*.json`, `results/advanced_*.json`, `results/baseline.json`, `artifacts/features.parquet`, `artifacts/split.pkl`, `artifacts/models/` |
| Output | `reports/05_audit.md`, mensagens de rejeicao aos modeladores |
| Acesso holdout | SIM (unico agente com acesso) |

**Checklist de Auditoria (por modelo)**:

| # | Check | Criterio de Rejeicao |
|---|-------|---------------------|
| 1 | Schema valido | Campos obrigatorios ausentes ou mal-tipados |
| 2 | Validation strategy | Nao bate com split.pkl (n_splits, tipo) |
| 3 | Ganho razoavel | < baseline+1%: REJEITAR (nao supera). > baseline+15%: SUSPEITO ALTO |
| 4 | CV stability | `cv_std / cv_mean > 0.2` = instabilidade: REJEITAR |
| 5 | Train/val gap | Gap < baseline em modelo complexo: suspeito. Gap > 10%: REJEITAR |
| 6 | Split integrity | Modelador inventou proprio split: REJEITAR imediatamente |
| 7 | Leakage check | Re-rodar predicoes, conferir metricas, inspecionar top features |
| 8 | Tempo plausivel | Tempo de treino implausivel dado modelo/tamanho: investigar |

**Thresholds de decisao**:

| Ganho sobre baseline | Acao |
|---------------------|------|
| < +1% | REJEITAR — nao supera baseline |
| +1% a +5% | VALIDAR — marca como "validated" |
| +5% a +15% | INVESTIGAR — pedir evidencia de nao-leakage |
| > +15% | SUSPEITO ALTO — quase certo leakage |

**Protocolo de rejeicao** (mensagem direta ao modelador):
```
[AUDIT REJEITADO] model_id={id}
Motivo: {curto e especifico}
Evidencia: {numero, comparacao}
Acao requerida: {o que precisa mudar para re-auditoria}
```

**Output (contrato rigido)** — `reports/05_audit.md`:

```markdown
# Auditoria do Leaderboard

## Resumo
- Total submetidos: N
- Validados: M
- Rejeitados: K
- Em revisao: L

## Modelos validados
{tabela: model_id | agent | cv_mean | cv_std | gap | nota}

## Modelos rejeitados
{tabela: model_id | agent | cv_mean | motivo | timestamp}

## Padroes sistemicos
{ex: "modeler-classic usou target encoding sem K-fold em 2 modelos"}

## Recomendacao final
{quais modelos entram no leaderboard, em que ordem, com ressalvas}
```

**Anti-padroes**:
- NAO escreva no leaderboard final — voce e gatekeeper, nao compositor
- NAO retreine modelos para auditar — use artifacts existentes
- NAO aceite "esta bom assim" — voce e o filtro adversarial
- NAO modifique JSONs dos outros agentes
- NAO tem tool Write (proposital — apenas le e reporta)

---

### 5.6. Protocolo de Comunicacao Inter-Agente

#### Fluxo Sequencial (dependencias)

```
data-analyst ──► feature-engineer ──► [modeler-classic | modeler-advanced] ──► ml-critic
                                              (paralelos)
```

#### Cross-Pollination (entre modeladores)

Os modeladores classic e advanced rodam em paralelo e DEVEM comunicar findings bidirecionalmente:

**Quando enviar mensagem ao outro modelador**:
- Descobriu feature interaction com importancia > 5%
- Identificou padrao de overfitting especifico a um fold
- Encontrou instabilidade no split
- Evidencia de leakage durante experimentacao

**Formato de registro** — `reports/cross_findings.md`:
```markdown
### {timestamp} — {de_quem} -> {para_quem}
{conteudo do finding}
Acao: {incorporado / descartado, justificativa}
```

#### Mensagens de Status ao Orquestrador

Cada agente ao terminar envia:
```
{agente} concluido. Path: {report_path}
Metricas chave: {...}
Alertas criticos: {...}
Proximo passo sugerido: {...}
```

#### Iteracao por Feedback

Modeladores suportam ate **3 iteracoes** de refinamento:
- Se feedback recebido (do critic ou do outro modelador): implementar e iterar
- Cada iteracao: incrementar version no model_id (`_v1`, `_v2`, `_v3`)
- Apos 3 iteracoes: resultado final, sem mais revisoes

---

## 6. Execucao Paralela (Fan-Out / Fan-In)

### 6.1. Modelo de Concorrencia

- **Fan-Out**: agentes modeladores disparam em paralelo via worker pool
- **Fan-In**: ao final de cada round, resultados sao coletados e rankeados
- **Rounds**: N iteracoes onde agentes consultam o leaderboard para se otimizarem
- **Isolamento**: cada agente opera em sua propria worktree de artefatos

### 6.2. Ciclo de Vida de um Round

```typescript
async function executeRound(roundNumber: number, agents: AgentRunner[]): Promise<void> {
  // Fan-Out: dispatch paralelo
  const results = await Promise.allSettled(
    agents.map(agent => agent.execute(buildContext(roundNumber)))
  );

  // Fan-In: registro no leaderboard
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.status === 'SUCCESS') {
      await leaderboard.register(toExperiment(result.value, roundNumber));
    }
  }

  // Auditoria cega ao final do round
  await metricVerifier.execute(buildVerifierContext(roundNumber));
}
```

### 6.3. Politicas de Timeout e Recursos

| Politica | Valor | Justificativa |
|----------|-------|---------------|
| Timeout por modelo | 10 min | Previne travamento por convergencia lenta |
| Max dataset em memoria | 2 GB | Acima disso, stratified sampling obrigatorio |
| SQLite busy_timeout | 5000 ms | Evita deadlocks em escrita concorrente |
| Max rounds por run | Configuravel | Default: 5 |
| Max agentes simultaneos | Configuravel | Default: 4 |

---

## 7. Guardrails de Qualidade

### 7.1. Determinismo

Todo script gerado DEVE incluir no topo:

```python
import random, numpy as np
random.seed(42)
np.random.seed(42)
# Se usar torch: torch.manual_seed(42)
```

### 7.2. Isolamento Estatistico

- `dataset_holdout.csv` armazenado em diretorio protegido, inacessivel aos Model Builders
- Agentes de treinamento NUNCA recebem path do holdout no contexto
- Apenas `MetricVerifier` tem acesso (via injecao explicita)

### 7.3. Concorrencia SQLite

- Sempre usar connection pools com context manager
- WAL mode obrigatorio
- Transacoes curtas: ler, processar fora da tx, escrever
- Retry com backoff exponencial em SQLITE_BUSY

### 7.4. Isolamento de Artefatos

- Cada agente cria worktree propria: `artifacts/{run_id}/{agent_name}/`
- Nenhum agente escreve fora de seu diretorio
- Previne sobrescrita entre agentes concorrentes

---

## 8. Estrategia de Branching e Desenvolvimento

### 8.1. Modelo de Branches

```
main                    <- producao, protegida
  |
  +-- develop           <- integracao continua
       |
       +-- feat/xxx     <- features novas
       +-- fix/xxx      <- correcoes
       +-- refactor/xxx <- refatoracoes
       +-- test/xxx     <- melhorias em testes
```

### 8.2. Regras de Branch

| Regra | Descricao |
|-------|-----------|
| Naming | `{tipo}/{descricao-curta}` (ex: `feat/add-ensemble-expert`) |
| Origem | Sempre a partir de `develop` |
| Merge | Via Pull Request com ao menos 1 approval |
| Conflitos | Resolver antes do merge, nunca force-push em shared branches |
| Lifetime | Branches de feature duram no maximo 3 dias |

### 8.3. Checklist de PR

- [ ] Testes unitarios passando
- [ ] Testes de integracao passando (quando aplicavel)
- [ ] Sem regressao de cobertura
- [ ] Lint sem erros
- [ ] Sem import cycles novos introduzidos
- [ ] Interfaces respeitam ISP (nao adicionar metodos desnecessarios)

---

## 9. Estrategia de Testes

### 9.1. Piramide de Testes

```
        /  E2E  \           <- poucos, lentos, pipeline completo
       /----------\
      / Integracao \        <- SQLite real, filesystem real
     /--------------\
    /   Unitarios    \      <- muitos, rapidos, isolados com mocks
   /------------------\
```

### 9.2. Convencoes

| Convencao | Valor |
|-----------|-------|
| Framework | Vitest (ja em uso na codebase) |
| Colocacao | `*.test.ts` ao lado do arquivo fonte |
| Naming | `describe('ModuleName')` > `it('should [comportamento esperado]')` |
| Mocks | Apenas para I/O externo (filesystem, network); SQLite real em integracao |
| Coverage minimo | 80% em modulos novos |
| Dados de teste | Factories/fixtures, nunca dados de producao |

### 9.3. O Que Testar por Modulo

| Modulo | Tipo de Teste | Foco |
|--------|---------------|------|
| `leaderboard/repository` | Integracao | CRUD, concorrencia, constraints |
| `agents/*` | Unitario | Parsing de resultado, validacao de contrato |
| `orchestrator/fan-out` | Unitario | Dispatch, timeout, error handling |
| `orchestrator/fan-in` | Unitario | Ranking, deduplicacao |
| `metric-verifier` | Integracao | Calculo de gap, status transitions |
| Pipeline completo | E2E | Dataset sintetico -> leaderboard preenchido |

### 9.4. Testes Obrigatorios Antes de Merge

```bash
# Rodar antes de abrir PR
npm run test           # unitarios + integracao
npm run test:e2e       # pipeline completo (CI)
npm run lint           # eslint + prettier
npm run typecheck      # tsc --noEmit
```

---

## 10. Plano de Refatoracao (Import Cycles)

O grafo de conhecimento revela 12+ ciclos de importacao na codebase atual. A refatoracao deve elimina-los progressivamente:

### 10.1. Ciclos Identificados (Prioritarios)

1. `agent-scheduler <-> step-ops` — extrair interface compartilhada
2. `rugpull -> run -> step-ops -> rugpull` — inverter dependencia via eventos
3. `step-ops -> control-client -> control-server -> step-ops` — introduzir mediator
4. `control-client -> daemonctl -> mcp-server -> control-client` — event bus

### 10.2. Estrategia de Resolucao

- **Extrair interfaces**: mover tipos compartilhados para `types.ts` no nivel do modulo
- **Dependency Inversion**: modulos de baixo nivel expem interfaces, alto nivel consome
- **Event-driven**: substituir chamadas diretas por emissao de eventos onde aplicavel
- **Cada ciclo = 1 branch**: `refactor/break-cycle-{nome}`

---

## 11. Configuracao e Constantes

```typescript
// src/autoresearch/config.ts

export interface FormigaConfig {
  // Execucao
  maxRoundsPerRun: number;          // default: 5
  maxConcurrentAgents: number;      // default: 4
  modelTimeoutMs: number;           // default: 600_000 (10 min)
  maxDatasetSizeBytes: number;      // default: 2 * 1024**3 (2 GB)

  // Auditoria
  overfitThresholdRelative: number; // default: 0.10 (10%)

  // SQLite
  dbPath: string;
  busyTimeoutMs: number;            // default: 5000

  // Isolamento
  holdoutPath: string;              // diretorio protegido
  artifactsBaseDir: string;

  // Determinismo
  randomSeed: number;               // default: 42
}
```

---

## 12. Dashboard: UI/UX do Pipeline

### 12.1. Principios de Design

| Principio | Aplicacao |
|-----------|-----------|
| **Profissional** | React 18 + Vite + TypeScript. Build otimizado (code-splitting, tree-shaking), HMR no dev |
| **Componentizado** | Cada tela como composicao de componentes reutilizaveis e tipados ponta-a-ponta com o backend |
| **Responsivo** | Tailwind CSS (mobile-first, breakpoints utilitarios), funciona em tablet/desktop |
| **Real-time** | Polling a cada 3s via TanStack Query (cache + revalidacao em background), sem WebSocket |
| **Dark-first** | Tema escuro como padrao via Tailwind `dark:` + tokens CSS (DS trabalha em terminais) |
| **Informacao densa** | Maximizar dados por pixel, sem decoracao desnecessaria |

### 12.2. Telas Principais

#### Tela 1: Pipeline Overview (Home)

```
+------------------------------------------------------------------+
| FORMIGA                                    [Run #12] [New Run ▼]  |
+------------------------------------------------------------------+
| Status: RUNNING | Round 3/5 | Elapsed: 14m32s | Tokens: 45.2k    |
+------------------------------------------------------------------+
|                                                                    |
|  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌────────┐ |
|  │  DATA   │→ │ FEATURE │→ │ CLASSIC │→ │ADVANCED │→ │ CRITIC │ |
|  │ ANALYST │  │ENGINEER │  │  MODEL  │  │  MODEL  │  │ AUDIT  │ |
|  │         │  │         │  │         │  │         │  │        │ |
|  │  DONE   │  │  DONE   │  │RUNNING  │  │RUNNING  │  │WAITING │ |
|  │  2m14s  │  │  4m08s  │  │  8m10s  │  │  6m33s  │  │   --   │ |
|  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └────────┘ |
|                                                                    |
| Quick Stats:                                                       |
| Modelos treinados: 12 | Validados: 8 | Rejeitados: 3 | Pending: 1|
| Melhor cv_mean: 0.892 (lgbm_v2) | Baseline: 0.741               |
+------------------------------------------------------------------+
```

**Componentes**:
- Header com run info (id, round, elapsed, tokens)
- Pipeline progress bar: 5 blocos sequenciais (com setas) mostrando status de cada agente
- Quick stats: contadores agregados do leaderboard
- Botoes: Pause, Resume, Cancel, New Run

#### Tela 2: Kanban dos Agentes

```
+------------------------------------------------------------------+
| KANBAN — Run #12, Round 3                         [← Back] [⟳ 3s] |
+------------------------------------------------------------------+
|                                                                    |
| DATA ANALYST    FEATURE ENG.   MODELER CLASSIC  MODELER ADVANCED  |
| ────────────    ────────────   ───────────────  ────────────────  |
| ┌──────────┐   ┌──────────┐   ┌─────────────┐  ┌──────────────┐ |
| │ ✓ DONE   │   │ ✓ DONE   │   │ ⚡ RUNNING   │  │ ⚡ RUNNING    │ |
| │          │   │          │   │             │  │              │ |
| │ EDA      │   │ Features │   │ XGBoost     │  │ MLP tuning   │ |
| │ completa │   │ 142 cols │   │ trial 38/50 │  │ trial 22/30  │ |
| │          │   │ 5-fold   │   │             │  │              │ |
| │ 01_eda.md│   │ split.pkl│   │ best: 0.871 │  │ best: 0.854  │ |
| └──────────┘   └──────────┘   ├─────────────┤  ├──────────────┤ |
|                                │ ✓ LightGBM  │  │ ✓ TabNet     │ |
|                                │   cv: 0.892 │  │   cv: 0.867  │ |
|                                ├─────────────┤  ├──────────────┤ |
|                                │ ✓ CatBoost  │  │ ○ AutoGluon  │ |
|                                │   cv: 0.885 │  │   pending    │ |
|                                ├─────────────┤  └──────────────┘ |
|                                │ ✓ Ridge     │                    |
|                                │   cv: 0.823 │   ML CRITIC       |
|                                ├─────────────┤   ────────────    |
|                                │ ✓ Stacking  │   ┌────────────┐ |
|                                │   cv: 0.896 │   │ ○ WAITING   │ |
|                                └─────────────┘   │ 0 auditados │ |
|                                                   └────────────┘ |
+------------------------------------------------------------------+
```

**Funcionalidades do Kanban**:
- Uma lane por agente, ordenadas pelo fluxo do pipeline
- Cards representam modelos/tarefas dentro de cada agente
- Status visual: ○ waiting, ⚡ running, ✓ done, ✗ failed
- Card info: modelo, trial progress, melhor metrica ate agora
- Click no card abre detalhe (hiperparametros, logs, tempo)
- Lane summary: contadores (done/running/total)
- Auto-refresh com polling configuravel

#### Tela 3: Leaderboard

```
+------------------------------------------------------------------+
| LEADERBOARD — Run #12                   [Filter ▼] [Sort: cv_mean]|
+------------------------------------------------------------------+
| #  | Model ID     | Agent    | Type      | cv_mean | cv_std | Gap  | Status    |
|----|------------- |----------|-----------|---------|--------|------|-----------|
| 1  | stacking_v1  | classic  | Stacking  | 0.896   | 0.008  | 3.2% | AUDITED   |
| 2  | lgbm_v2      | classic  | LightGBM  | 0.892   | 0.011  | 4.1% | AUDITED   |
| 3  | catboost_v1  | classic  | CatBoost  | 0.885   | 0.009  | 3.8% | AUDITED   |
| 4  | tabnet_v1    | advanced | TabNet    | 0.867   | 0.015  | 5.2% | VALIDATED |
| 5  | mlp_v2       | advanced | MLP       | 0.854   | 0.018  | 6.1% | PENDING   |
| 6  | xgb_v1       | classic  | XGBoost   | 0.871   | 0.013  | 4.5% | RUNNING   |
| 7  | ridge_v1     | classic  | Ridge     | 0.823   | 0.007  | 1.2% | AUDITED   |
| -- | baseline_v0  | feat-eng | Logistic  | 0.741   | 0.005  | 0.8% | BASELINE  |
+------------------------------------------------------------------+
| BASELINE ────────────────── 0.741                                  |
|                                                                    |
| Detalhes do modelo selecionado (#1 stacking_v1):                  |
| ┌────────────────────────────────────────────────────────────────┐|
| │ Hiperparametros:                                                │|
| │   meta_learner: RidgeCV(alphas=[0.1,1,10])                     │|
| │   base_models: [lgbm_v2, catboost_v1, ridge_v1]               │|
| │                                                                 │|
| │ Metricas secundarias:                                           │|
| │   roc_auc: 0.934 | precision: 0.87 | recall: 0.91             │|
| │                                                                 │|
| │ Feature Importances (top 5):                                    │|
| │   ████████████ feat_ratio_a_b     0.18                         │|
| │   ██████████   feat_log_amount    0.14                         │|
| │   ████████     feat_interaction_1  0.11                        │|
| │   ███████      feat_time_since    0.09                         │|
| │   █████        feat_category_enc   0.07                        │|
| │                                                                 │|
| │ Hipotese: "Stacking dos 3 melhores modelos diversos com        │|
| │  Ridge como meta-learner maximiza generalizacao"                │|
| │                                                                 │|
| │ Tempo: treino 12.4s | inferencia 3.2ms/1k                     │|
| │ Artifact: artifacts/models/stacking_v1.pkl (2.3 MB)            │|
| │ Audit: PASSED (gap 3.2%, critic score: 9/10)                   │|
| └────────────────────────────────────────────────────────────────┘|
+------------------------------------------------------------------+
```

**Funcionalidades do Leaderboard**:
- Tabela ordenavel por qualquer coluna (default: cv_mean DESC)
- Filtros: por agente, por status, por tipo de modelo, por round
- Linha de baseline destacada como referencia visual
- Click na row expande painel de detalhes com:
  - Hiperparametros completos (JSON formatado)
  - Metricas primarias e secundarias
  - Feature importances (bar chart inline)
  - Hipotese/justificativa do modelo
  - Tempo de treino e inferencia
  - Path do artifact e tamanho
  - Status de auditoria (passed/failed/pending + motivo)
- Badges de status coloridos:
  - `BASELINE` (cinza), `PENDING` (amarelo), `RUNNING` (azul pulsante)
  - `VALIDATED` (verde claro), `AUDITED` (verde), `REJECTED` (vermelho), `OVERFITTED` (laranja)
- Comparacao lado-a-lado: selecionar 2-3 modelos e ver diff

#### Tela 4: Detalhe do Agente

```
+------------------------------------------------------------------+
| AGENT: modeler-classic                          [Logs] [Findings] |
+------------------------------------------------------------------+
| Status: RUNNING | Round: 3 | Iteration: v2 | Elapsed: 8m10s      |
+------------------------------------------------------------------+
| Plan (aprovado):                                                   |
| - LightGBM: 50 trials, max_depth [3-12], lr [0.01-0.3]          |
| - XGBoost: 50 trials, subsample [0.6-1.0], colsample [0.5-1.0]  |
| - CatBoost: 50 trials, depth [4-10], l2_reg [1-10]              |
| - Ridge: 30 trials, alpha [0.001-100]                            |
| - Stacking: top-3 OOF + Ridge meta                               |
+------------------------------------------------------------------+
| Progress:                                                          |
| LightGBM  [██████████████████████████████████████] 50/50 ✓ 0.892 |
| XGBoost   [████████████████████████████░░░░░░░░░░] 38/50 ⚡ 0.871 |
| CatBoost  [██████████████████████████████████████] 50/50 ✓ 0.885 |
| Ridge     [██████████████████████████████████████] 30/30 ✓ 0.823 |
| Stacking  [██████████████████████████████████████] done  ✓ 0.896 |
+------------------------------------------------------------------+
| Cross-findings enviados: 2 | Recebidos: 1                        |
| Rejeicoes do critic: 1 (xgb_v0 — gap > 10%)                     |
+------------------------------------------------------------------+
```

### 12.3. API Endpoints (Dashboard ML)

| Metodo | Path | Descricao |
|--------|------|-----------|
| GET | `/` | Pipeline overview (home) |
| GET | `/kanban` | Kanban dos agentes |
| GET | `/leaderboard` | Leaderboard visual |
| GET | `/agents/:name` | Detalhe de um agente |
| GET | `/api/pipeline/status` | Status geral do pipeline (JSON) |
| GET | `/api/agents` | Lista agentes com status e progresso |
| GET | `/api/agents/:name` | Detalhe: plan, trials, findings |
| GET | `/api/agents/:name/logs` | Logs do agente (paginado) |
| GET | `/api/leaderboard` | Tabela completa do leaderboard |
| GET | `/api/leaderboard/:id` | Detalhe de um experimento |
| GET | `/api/leaderboard/compare` | Comparacao entre modelos (query: ids=1,2,3) |
| GET | `/api/rounds` | Historico de rounds com metricas agregadas |
| GET | `/api/cross-findings` | Cross-pollination log entre modeladores |
| POST | `/api/pipeline/pause` | Pausar pipeline |
| POST | `/api/pipeline/resume` | Retomar pipeline |
| POST | `/api/pipeline/cancel` | Cancelar pipeline |
| GET | `/api/health` | Health check |

### 12.4. Schema de Dados do Kanban (TypeScript)

```typescript
// Estende o KanbanCard existente para contexto ML

export interface MLKanbanCard {
  id: string;                    // model_id ou task_id
  title: string;                 // ex: "LightGBM tuning"
  status: 'waiting' | 'running' | 'done' | 'failed' | 'rejected';
  agent: string;                 // modeler-classic, ml-critic, etc.
  progress?: {
    current: number;             // trial atual
    total: number;               // total de trials
    bestMetric?: number;         // melhor metrica ate agora
  };
  metrics?: {
    cvMean: number;
    cvStd: number;
    trainValGap: number;
  };
  timing?: {
    startedAt: string;
    elapsed: number;             // seconds
  };
  auditStatus?: 'pending' | 'validated' | 'rejected' | 'overfitted';
  auditReason?: string;
}

export interface MLKanbanLane {
  agent: string;                 // nome do agente
  label: string;                 // display name
  status: 'waiting' | 'running' | 'done' | 'failed';
  cards: MLKanbanCard[];
  summary: {
    done: number;
    failed: number;
    running: number;
    total: number;
    bestMetric?: number;
  };
}

export interface MLKanbanSnapshot {
  runId: string;
  round: number;
  totalRounds: number;
  pipelineStatus: string;
  elapsed: number;
  tokensSpent: number;
  lanes: MLKanbanLane[];
  leaderboardTop3: LeaderboardEntry[];
  baselineMetric: number;
  generatedAt: string;
}
```

### 12.5. Schema de Dados do Leaderboard (API Response)

```typescript
export interface LeaderboardEntry {
  rank: number;
  experimentId: number;
  modelId: string;
  agent: string;
  modelType: string;
  round: number;
  iteration: number;
  cvMean: number;
  cvStd: number;
  trainValGap: number;
  status: 'PENDING' | 'RUNNING' | 'VALIDATED' | 'AUDITED' | 'REJECTED' | 'OVERFITTED' | 'BASELINE';
  primaryMetric: string;
  secondaryMetrics: Record<string, number>;
  hyperparameters: Record<string, unknown>;
  featureImportancesTop10: [string, number][];
  hypothesis: string;            // justificativa/hipotese do modelo
  trainTimeSeconds: number;
  inferenceTimeMsPer1k: number;
  artifactPath: string;
  artifactSizeBytes: number;
  auditNotes?: string;           // notas do ml-critic
  createdAt: string;
}

export interface LeaderboardResponse {
  runId: string;
  round: number;
  baseline: LeaderboardEntry;
  entries: LeaderboardEntry[];
  summary: {
    total: number;
    validated: number;
    rejected: number;
    pending: number;
    bestModel: string;
    bestMetric: number;
    improvementOverBaseline: number;  // percentual
  };
}
```

### 12.6. CSS Design Tokens

```css
:root {
  /* Cores base (dark theme) */
  --bg-primary: #0d1117;
  --bg-secondary: #161b22;
  --bg-card: #1c2128;
  --border: #30363d;

  /* Status */
  --status-waiting: #8b949e;
  --status-running: #58a6ff;
  --status-done: #3fb950;
  --status-failed: #f85149;
  --status-rejected: #f85149;
  --status-overfitted: #d29922;
  --status-baseline: #6e7681;
  --status-validated: #7ee787;

  /* Accent */
  --accent-primary: #ff6b35;     /* Formiga orange */
  --accent-secondary: #58a6ff;

  /* Typography */
  --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* Spacing */
  --space-xs: 4px;
  --space-sm: 8px;
  --space-md: 16px;
  --space-lg: 24px;
  --space-xl: 32px;

  /* Card */
  --card-radius: 8px;
  --card-shadow: 0 1px 3px rgba(0,0,0,0.3);
}
```

### 12.7. Implementacao (Stack)

| Camada | Tecnologia | Justificativa |
|--------|-----------|---------------|
| Server | Node.js native `http` | Ja em uso, zero deps extras |
| Frontend framework | **React 18 + Vite + TypeScript** | Padrao de mercado, ecossistema maduro, HMR rapido, build otimizado |
| Styling | **Tailwind CSS** | Utility-first, tema dark via `dark:`, bundle final purgeado |
| Componentes/Forms | Headless UI / Radix Primitives | Acessiveis (a11y), sem opiniao visual — combinam com Tailwind |
| Data fetching | **TanStack Query** (`@tanstack/react-query`) | Cache, revalidacao em background, polling declarativo (`refetchInterval: 3000`) |
| Roteamento | React Router (data router) | SPA com loaders/actions tipados |
| Charts | **Apache ECharts** via `echarts-for-react` | Robusto, gr\u00e1ficos complexos (kanban heatmap, leaderboard trends), tema customizavel |
| Tipos compartilhados | `src/shared/dashboard-types.ts` | Schemas TS importados pelo server e pelo frontend (single source of truth) |
| Dados (backend) | SQLite queries diretas | Performance, sem ORM |
| Build/dev | Vite + ESBuild | Dev server <100ms HMR, build com code-splitting automatico |

**Layout no repo**: codigo React vive em `src/dashboard/` (Vite root); o backend serve os artefatos buildados (`dist/dashboard/`) atraves do `http` nativo, mantendo um unico processo em producao.

**Nao usar**: WebSocket (polling resolve), Redux/MobX (TanStack Query + estado local cobrem), `create-react-app` (Vite e estado da arte), CSS-in-JS runtime (Tailwind ja resolve).

### 12.8. Fluxo de Navegacao

```
Home (Pipeline Overview)
  |
  +-- Click agente --> Agent Detail (plan, trials, logs)
  |
  +-- Click "Kanban" --> Kanban View (lanes + cards)
  |     |
  |     +-- Click card --> Card Detail (hiperparametros, metricas)
  |
  +-- Click "Leaderboard" --> Leaderboard Table
        |
        +-- Click row --> Experiment Detail (full info)
        |
        +-- Select 2+ --> Compare View (side-by-side)
```

---

## 13. Nomenclatura e Migracao de Nome

### 12.1. De Tamandua para Formiga

| Antes | Depois |
|-------|--------|
| `tamandua` (package name) | `formiga` |
| `bin/tamandua` | `bin/formiga` |
| `defaultTamanduaDir()` | `defaultFormigaDir()` |
| `resolveTamanduaRoot()` | `resolveFormigaRoot()` |
| `resolveTamanduaCli()` | `resolveFormigaCli()` |
| `TamanduaMcpServer` | `FormigaMcpServer` |
| `TamanduaEvent` | `FormigaEvent` |
| `startTamanduaMcpServer()` | `startFormigaMcpServer()` |
| `stopTamanduaMcpServer()` | `stopFormigaMcpServer()` |
| `formatTamanduaInfo()` | `formatFormigaInfo()` |
| `printTamandua()` | `printFormiga()` |

### 12.2. Estrategia de Rename

- **1 branch dedicada**: `refactor/rename-tamandua-to-formiga`
- **Find & replace global** com revisao manual pos-replace
- **Atualizar**: package.json, README, AGENTS.md, scripts de build
- **Testes devem passar** apos rename (validacao de regressao)

---

## 14. Criterios de Aceitacao do Refactoring

Cada PR de refatoracao so e aceita se:

1. **Testes passam** — zero regressao
2. **Sem ciclos novos** — validado via tooling (madge ou similar)
3. **Cobertura nao cai** — diff coverage >= 80%
4. **Um unico proposito** — cada PR faz UMA coisa (SRP de PRs)
5. **Revisao por pares** — ao menos 1 approval
6. **Documentacao atualizada** — se interface publica mudou, docs acompanham

---

## 15. Auditoria: Codigo Orfao e Gaps de Performance

### 15.1. Evidencia do Grafo de Dependencias (graphify-out)

Os dados abaixo foram extraidos de `graphify-out/graph.json` (1813 nos, 3765 arestas)
e fundamentam todas as decisoes de remocao e decomposicao desta secao.

#### Metricas do Grafo

| Metrica | Valor |
|---------|-------|
| Total de nos | 1813 |
| Total de arestas | 3765 |
| Comunidades detectadas | 146 |
| Relacoes `contains` | 1394 |
| Relacoes `calls` | 1093 |
| Relacoes `imports` | 646 |
| Relacoes `imports_from` | 230 |

#### God Nodes (maior grau de conexao)

| No | Grau | Tipo |
|----|------|------|
| `cli.ts` | 184 | arquivo (entry point) |
| `main()` | 142 | funcao |
| `index.ts` | 130 | barrel export |
| `getDb()` | 107 | funcao |
| `agent-scheduler.ts` | 105 | arquivo |
| `cleanChildEnv()` | 84 | funcao |
| `mcp-server.ts` | 58 | arquivo (orfao) |
| `update.ts` | 45 | arquivo (orfao) |

#### Analise de Codigo Orfao

- **179 nos** pertencem exclusivamente a workflows/agentes de codigo
- **215 arestas** conectam esses nos entre si (subgrafo autocontido)
- Apenas **12 nos do core** possuem conexao com codigo orfao:
  - `README.md`, `www/index.html`, `AGENTS.md` (documentacao — atualizacao trivial)
  - `src/index.ts` (barrel exports — apenas remover re-exports)
  - `package.json` (remover `json5`)
  - Outros: referenciados apenas em comentarios/imports nao executados

**Conclusao**: A delecao do codigo orfao e segura. Nenhum no de runtime do core
depende dos 13 arquivos marcados para remocao. O impacto limita-se a imports
quebrados em `src/index.ts` (limpeza trivial) e documentacao.

#### Alertas para Delecao Cuidadosa

| Arquivo Orfao | Grau | Risco |
|---------------|------|-------|
| `mcp-server.ts` | 58 | Alto acoplamento — remover imports em 5+ arquivos |
| `update.ts` | 45 | Referenciado em CLI e barrel — limpar exports |
| `worktree-manager.ts` | 32 | Usado em agent-scheduler — extrair interface antes de deletar |

#### Ciclos de Import (12 detectados pelo graphify)

```
agent-scheduler.ts -> step-ops.ts -> agent-scheduler.ts
agent-scheduler.ts -> control-client.ts -> control-server.ts -> agent-scheduler.ts
step-ops.ts -> db.ts -> step-ops.ts
control-client.ts -> daemonctl.ts -> control-client.ts
mcp-server.ts -> step-ops.ts -> mcp-server.ts (ELIMINADO com Branch 1)
... (7 ciclos adicionais envolvendo orfaos — eliminados com Branch 1)
```

**Nota**: 7 dos 12 ciclos envolvem `mcp-server.ts` ou outros orfaos.
Apos Branch 1 (remove-orphan-code), restam apenas **5 ciclos reais** para resolver
na Branch 3 (break-god-objects), simplificando significativamente o trabalho.

---

### 15.2. Codigo Orfao (sem valor para Formiga)

#### Arquivos Fonte para Remocao Imediata (13 arquivos)

| Arquivo | Motivo da Remocao |
|---------|-------------------|
| `src/server/mcp-server.ts` | MCP protocol — zero uso ML |
| `src/server/mcp-standalone.ts` | MCP standalone — idem |
| `src/installer/worktree-manager.ts` | Git worktrees para PRs de codigo |
| `src/installer/pi-config.ts` | Integracao Pi (coding agent CLI) |
| `src/installer/pi-stream-parser.ts` | Parser de output do Pi |
| `src/installer/pi-command-preview.ts` | Preview de comandos Pi |
| `src/installer/run-harness.ts` | Wrapper Pi/Hermes |
| `src/installer/rugpull.ts` | Anomalias de agente de codigo |
| `src/installer/symlink.ts` | Gerenciamento de symlink CLI |
| `src/cli/update.ts` | Self-update do tool |
| `src/cli/ant.ts` | Prompt orchestrator para bug-fix |
| `src/lib/version-check.ts` | Check de atualizacao |
| `src/lib/frontend-detect.ts` | Detecta framework frontend |

#### Workflows para Deletar (20 diretorios)

```
workflows/bug-fix/
workflows/bug-fix-github-pr/
workflows/bug-fix-merge/
workflows/bug-fix-merge-worktree/
workflows/bug-fix-worktree/
workflows/feature-dev/
workflows/feature-dev-github-pr/
workflows/feature-dev-merge/
workflows/feature-dev-merge-worktree/
workflows/feature-dev-worktree/
workflows/security-audit/
workflows/security-audit-github-pr/
workflows/security-audit-merge/
workflows/security-audit-merge-worktree/
workflows/security-audit-worktree/
workflows/quarantine-broken-tests/
workflows/quarantine-broken-tests-merge/
workflows/quarantine-broken-tests-merge-worktree/
workflows/frontend-test/
workflows/skills-normalize-audit/
```

#### Agent Personas para Deletar

```
agents/shared/pr/          # PR creator (GitHub/GitLab) — irrelevante para ML
```

#### Dependencia Nao Usada

```
json5 — zero imports no codigo, remover de package.json
```

### 15.3. Gaps de Performance (Severity HIGH)

| # | Arquivo | Problema | Impacto |
|---|---------|----------|---------|
| 1 | `agent-scheduler.ts:1020-1217` | `await import()` dinamico dentro de `executePollingRound()` (hot path, roda a cada 5min por agente) | Re-avaliacao de modulo a cada tick |
| 2 | `agent-scheduler.ts:128-183` | `fs.accessSync()` em `findPiBinary()` — scan PATH inteiro a cada spawn sem cache | Bloqueio event loop 50-200ms |
| 3 | `step-ops.ts:1819-1878` | N+1 queries em `resolveStepContext()` — 4+ SELECTs por step claim sem batching | Latencia acumulada |
| 4 | `step-ops.ts:778` | `execFileSync("git diff")` em `computeHasFrontendChanges()` a cada claim | Bloqueia event loop 100ms-1s |
| 5 | `db.ts:5-42` | Conexao SQLite com TTL de 5s — reconecta e roda ALL migrations a cada ciclo | CPU waste constante |
| 6 | `db.ts:410-430` | `fs.realpathSync()` com retry loop em `resolveSessionCwd()` sem cache | I/O bloqueante repetitivo |
| 7 | `src/index.ts:1-120` | 120+ exports carregados eagerly — zero tree-shaking | Memoria + cold start lento |

**Nota**: Gaps #2 e #4 serao automaticamente eliminados pela Branch 1 (remove-orphan-code),
pois `findPiBinary()` e `computeHasFrontendChanges()` residem em codigo orfao.

### 15.4. Gaps de Performance (Severity MED)

| # | Arquivo | Problema |
|---|---------|----------|
| 8 | `agent-scheduler.ts:27-83` | Maps globais (`activeTimers`, `inFlightChildren`) sem limite — memory leak sob crashes |
| 9 | `step-ops.ts:198-234` | `readProgressFile()` + `getAgentWorkspacePath()` faz I/O sync repetido sem memoizacao |
| 10 | `step-ops.ts:240-287` | String concatenation O(n²) em `buildStoryPlanSection()` — usar array.join() |
| 11 | `control-client.ts:79-98` | `startDaemon()` sincrono + polling sleep fixo sem exponential backoff |
| 12 | `db.ts:294-324` | `readSessionConfigFromFiles()` faz readFileSync + JSON.parse sem cache |

### 15.5. Divida Arquitetural

| Problema | Arquivos Envolvidos | Severidade |
|----------|---------------------|------------|
| 12+ import cycles | agent-scheduler ↔ step-ops ↔ control-client ↔ control-server ↔ daemonctl ↔ mcp-server | HIGH |
| God objects (SRP) | `agent-scheduler.ts` (2070 LOC, 8+ responsabilidades) | HIGH |
| God objects (SRP) | `step-ops.ts` (1878 LOC, 8+ responsabilidades) | HIGH |
| God objects (SRP) | `db.ts` (450 LOC, 5 responsabilidades misturadas) | MED |
| Dep fantasma | `json5` no package.json — nunca importado | LOW |

### 15.6. Arquivos para Adaptar (manter parcialmente)

| Arquivo | O que manter | O que remover |
|---------|-------------|---------------|
| `src/cli/cli.ts` | Comandos autoresearch, status, logs | Wizard de coding, update, ant |
| `src/installer/install.ts` | Provisioning de agentes ML | Logica de workflows de codigo |
| `src/installer/run.ts` | Engine de execucao de steps | Logica de harness Pi/Hermes |
| `src/installer/workflow-fetch.ts` | Core de listagem | Referencia a workflows de coding |
| `src/medic/checks.ts` | Deteccao de runs travados | Checks especificos de coding agents |

### 15.7. Decomposicao dos God Objects

#### agent-scheduler.ts (2070 LOC) -> 4 modulos

```
src/installer/
  scheduler/
    index.ts               # Re-export publico
    cron-manager.ts        # Lifecycle de jobs (setInterval, cleanup)
    process-spawner.ts     # Spawn de agentes, signal handling
    polling-round.ts       # executePollingRound (logica de negocio)
    binary-discovery.ts    # findBinary com cache (ou remover se Pi/Hermes sai)
```

#### step-ops.ts (1878 LOC) -> 4 modulos

```
src/installer/
  steps/
    index.ts               # Re-export publico
    state-machine.ts       # claim, complete, fail, advance
    story-manager.ts       # Loop steps, story CRUD, plan sections
    template-resolver.ts   # Output parsing, KEY:VALUE, template keys
    pipeline-control.ts    # advancePipeline, checkLoopContinuation, cron teardown
```

#### db.ts (450 LOC) -> 4 modulos

```
src/database/
    index.ts               # Re-export publico
    connection.ts          # getDb, pool, WAL config (sem TTL de 5s)
    migrations.ts          # Schema DDL, lazy migration
    session-repo.ts        # AutoResearch sessions CRUD
    token-repo.ts          # Token accounting
```

---

## 16. Roadmap de Execucao (Branches)

### Branch 1: `refactor/remove-orphan-code`

**Objetivo**: Eliminar ~30% do codigo irrelevante para ML.

**Evidencia** (graphify-out): 179 nos orfaos com 215 arestas internas.
Apenas 12 conexoes com o core (todas triviais — docs/exports). Delecao segura.
Bonus: elimina 7 dos 12 ciclos de import automaticamente.

**Escopo**:
- Deletar 13 arquivos fonte orfaos (listados em 15.1)
- Deletar 20 workflows de codigo
- Deletar `agents/shared/pr/`
- Remover `json5` de package.json
- Limpar exports de `src/index.ts`
- Atualizar imports quebrados (remover referencias)
- Cuidado especial com `mcp-server.ts` (58 arestas) e `update.ts` (45 arestas)
- Rodar testes — ajustar os que referenciam modulos removidos

**Validacao**: `npm run test && npm run typecheck`

---

### Branch 2: `refactor/rename-tamandua-to-formiga`

**Objetivo**: Rebranding completo enquanto a codebase esta enxuta.

**Por que agora**: Apos remover 30% do codigo, temos menos arquivos para renomear.
Se fizermos depois da decomposicao, criamos modulos novos com nome errado.

**Escopo**:
- Find & replace global (tabela da secao 13)
- Atualizar package.json (name, bin, description)
- Renomear `bin/tamandua` -> `bin/formiga`
- Atualizar README, AGENTS.md, scripts
- Atualizar CSS/HTML do dashboard (logo, title)
- Atualizar variaveis de ambiente e paths default

**Validacao**: `npm run test && npm run build`

---

### Branch 3: `refactor/break-god-objects`

**Objetivo**: Decompor arquivos com 1800-2070 LOC em modulos focados.

**Por que agora**: Com nome correto, novos modulos ja nascem como "formiga".
Decomposicao ANTES de fix perf porque e mais facil otimizar modulos pequenos.

**Escopo**:
- Decompor `agent-scheduler.ts` -> 4 modulos (scheduler/)
- Decompor `step-ops.ts` -> 4 modulos (steps/)
- Decompor `db.ts` -> 4 modulos (database/)
- Eliminar 5 import cycles restantes (7 dos 12 ja eliminados na Branch 1)
  via interfaces em `types.ts` compartilhado
- Cada modulo < 400 LOC

**Validacao**: `npm run test && npx madge --circular src/`

---

### Branch 4: `refactor/fix-perf-hot-paths`

**Objetivo**: Eliminar bloqueios de event loop e queries N+1.

**Por que agora** (e nao antes):
- Apos Branch 1: `findPiBinary()` e `computeHasFrontendChanges()` ja foram DELETADOS
  (estavam em codigo orfao). Sobram apenas os gaps reais.
- Apos Branch 3: os god objects foram decompostos. Agora otimizamos modulos de 200-400 LOC,
  nao arquivos de 2000 LOC. Muito mais facil de raciocinar e testar.

**Escopo** (gaps remanescentes apos Branches 1-3):
- `scheduler/polling-round.ts`: mover imports para top-level (nao mais ciclo)
- `steps/state-machine.ts`: batch queries em resolveStepContext (1 JOIN)
- `database/connection.ts`: remover TTL de 5s, usar singleton com lazy migration
- `database/session-repo.ts`: cache em resolveSessionCwd (memoize por run)
- `steps/story-manager.ts`: substituir string concat por array.join()
- `scheduler/cron-manager.ts`: adicionar LRU/max-size nos Maps globais

**Validacao**: `npm run test && npm run test:e2e`

---

### Branch 5: `feat/ml-agents-and-leaderboard`

**Objetivo**: Implementar os 5 agentes ML e o leaderboard.

**Por que agora**: A fundacao esta limpa (sem orfaos, nome correto, modulos pequenos,
perf otimizada). Construir features sobre divida tecnica e contraproducente.

**Escopo**:
- Criar `src/agents/` com interfaces e 5 implementacoes (secao 5 do specs)
- Criar `src/leaderboard/` com repository pattern (secao 4)
- Criar schema JSON de resultados (secao 4.3)
- Criar workspace layout (secao 3.2)
- Implementar protocolo de comunicacao inter-agente (secao 5.6)
- Adicionar testes unitarios e integracao

**Validacao**: `npm run test` (coverage >= 80% em novos modulos)

---

### Branch 6: `feat/dashboard-ml-views`

**Objetivo**: Implementar as 4 telas do dashboard ML (secao 12).

**Por que por ultimo**: O dashboard CONSOME dados dos agentes e leaderboard.
Sem a Branch 5, nao ha dados reais para renderizar nem APIs para chamar.

**Escopo**:
- Pipeline Overview (home com progress bar dos agentes)
- Kanban dos agentes com cards de modelos/trials
- Leaderboard interativo com painel de detalhes
- Agent Detail com progress bars e cross-findings
- Novos endpoints REST (secao 12.3)
- CSS design tokens dark theme (secao 12.6)

**Validacao**: `npm run test && npm run test:e2e`

---

### Ordem de Execucao (Sequencial Estrita)

```
Branch 1: remove-orphan-code
    |  Corta 30% do codigo. Gaps de perf 2 e 4 desaparecem automaticamente.
    |  Menos codigo = menos para renomear, menos para decompor.
    v
Branch 2: rename-tamandua-to-formiga
    |  Rename com codebase enxuta (menos arquivos).
    |  Todo codigo novo a partir daqui ja nasce "formiga".
    v
Branch 3: break-god-objects
    |  Novos modulos criados com nome correto.
    |  Elimina import cycles. Prepara terreno para otimizacao.
    v
Branch 4: fix-perf-hot-paths
    |  Otimiza modulos pequenos (facil de raciocinar).
    |  Varios gaps ja sumiram nas branches anteriores.
    v
Branch 5: feat/ml-agents-and-leaderboard
    |  Core ML sobre fundacao limpa e performatica.
    |  Agentes, leaderboard, comunicacao inter-agente.
    v
Branch 6: feat/dashboard-ml-views
       UI consome APIs estaveis dos agentes e leaderboard.
       Ultima porque depende de TUDO anterior.
```

### Justificativa da Sequencia

| Posicao | Branch | Depende de | Razao |
|---------|--------|-----------|-------|
| 1 | remove-orphan | nenhum | Reduz superficie para todo o resto |
| 2 | rename | Branch 1 | Menos codigo para renomear; nome correto para frente |
| 3 | break-gods | Branch 2 | Novos modulos ja com nome "formiga"; nao cria e renomeia |
| 4 | fix-perf | Branch 3 | Otimizar modulos de 300 LOC, nao monolitos de 2000 LOC |
| 5 | ml-agents | Branch 4 | Fundacao limpa, performatica, sem ciclos |
| 6 | dashboard | Branch 5 | Precisa das APIs e dados do leaderboard/agentes |

### Estimativa de Impacto Acumulado

| Apos Branch | Codigo | Ciclos | Max LOC/arquivo | Nome |
|-------------|--------|--------|-----------------|------|
| 1 | -30% | 12 (inalterado) | 2070 | tamandua |
| 2 | -30% | 12 | 2070 | **formiga** |
| 3 | -30% | **0** | **< 400** | formiga |
| 4 | -30% | 0 | < 400 | formiga (otimizado) |
| 5 | +15% (novo) | 0 | < 400 | formiga + ML core |
| 6 | +10% (novo) | 0 | < 400 | formiga completo |
