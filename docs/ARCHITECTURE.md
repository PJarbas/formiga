# Formiga — Arquitetura e Visão Geral

> **Formiga** é uma plataforma multi-agente que automatiza o ciclo completo de experimentação de Machine Learning — EDA, engenharia de features, treinamento, tuning e relatório final — através de agentes de IA que competem numa "Arena" estruturada.

Este é o único documento de referência do projeto. Ele descreve o problema que o Formiga resolve, sua arquitetura, o servidor MCP, a comunicação entre agentes, a corrida da Arena e como os resultados são produzidos.

---

## Sumário

1. [O problema que resolve](#1-o-problema-que-resolve)
2. [Arquitetura em camadas](#2-arquitetura-em-camadas)
3. [Workflows e o step "arena"](#3-workflows-e-o-step-arena)
4. [Scheduler e orquestração (claim-based)](#4-scheduler-e-orquestração-claim-based)
5. [Banco de dados](#5-banco-de-dados)
6. [Servidor MCP (formiga-agent-tools)](#6-servidor-mcp-formiga-agent-tools)
7. [Comunicação entre agentes](#7-comunicação-entre-agentes)
8. [A corrida da Arena](#8-a-corrida-da-arena)
9. [Auditor pré-escrita (gates de qualidade)](#9-auditor-pré-escrita-gates-de-qualidade)
10. [Agentes e seus papéis](#10-agentes-e-seus-papéis)
11. [Dashboard e APIs](#11-dashboard-e-apis)
12. [Padrões arquiteturais](#12-padrões-arquiteturais)

---

## 1. O problema que resolve

Cientistas de dados gastam até 80% do tempo em tarefas repetitivas: explorar dados, engenharia de features, ajustar hiperparâmetros, comparar modelos. O Formiga automatiza esse ciclo ponta a ponta spawnando um time de agentes de IA autônomos que trabalham como um esquadrão colaborativo de ciência de dados — explorando, experimentando, competindo numa Arena estruturada, e entregando modelos prontos para produção.

**Principais características:**
- **Experimentação paralela:** agentes de ML clássico, de ponta e criativo competem simultaneamente.
- **Melhoria iterativa (Arena):** o loop de modelagem roda múltiplas rodadas, adaptando-se aos aprendizados das rodadas anteriores.
- **Rigor estatístico:** todo experimento é auditado antes de entrar no ledger — significância (Nadeau-Bengio), overfitting, leakage de calibração, integridade do dataset.
- **Auditabilidade total:** cada decisão de feature, arquitetura de modelo e hiperparâmetro é registrada num ledger append-only.
- **Dashboard ao vivo:** acompanhe o DAG de execução, features engenheiradas e o ranking do leaderboard em tempo real.

**Stack:** Node.js 22+ (ESM, TypeScript), SQLite (via Prisma + `node:sqlite` nativo), React 19 (dashboard). O Formiga **não** chama LLMs diretamente — ele spawnia harnesses de agente externos (`pi-coding-agent` ou `hermes`) como processos filhos.

---

## 2. Arquitetura em camadas

```
CLI (bin/formiga) ─────────────────────┐
                                       ▼
                    SQLite (~/.formiga/formiga.db)
                                       ▲
            ┌──────────────────────────┼──────────────────────────┐
            │                          │                          │
   Daemon / Scheduler          Agent Harness (pi/hermes)    Dashboard API (:3334)
   (orchestra o DAG,           (spawna os agentes de IA)     (React SPA + REST + MCP)
    cron + event-driven)            │                          │
            │                        ▼                          │
            │              Agentes de IA (data-analyst,         │
            │              feature-engineer, modelers,          │
            │              reporter) ──gravam/leem──► SQLite ◄──┘
            ▼
   Arena Engine (competição multi-round)
```

O Formiga é leve, assíncrono e resiliente. Não há mensageria direta entre agentes (sem Redis/RabbitMQ/SSE entre eles) — **todo handoff é pelo SQLite compartilhado**. Os agentes são processos isolados que gravam e leem do banco; o scheduler coordena quem executa o quê.

**Portas padrão:**
- **Dashboard + MCP:** `3334` (o MCP roda embutido no dashboard na rota `/mcp`, não tem porta própria).
- **Control plane:** `3339` (scheduling run-scoped, separado).

---

## 3. Workflows e o step "arena"

Um workflow é declarado em YAML (`workflows/<id>/workflow.yml`) definindo `agents` (com workspace, skills e persona files `AGENTS.md`/`IDENTITY.md`/`SOUL.md`) e `steps` (um DAG linear, com `parallel_group` para paralelismo). Os inputs dos steps usam template substitution (`{{dataset_path}}`, `{{run_id}}`, etc.).

### ml-autoresearch (workflow principal)

```
eda → features → arena → report
```

- **`eda`** (data-analyst): EDA rigorosa, gera `eda_report` + `eda_config`.
- **`features`** (feature-engineer): produz `features.parquet`, `split.pkl`, baseline, `benchmark_config.json`, `benchmark_runner.py`.
- **`arena`** (step especial): **não é executado por um agente único** — o runner detecta `step_id === "arena"` e invoca o `runArena()` (o engine de competição). Marcado como `max_retries: 0`.
- **`report`** (reporter): consolida a competição e escreve o relatório final.

### ml-pipeline (workflow legado)

```
eda → features → (model-classic ∥ model-advanced) → audit
```

Os dois modelers usam `parallel_group: modelers` para competir concorrentemente; o `audit` (agente `ml-critic`) só é claimable após ambos completarem.

### Detecção do step "arena"

`src/installer/scheduler/direct-spawn.ts` intercepta o step `arena`: em vez de spawnar o harness, chama `launchArenaFromStep()` (em `src/arena/arena-workflow.ts`), que monta o `ArenaConfig` do `run.context` + `benchmark_config.json`, executa `runArena()`, e então `completeStep()` para avançar o pipeline. O step arena também é **excluído do circuit de heartbeat-failure** (o dono é o arena-engine, não o polling).

---

## 4. Scheduler e orquestração (claim-based)

O trabalho é distribuído por um modelo **claim-based por polling, run-scoped**. Cada agente tem um cron job (run_id, agent_id) que periodicamente pergunta "tem trabalho?" e atomicamente "claima" um step.

### Ciclo de um tick (`src/installer/scheduler/polling-round.ts`)

1. **In-flight guard** (race-safe, síncrono antes de qualquer await) — previne spawns duplicados.
2. **Verificação de trabalho pendente** — consulta steps `pending`/`waiting` no (run, agent); se vazio, aplica heartbeat backoff e retorna.
3. **Pre-claim** — `claimStep()` ANTES de spawnar o harness (remove a classe de bug onde o modelo erra o comando de discovery/claim — o step já vem claimado e injetado no prompt).
4. **Spawn do harness** — `pi --print` ou `hermes`, com stdout streamado em disco (previne OOM). `onSpawn` registra pid/pgid para recovery de órfãos.
5. **Classificação do output** — `heartbeat` / `work_done` / `other_output`.
6. **Auto-complete fallback** — se o output tem `STATUS: done` mas o agente não chamou o CLI, completa o step automaticamente.

### Claim atômico (`src/installer/steps/claim.ts`)

`claimStep()` roda SQL raw (Prisma não expressa o self-join): seleciona steps `pending` do (agent, run) onde **não existe step anterior** (`step_index <`) com status fora de `done`/`skipped` — garantindo progressão serial do pipeline. Duas exceções:
- **`verify_each`:** loop step `running` sem `current_story_id` não bloqueia verify.
- **`parallel_group`:** siblings do mesmo grupo não se bloqueiam (paralelismo).

O claim é atômico via `updateMany WHERE status='pending'` — workers concorrentes não double-claim. Para steps `loop` (`over: stories`), atomicamente avança para a próxima story `pending`.

### Event-driven acceleration

`postAdvanceSpawn()` (`src/installer/steps/complete.ts`) chama `spawnAgentsForPendingSteps()` (`src/installer/scheduler/direct-spawn.ts`) — quando um step completa, o próximo é despachado imediatamente (<1s), sem esperar o próximo tick de cron. Fallback para cron se o direct-spawn falhar.

### Recuperação e observabilidade

- **Stale-claim sweeper:** recupera claims de processos mortos (threshold `timeout * 1.5`).
- **Heartbeat-failure circuit:** após N heartbeats consecutivos sem progresso, falha o step terminalmente — exceto o step `arena`.
- **Colunas de observabilidade** em `Step`: `claim_job_id`/`claim_pid`/`claim_pgid`/`claim_updated_at`, `consecutive_heartbeats`, `spawn_count`, `last_outcome`/`last_outcome_at`.
- **Medic:** watchdog que detecta steps presos, runs zumbi, e auto-remedia.

---

## 5. Banco de dados

**Engine:** SQLite em `~/.formiga/formiga.db` (overridável via `FORMIGA_DB_PATH`). Conexão singleton com `PRAGMA journal_mode=WAL` e `PRAGMA foreign_keys=ON`.

### Models principais (`prisma/schema.prisma`)

| Model | Propósito |
|---|---|
| **`Run`** | Uma execução inteira de workflow. Tem `status`, `context` (JSON compartilhado), `tokens_spent`, campos de scheduling. |
| **`Step`** | Unidade de trabalho de um agente. `step_id` lógico, `agent_id`, `step_index`, `input_template`, `expects`, `status` (waiting/pending/running/done/failed/skipped), `type` (single/loop), `parallel_group`, campos de claim e observabilidade. |
| **`Story`** | Unidade de iteração dentro de um step `loop` (`over: stories`). |
| **`Experiment`** | **Dobra como leaderboard + arena journal** (uma linha por experimento, verdict append-only). Métricas ricas, campos de journal (fold_scores, content_hash, notes, verdict_locked_at), `decision` (keep/discard/crash/baseline/checks_failed), `status` (PENDING/SUCCESS/FAILED/AUDITED/OVERFITTED). |
| **`ArenaSession`** | Estado da competição (1:1 com Run): métrica, best, rounds, contadores de convergência. |
| **`AgentArtifact`** | Artefatos JSON persistidos pelos agentes via `save_artifact`. Unique em `(run_id, artifact_key)`. |
| **`AgentEvent`** | Log de atividade: tool calls, thinking, step events, round summaries. |
| **`DatasetSignature`** | Hash de colunas+rows para warm-start cross-run. |

Outros: `AutoresearchSession`, `RunWorktree` (isolamento git), `SpecApproval`/`ChecklistState` (UX), `JobRegistry` (polling jobs para crash recovery), `FormigaStat` (tokens globais), `MedicCheck` (health checks).

### Migrations — duas camadas idempotentes

Não há pasta `prisma/migrations`; `prisma migrate deploy` é no-op. O schema é aplicado por DDL bruto via introspecção `PRAGMA table_info` (additive — `ALTER TABLE ADD COLUMN` só se a coluna não existe):

- `src/database/migrations.ts` — `migrate(db)`: cria `runs`, `steps`, `stories`, `arena_sessions`, `agent_events`, etc.
- `src/leaderboard/schema.ts` — `initLeaderboardSchema(db)`: cria `experiments` + migrations additivas em arrays (`ARENA_COLUMNS`, `JOURNAL_LEDGER_COLUMNS`, etc.).
- `src/database/init.ts` — `initDatabase()`: roda `migrate(getDb())` uma vez no startup, antes de qualquer write Prisma.

---

## 6. Servidor MCP (formiga-agent-tools)

O Formiga expõe um servidor **MCP** (Model Context Protocol, JSON-RPC 2.0) embutido no dashboard (`src/mcp/server.ts`), na rota `/mcp`. É a extensão que os agentes usam para interagir com o Formiga — gravar e ler artefatos, registrar decisões, reportar métricas, consultar leaderboard e arena. **Toda interação agente→Formiga é por tool**, nunca por `curl`.

### As 6 tools (`src/mcp/tools/`)

| Tool | Modo | O que faz |
|---|---|---|
| **`save_artifact`** | fire-and-forget | Persiste JSON estruturado no dashboard (`key` + `data`, max 500KB). |
| **`read_artifact`** | síncrono | Lê um artefato por `key`, ou lista todos os artefatos do run se `key` omitido. Contraparte de leitura do `save_artifact`. |
| **`log_decision`** | fire-and-forget | Audit trail de decisões (`model_selection`, `feature_drop`, `hyperparameter`, etc.). Salva como artifact com key sequencial. |
| **`report_metric`** | fire-and-forget | Reporta uma métrica numérica (`name` + `value` + `tags`). Salva como artifact `metric_<name>`. |
| **`query_leaderboard`** | síncrono | Retorna o top-N de experimentos (CV, train, gap, round) para o agente decidir a próxima abordagem. |
| **`query_arena`** | síncrono | Lê o estado da arena: `view` = `session` (best, rounds, convergência), `rounds` (experimentos por rodada), ou `convergence` (série temporal de métricas). |

**Design (SOLID):**
- **ISP** — interfaces segregadas: `IArtifactService`, `ILeaderboardService`, `IArenaService` (arena ≠ ranking).
- **DIP** — services recebem repositórios injetados; mapeiam linhas internas para read models estáveis (sem vazar `ExperimentRow`).
- **SRP** — handlers só validam (allowlist) + formatam; services só mapeiam.
- **Segurança** — entradas validadas por allowlist (ex: `view` ∈ {session, rounds, convergence}), regex de keys, limites de tamanho.

O `ToolContext` (runId/stepId/agentId) é extraído de `params._meta` ou env vars `FORMIGA_RUN_ID`/`FORMIGA_STEP_ID`/`FORMIGA_AGENT_ID`.

---

## 7. Comunicação entre agentes

A comunicação é **pelo banco de dados (SQLite), não por mensagens diretas**. Múltiplos canais:

### 7.1 Artefatos (`save_artifact` / `read_artifact`) — canal primário

Cada agente grava JSON estruturado na tabela `agent_artifacts` (`eda_report`, `features_report`, `benchmark_config`, `modeler-classic_report_roundN`, `arena_report`, etc.); o downstream lê via `read_artifact` ou HTTP GET. Os personas declaram explicitamente: **"os artefatos do banco são a fonte da verdade"** — arquivos `.md` legados são opcionais. PROIBIDO usar `curl` para escrever ou ler artefatos.

Pipeline de handoff narrativo:
```
data-analyst ──save_artifact("eda_report")──► SQLite ──read_artifact──► feature-engineer
feature-engineer ──save_artifact("features_report")──► SQLite ──read_artifact──► modelers
modelers ──save_artifact("modeler-X_report_roundN")──► SQLite ──read_artifact──► reporter
reporter ──save_artifact("arena_report")──► SQLite
```

### 7.2 `Run.context` — contexto compartilhado

JSON string do run, populado com variáveis de template (`dataset_path`, `target_column`, `workspace`, etc.) lidas pelos steps. O `arena-workflow.ts` lê `run.context` para montar o `ArenaConfig`.

### 7.3 `Experiment.notes` — cross-pollination

Canal de sugestões dirigidas **ao outro time**, distinto de `learned` (reflexão própria). O `arena-engine` injeta as `notes` dos times adversários no prompt do próximo round como "### Sugestões do Outro Time". O modeler-creative tem `notes` obrigatório — é seu canal principal de contribuição para o ensemble.

### 7.4 `query_leaderboard` / `query_arena` — leitura síncrona do estado

Os modelers consultam o leaderboard antes de decidir a próxima abordagem; o reporter consulta o estado da arena (session/rounds/convergence) para o relatório final.

### 7.5 Warm-start cross-run

`leaderboardRepo.getBestByDatasetSignature(signature, 3)` injeta os 3 melhores resultados passados para o mesmo dataset (via `dataset_signature`) no round 1 — transfer learning entre runs.

### 7.6 CLI `formiga message`

Existe um canal secundário agent→agent via `sendMessage`/`listMessages`/`readMessage` (persistido como artifacts), mas não é referenciado nos personas do ml-autoresearch — o handoff por artefatos é o canal canônico.

---

## 8. A corrida da Arena

O engine de competição (`src/arena/arena-engine.ts`, `runArena()`) é o coração do ml-autoresearch. Três times de modelers competem por múltiplas rodadas para atingir a melhor métrica.

### Setup

1. Cria a `ArenaSession` no banco.
2. Estabelece o baseline lendo `benchmark_config.json` (ou rodando o benchmark com `baseline.pkl`).
3. Lê o contexto do dataset uma vez; deriva o compute budget do tier de complexidade (RF-#90).
4. **Tier gate:** se o dataset é `medium`/`large`, usa os 3 times; senão filtra o `modeler-creative` (ROI negativo em TINY/SMALL).
5. **Warm-start:** injeta os 3 melhores resultados passados para este dataset.
6. Carrega o `content_hash` (MD5 de features‖split‖config) como âncora de integridade intra-run.

### Loop de rodadas (até `max_rounds`)

Para cada rodada:

1. **`buildPromptsForRound()`** — monta o prompt por agente com: histórico próprio, resultados `keep`/`baseline` dos outros times, **notes cross-pollination**, dicas de warm-start (round 1), regras de saída JSON (`_results.json`), e o contrato de métricas ricas.

2. **Fan-out paralelo** — `runAgentsParallel()` spawna todos os times ativos simultaneamente (`pi --print --mode json` com a extensão `formiga-agent-tools`). Cada agente gera um script Python autônomo que treina e avalia um modelo.

3. **Medição sequencial** (contention de recursos) — para cada agente:
   - Escreve o script Python gerado em `artifacts/models/<agent>_round<N>.py`.
   - `trainScript()` spawna `python3` detached (process group) com prelude `RLIMIT_CPU` e env vars de budget. Timeout = min(180s, budget). Kill tree graceful: SIGTERM → SIGKILL após 2s.
   - `extractMetric()` parseia `<metric_name>: <valor>` do stdout/stderr.
   - `tryLoadRichMetrics()` lê o `_results.json` sidecar: `fold_scores`, `train_score`, `oof_path`/`prod_path`, `brier_*`, `ece_calibrated`, `n_unique_probs`, `notes`, `category`.

4. **Pré-write audit** — `auditExperiment()` (ver §9) roda ANTES de persistir; pode rejeitar, baixar para `warn`, ou manter `keep`.

5. **Persistência** — `registerArena()` grava o `Experiment` com todos os campos do journal (incluindo `verdict_locked_at` — ledger append-only).

6. **Promoção** — só `keep`/`baseline` (estatisticamente significativos) promovem `bestMetric`/`bestAgent` e resetam o contador de no-improve. As `fold_scores` do novo best são capturadas para o próximo teste Nadeau-Bengio.

### Convergência

Para em `target_reached` (métrica alvo atingida), `converged` (`consecutiveNoImprove >= maxNoImprove`), ou `max_rounds`.

### Os três times (territórios segregados)

| Time | Território | Anti-invasão |
|---|---|---|
| **modeler-classic** | GBM (XGB/LGBM/CatBoost), linear, trees, SVM/KNN, Stacking L1 | Sem NN/AutoML |
| **modeler-advanced** | MLP, TabNet, FT-Transformer, TabPFN, AutoML, Stacking multi-nível, Entity Embeddings | Sem GBM/linear padrão |
| **modeler-creative** | DAE, mRMR agressivo, target permutation, monotonic constraints, blending Bayesiano, SHAP interactions | Sem abordagens padrão; meta é **decorrelação** (Spearman OOF corr <0.85 vs top-1) |

Cada time tem budget de até 5 iterações e regra de early-stop: se a iteração N não venceu o best com significância e não há hipótese diferenciada, para.

---

## 9. Auditor pré-escrita (gates de qualidade)

`src/arena/audit.ts` — `auditExperiment()` é uma função pura que roda **antes** de o experimento entrar no ledger (análogo ao `auto_critic` síncrono). Verdicts: `keep` | `warn` | `rejected`.

### Gates em ordem (primeiro REJECTED para)

| Gate | Tag | Regra |
|---|---|---|
| **G7** dedup | `budget` | `(team, model_type, hyperparams, metric)` idêntico a entrada anterior → `[dedup]`. Não persiste, não consome slot. |
| **G6** budget | `budget` | Time atingiu `maxIterationsPerTeam` (5) → `[budget]`. Ainda persiste para transparência. |
| **G2** content_hash | `stale` | `contentHash` do experimento ≠ hash da sessão → `[stale]` (dataset regerado). |
| **G3** no_folds | `no_folds` | `fold_scores` ausente ou <2 → `[no_folds]` (sem folds não dá Nadeau-Bengio). |
| **G1** overfit | `overfit` | `|train - val| > threshold(tier)` (TINY=0.06, SMALL=0.05, MEDIUM/LARGE=0.03). |
| **G4** cal_leak | `cal_leak` | OOF com <50 probs únicas (saturação) OU ECE <1e-6 (suspeitosamente perfeito — calibrador fitado no OOF). |
| **G5** too_good | warning | AUC univariada ≥0.99 (provável proxy do target). Não rejeita. |
| **G8** significance | warning | Nadeau-Bengio p≥0.05 OU delta<0.5pp → downgrade para `warn` (fica no ledger, não promove). |

### Nadeau-Bengio (significância)

Teste-t corrigido por overlap de folds (Nadeau & Bengio 2003): `correction = 1/n + (n-1)/n`. Critério "estatisticamente justo": `keep` só se `p < 0.05` **E** `delta ≥ 0.5pp`. Implementação própria de t-Student (regularized incomplete beta via continued-fraction) — sem dependência estatística externa.

### Ledger append-only

`registerArena()` seta `verdict_locked_at` no insert. Depois disso, `reject`/`autoAudit`/`updateTestMetric` lançam erro (imutabilidade do verdict). `setDatasetSignature` é exempt (metadata pré-verdict). Campos de display ficam separados dos campos de ledger.

### Ensemble Nelder-Mead

`nelderMeadEnsembleWeights(nModels, score)` otimiza pesos sobre o simplex Δⁿ (weights ≥0, soma 1) para blend de OOFs. Usado pelo reporter — não é um gate do auditor.

---

## 10. Agentes e seus papéis

Cada agente tem persona files em `workflows/ml-autoresearch/agents/<id>/` (`AGENTS.md` + `IDENTITY.md` + `SOUL.md`).

1. **data-analyst** — EDA rigorosa, read-only (não treina). 9 seções obrigatórias no relatório. Técnicas: Mutual Information, Cramer's V, Theil's U, point-biserial (leakage flag >0.70), Kolmogorov-Smirnov (drift), Fisher skewness. ≥5 hipóteses acionáveis. Salva `eda_report` + `eda_config`.

2. **feature-engineer** — consome EDA, produz a matriz canônica + split + baseline + scripts de benchmark. **Único criador de splits.** Compute budget derivado do tier. `content_hash` MD5. **Feature Quality Gate** com 10 gates bloqueantes (colinearidade, VIF, **adversarial validation** >0.80 = abort, too-good, estabilidade Nogueira, missing, dimensionalidade, leakage CV-interno, near-zero variance, re-execução bit-idêntica). Target encoding leakage-proof (fit-per-fold). OOT holdout como métrica oficial de produção. Salva `features_report`.

3. **arena-modeler-classic** — ML clássico (GBM, linear, trees, SVM, stacking L1). Calibração leakage-proof (IsotonicRegression fit em train, predict em OOF — nunca `iso.fit(oof,y).predict(oof)`). Sem `scale_pos_weight`/`class_weight` para AUC. `_results.json` obrigatório com `fold_scores` + `train_score`. `_prod.pkl` = 1 modelo refitado em 100% não-OOT. Salva `modeler-classic_report_roundN` com `notes`.

4. **arena-modeler-advanced** — ML de ponta (MLP, TabNet, FT-Transformer, TabPFN, AutoML, stacking multi-nível, entity embeddings). Reinstanciar modelo do zero a cada fold (`set_seed(42 + fold)`), nunca compartilhar pesos. Auto-rejeição se `train_val_gap > 0.08`. Mesmas regras de calibração/prod/notes.

5. **arena-modeler-creative** — terceiro time, **diversidade**. Métrica de sucesso é decorrelação (Spearman OOF corr <0.85 vs top-1). Território: DAE (swap noise), mRMR agressivo, target permutation, monotonic constraints, blending Bayesiano, SHAP interactions. Só ativo em MEDIUM/LARGE. `notes` obrigatório (cross-pollination é seu canal principal). Salva `modeler-creative_report_roundN` com métrica de decorrelação.

6. **reporter** — consolida a competição, escreve o relatório final. Read-only para artefatos de modelo. **Ensemble final por Nelder-Mead/SLSQP** sobre OOF dos top-5 mais decorrelacionados (descarta pares |corr|≥0.95). **OOT holdout como métrica oficial de produção** (carrega `_prod.pkl` do vencedor, prediz no OOT, computa AUC/Brier/ECE; se AUC OOT cai >5pp vs CV → concept drift severo). Distinção single vs ensemble pelo critério "estatisticamente justo". Salva `arena_report` + `competition_timeline`.

---

## 11. Dashboard e APIs

**Porta 3334** (default, overridável via `--port`/`FORMIGA_DASHBOARD_URL`). HTTP server node nativo (sem framework) servindo uma SPA React (buildada por Vite) + REST API + servidor MCP embutido.

### O que mostra

- **Pipeline Flow** — DAG gráfico ao vivo da execução dos agentes; clique num nó revela insights, código gerado e logs.
- **Leaderboard** — ranking de todos os modelos com métricas task-adaptive (classification: accuracy/f1/precision/recall/AUC; regression: RMSE/MAE/R²). Mostra a classe real do algoritmo (ex: `LogisticRegression (Poly)`).
- **Command Center** — controle de runs (pause/resume/cancel), logs ao vivo (SSE).
- **Winner Consolidation** — coroa o vencedor e compila o relatório final quando a Arena converge.

### Endpoints principais

- `GET /api/runs`, `/api/runs/:id` — lista/detalhe de runs.
- `GET /api/runs/:id/agent-artifacts/:key` — ler artefato (usado por `read_artifact`).
- `POST /api/runs/:id/agent-artifacts/:key` — salvar artefato (usado por `save_artifact`).
- `GET /api/leaderboard`, `/api/leaderboard/agent-history`, `/api/leaderboard/current-best` — queries do leaderboard.
- `GET /api/arena/:runId/{session,rounds,convergence}` — estado da arena.
- `GET /api/events`, `/api/logs-tail` — eventos globais (SSE).
- `POST/GET/DELETE /mcp`, `GET /mcp/info` — servidor MCP embutido.

### Control plane (porta 3339)

API de scheduling run-scoped separada — qual agente está polling, dispatch de work sessions. CLI: `formiga control-plane start|stop|status`.

---

## 12. Padrões arquiteturais

| Padrão | Aplicação |
|---|---|
| **Claim-based scheduling** | Steps no banco com `status: pending`; agents atomically claimam via `updateMany WHERE status='pending'`. Race-safe, crash-safe. |
| **Repository Pattern** | `LeaderboardRepositoryImpl`/`ArenaRepositoryImpl` isolam o SQLite da lógica de negócio. |
| **Interface Segregation (ISP)** | `LeaderboardReadonly`/`ArenaReadonly` separados das interfaces de escrita; `IArenaService` segregado de `ILeaderboardService`. |
| **Dependency Inversion** | Services recebem repositórios injetados; handlers dependem de interfaces de service. |
| **Additive Migration** | `PRAGMA table_info()` introspection — `ALTER TABLE ADD COLUMN` só se a coluna não existe. Bancos antigos não quebram. |
| **Template Substitution** | Chaves `{{...}}` resolvidas no YAML para passar caminhos/contexto entre steps. |
| **Sidecar JSON** | `_results.json` separado do stdout — o harness normaliza o stdout e pode descartar linhas; o sidecar é o canal determinístico. |
| **Ledger append-only** | `Experiment` com `verdict_locked_at` — o verdict é imutável após commit. |
| **Pre-write audit** | Gates de qualidade rodam ANTES de persistir, não depois. |
| **Determinism** | `random_state=42` obrigatório; `split.pkl` imutável; re-execução bit-idêntica verificada por MD5. |
| **Read-only audit** | Agentes de auditoria/report não mutam artefatos de modelo. |
| **Territory segregation** | Os 3 times da arena têm territórios distintos para maximizar diversidade. |

---

## Decisões técnicas que sustentam o sistema

1. **Dataset signature é computada no runner, não nos agentes** — garante determinismo e que todos usam a mesma signature (warm-start cross-run).
2. **Workspace isolado por run** — evita poluição do diretório raiz e permite auditoria.
3. **Baseline definido pelo feature-engineer, não pelos modelers** — garante um piso honesto e comparável.
4. **Leaderboard usa `val_metric` como score primário** — o auditor/o reporter podem avaliar com teste/OOT depois, mas a classificação é por validação.
5. **Schema é additive** — novas colunas podem ser adicionadas sem destruir bancos antigos.
6. **MCP embutido no dashboard** — uma única porta serve SPA + REST + MCP; sem serviço separado.
7. **Toda leitura é tool** — `read_artifact`, `query_leaderboard`, `query_arena`; zero `curl` nos personas.
8. **O `Experiment` é o journal** — uma tabela dobra como leaderboard e ledger append-only, em vez de duas fontes de verdade.
