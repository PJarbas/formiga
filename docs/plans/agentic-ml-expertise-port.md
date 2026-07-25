# Port da Expertise Técnica do agentic-ml para o Formiga

**Status:** Estudo + proposta de adaptação (sem alterações de código ainda)
**Data:** 2026-07-24
**Autor:** Arquiteto AI Engineer (sênior)
**Fontes:**
- agentic-ml: `.claude/agents/*` + `.claude/commands/autoresearch-pipeline.md` + `autoresearch/*.py`
- formiga: `workflows/ml-autoresearch/*`, `src/arena/*`, `src/installer/*`, `prisma/schema.prisma`

---

## 1. Resumo executivo

O **agentic-ml** e o **formiga** resolvem o mesmo problema — AutoResearch de ML com modelers competindo — mas em camadas de abstração diferentes. O agentic-ml é um conjunto de **prompts + scripts Python** que rodam sobre o harness Claude Code; o formiga é uma **plataforma Node/TS** que orquestra harnesses externos (`pi`/`hermes`) via scheduler baseado em claims no banco.

O formiga já tem a **infraestrutura superior**: scheduler self-healing (medic), claim atômico com detecção de órfãos, arena com warm-start, leaderboard persistido, dashboard ao vivo, retenção de logs. O agentic-ml tem a **expertise analítica superior**: rigor estatístico (Nadeau-Bengio), gates bloqueantes síncronos (auto_critic), journal append-only com dedup/budget/content_hash, feature engineering determinístico anti-leakage, e filosofia de diversidade explícita.

**A tese deste documento:** portar a expertise analítica do agentic-ml **sem** reimplementar a infraestrutura do formiga. Adaptações necessárias porque o formiga (a) não chama LLM diretamente — spawna harnesses; (b) distribui trabalho por claims, não por mensagens; (c) os persona files são o contrato comportamental, não system prompts em código.

---

## 2. Mapeamento arquitetural lado a lado

| Conceito | agentic-ml | formiga | Veredito |
|---|---|---|---|
| **Agente** | `.claude/agents/*.md` (system prompt + tools) | Persona files (`AGENTS.md`+`IDENTITY.md`+`SOUL.md`) + `workflow.yml` | Equivalentes. Formiga é mais estruturado (3 camadas). |
| **Orquestração** | Lead humano roda `/autoresearch-pipeline` e spawna na mesma mensagem | Scheduler polling + claim atômico + direct-spawn + cron | **Formiga superior** (automação real, self-healing). |
| **Comunicação** | Filesystem (journal.jsonl, artifacts) + mensagens ao lead | DB-backed: `AgentArtifact` (mensagens + artefatos) + `Run.context` | Equivalentes em essência; formiga usa DB. |
| **Race / arena** | 3 modelers em paralelo, 5 iters cada, territórios segregados | 2 modelers em paralelo, N rounds, `makeDecision` keep/discard | Formiga tem menos times (2 vs 3) e decisão mais simples. |
| **Journal / ledger** | `journal.jsonl` append-only, atomic (fcntl+fsync), dedup, budget, content_hash, `notes` | `Experiment` table + `AgentEvent` table | **agentic-ml superior em rigor de ledger.** |
| **Gate de qualidade** | `auto_critic.py` síncrono: 9 gates bloqueantes antes de escrever no journal | `makeDecision`: keep/discard por métrica only | **agentic-ml muito superior.** Formiga só olha a métrica. |
| **Significância** | Nadeau-Bengio corrected t-test + 0.5pp floor | Nenhum — `isImprovement` é `candidate > current` | **agentic-ml superior.** |
| **Calibração** | Isotonic/Platt/Beta, leakage-proof (fit train / predict OOF) | Ausente | **agentic-ml superior.** |
| **Feature engineering** | Pipeline determinista, adversarial validation, target encoding leakage-proof, seleção híbrida | Lista de técnicas em `AGENTS.md`, sem gates | **agentic-ml superior em rigor.** |
| **Diversidade** | `modeler-creative` dedicado a decorrelação; ensemble Nelder-Mead | Apenas 2 times classic/advanced | **agentic-ml superior.** |
| **Métrica de produção** | OOT holdout oficial | CV only (sem OOT explícito no arena) | **agentic-ml superior.** |
| **Leaderboard ao vivo** | `build_leaderboard.py` HTML auto-refresh | Dashboard React (porta 3334) | **Formiga superior.** |

---

## 3. Como o AutoResearch funciona em cada lado

### 3.1 agentic-ml — fluxo autoresearch (6 fases)

```
Phase 1 Setup     → lead confirma task_type/métrica/target, cria config.json
Phase 2 Waterfall → data-analyst (EDA) → feature-engineer (features+split+baseline)
Phase 3 Bootstrap → start_race.py: content_hash, migra baseline p/ journal[0], sobe leaderboard watcher
Phase 4 Race      → 3 modelers em paralelo, até 5 iters cada; cada register_experiment()
                    → auto_critic.audit() síncrono (9 gates) → APPROVED/WARN/REJECTED
                    → append atômico no journal.jsonl; notes = cross-pollination
Phase 5 Narrator  → ml-critic: lê journal todo, audita, recomenda (Nadeau-Bengio + 0.5pp)
Phase 6 Package   → deploy-engineer: empacota _prod.pkl, smoke test obrigatório
```

**Journal entry (schema completo):**
```json
{
  "exp_id": "uuid8",
  "iteration_team": 4,
  "team": "modeler-classic",
  "hypothesis": "...",
  "category": "hyperparameter|feature_engineering|ensemble|...",
  "model_type": "lightgbm",
  "result": {
    "metric_primary": {"name":"auc","cv_mean":0.812,"cv_std":0.005,"folds":[...]},
    "metric_secondary": {"brier_raw":0.14,"brier_calibrated":0.12,"ece_calibrated":0.031,"f1":0.74},
    "train_val_gap": 0.032, "train_time_s": 47,
    "n_features_used": 78, "n_samples": 73211, "base_rate": 0.498
  },
  "significance": {"delta_vs_best": 0.008, "nadeau_bengio_p": 0.03},
  "verdict": "APPROVED|WARN|REJECTED",
  "rejection_reason": null,
  "artifact_paths": {"raw":"...","calibrated":"...","oof":"...","prod":"..."},
  "hyperparams": {...},
  "content_hash_features": "<md5>",
  "validation_strategy": "5fold_seed42",
  "notes": "..."
}
```

### 3.2 formiga — fluxo autoresearch (workflow `ml-autoresearch`)

```
eda (data-analyst)        → save_artifact("eda_report","eda_config")
features (feature-engineer) → features.parquet, split.pkl, baseline, benchmark_config.json,
                             benchmark_runner.py, autoresearch.sh
arena (arena-engine.ts)    → ArenaSession no DB; loop de rounds (default 5):
   buildPromptsForRound()  → injeta: melhor atual, histórico próprio, resultados mantidos
                             do outro time, warm-start, tier de complexidade, schema JSON
                             de métricas ricas, helpers bash da Formiga API
   runAgentsParallel()     → 2 modelers via pi --print (clássico + avançado)
   trainScript()           → spawn python3, executa script do agente, extrai métrica por regex
   makeDecision()          → keep | discard | crash  (APENAS por métrica: candidate > current)
   Experiment row          → leaderboard (f1/precision/recall/roc_auc ou mae/rmse/r2)
   convergência            → target_reached | converged (maxNoImprove) | max_rounds
report (reporter)          → relatório final
```

### 3.3 Onde o formiga diverge do agentic-ml (e por quê)

1. **Decisão é puramente métrica.** `makeDecision` (arena-decision.ts:22-32) retorna `keep` se `isImprovement(candidate, best)` — sem teste de significância, sem gap de overfitting, sem calibração, sem checagem de leakage. Um modelo com `cv_mean` 0.0001 melhor vira `keep` mesmo que estatisticamente idêntico ao anterior.

2. **Não há gate bloqueante pré-escrita.** O agentic-ml audita ANTES de escrever no journal (REJECTED consome slot). O formiga escreve o `Experiment` e decide keep/discard depois — não há REJECTED transparente com motivo, não há budget enforcement por time.

3. **Sem OOT.** O arena mede só CV. O agentic-ml trata OOT holdout como métrica oficial de produção (detecção de concept drift >5pp).

4. **Sem journal append-only com integridade.** O `Experiment` é uma linha de tabela editável; não há `content_hash_features` vinculando o experimento ao dataset exato, não há `notes` estruturado como canal de cross-pollination (existe `learned`/`nextFocus`, mas é por-agente, não no ledger compartilhado).

5. **Sem diversidade forçada.** Só 2 times, ambos perseguindo a mesma métrica. Não há time dedicado a decorrelação, nem ensemble final baseado em correlação de OOF.

---

## 4. Proposta de adaptação — por foco

Cada foco abaixo segue o princípio: **adaptar ao modelo do formiga**, ou seja, (a) expertise vai nos persona files (`AGENTS.md`) onde for comportamental, (b) rigor que precisa ser determinístico vai no `arena-engine.ts`/scripts Python onde for estrutural.

### 4.1 Rigor estatístico

#### 4.1.1 Nadeau-Bengio no lugar de `isImprovement`

**Problema atual:** `makeDecision` (arena-decision.ts:9-11) usa comparação crua. Ruído de CV vira "keep".

**Adaptação:** substituir a decisão binária por uma decisão tripla baseada em significância, mantendo a API `keep/discard/crash` (compatível com o resto do engine).

```ts
// arena-decision.ts — proposta
export function nadeauBengioP(
  deltaMean: number,     // mean(candidate) - mean(best) por fold
  deltaStd: number,      // std das diferenças por fold
  nFolds: number,
): number {
  // Fator de correção Nadeau & Bengio (2003) para CV ressubamostrada
  const correction = 1 / nFolds + (nFolds - 1) / nFolds;
  const tStat = deltaMean / (deltaStd * Math.sqrt(correction) + 1e-12);
  // p-value bicaudal via t-Student com nFolds-1 gl (usar lib estatística ou aproximação)
  return twoSidedTProb(tStat, nFolds - 1);
}

export function makeDecision(
  metric: number | null,
  bestMetric: number | null,
  direction: MetricDirection,
  baselineMetric: number | null = null,
  // NOVOS parâmetros opcionais — retrocompatíveis:
  richMetrics?: { foldScores?: number[]; bestFoldScores?: number[] },
): ArenaDecision {
  if (metric === null) return "crash";
  if (bestMetric === null && baselineMetric === null) return "baseline";
  if (bestMetric === null) return "keep";

  const improved = isImprovement(metric, bestMetric, direction);
  if (!improved) return "discard";

  // Se temos folds, aplicar significância; senão, fallback no comportamento atual
  if (richMetrics?.foldScores && richMetrics?.bestFoldScores) {
    const p = nadeauBengioP(/* delta por fold */, /* std */, foldScores.length);
    const deltaPp = Math.abs(metric - bestMetric) * 100;
    // Critério "estatisticamente justo" do ml-critic:
    // p>=0.05 (não significante) → discard (é ruído)
    // p<0.05 E delta<0.5pp → discard (significante mas trivial)
    // p<0.05 E delta>=0.5pp → keep
    if (p >= 0.05 || deltaPp < 0.5) return "discard";
  }
  return "keep";
}
```

**Pré-requisito:** o `_results.json` que o agente já produz precisa incluir `fold_scores: number[]` (já existe schema de métricas ricas no prompt — arena-engine.ts:438-490 — basta estender). Sem folds por modelo, não há Nadeau-Bengio; portanto a extensão do JSON é bloqueadora.

#### 4.1.2 Gate de overfitting (train-val gap)

**Problema atual:** nenhum. Um modelo com `train AUC 0.99 / val AUC 0.72` vira `keep`.

**Adaptação:** o `_results.json` deve incluir `train_score` além de `cv_mean`. `makeDecision` (ou um `auditExperiment()` novo) rejeita se `abs(train_score - cv_mean) > threshold` (0.03 regressão / 0.05 classificação, calibrável por tier de complexidade — datasets TINY são mais tolerantes).

Isso é o análogo formiga do gate #1 do `auto_critic` ("overfit: abs(gap) > 0.03 → REJECTED").

#### 4.1.3 Calibração leakage-proof (comportamental + estrutural)

**Problema atual:** ausente. Modelers não calibram.

**Adaptação em duas partes:**

- **Comportamental (persona files):** adicionar aos `AGENTS.md` dos dois modelers a diretiva de calibração do agentic-ml, com o alerta anti-leakage verbatim adaptado:

  > Após treinar, calibre as probabilidades com `IsotonicRegression` (default, N≥1k/classe), `Platt` (sigmoid) ou `Beta calibration` (Kull). **CRÍTICO — NUNCA fitar e prever no mesmo array OOF**: `iso.fit(oof, y).predict(oof)` é data leakage (o calibrador memoriza os rótulos via as próprias probabilidades out-of-fold), produzindo ECE ≈ 0 por saturação, não por calibração real. Sempre `fit` em `train_probs` e `predict` em `oof`.

- **Estrutural (benchmark_runner.py):** o runner que o feature-engineer gera deve expor um hook `calibrate(train_probs, y_train, oof_probs)` que os scripts dos modelers chamam, salvando `_raw.pkl`, `_calibrated.pkl`, `_oof.npy`. Isso vira o contrato da arena (análogo ao `calibrate_and_save` do agentic-ml).

#### 4.1.4 Regra "sem scale_pos_weight / class_weight"

Adicionar aos persona files (comportamental, sem código):

> **NÃO use `scale_pos_weight` nem `class_weight` para melhorar AUC.** AUC é métrica de ranking; reponderar não a melhora, só distorce a calibração. Probabilidades honestas vêm de calibração pós-hoc.

---

### 4.2 Journal / ledger

#### 4.2.1 O que portar

O `Experiment` table do formiga é editável e não tem integridade de dataset. Portar a filosofia do `journal.jsonl`:

| Feature do journal | Como adaptar no formiga |
|---|---|
| Append-only imutável | Manter `Experiment` editável para o leaderboard, mas adicionar tabela `ExperimentAudit` (ou campo `verdict` + `rejection_reason` + `locked_at`) append-only. Uma vez escrito o verdict, não edita. |
| `content_hash_features` | Campo `contentHash` no `Experiment`, calculado pelo feature-engineer (MD5 de features.parquet ‖ split.pkl ‖ config). Arena rejeita scripts cujo `contentHash` não bate com o da sessão (detecta dataset stale). |
| Dedup (`_find_duplicate`) | Antes de inserir `Experiment`, checar (team, model_type, hyperparams, metric). Duplicata → não insere, retorna DUPLICATE. Evita poluição. |
| Budget enforcement | `maxIterationsPerTeam` no `ArenaSession`. Excedido → insere como REJECTED `[budget]` para transparência (não silenciosamente descarta). |
| `notes` (cross-pollination) | Já existe `learned`/`nextFocus` por agente. Promover a campo de ledger visível no prompt do próximo round (`buildPromptsForRound` já injeta histórico). Padronizar: `notes` = "sugestão para o outro time". |
| `verdict` + `rejection_reason` | Estender `decision` de `keep/discard/crash` para `keep/warn/rejected/crash`, com `rejectionReason` (ex: `[overfit] gap 0.045 > 0.03`, `[budget]`, `[content_hash] mismatch`, `[leakage] calibrator fit on oof`). |

#### 4.2.2 Exemplo de extensão de schema (Prisma)

```prisma
model Experiment {
  // existente...
  decision        String   // keep | warn | rejected | crash
  rejectionReason String?
  contentHash     String?  // MD5(features ‖ split ‖ config)
  foldScores      String?  // JSON array, para Nadeau-Bengio
  trainScore      Float?   // para gate de overfit
  brierRaw        Float?
  brierCalibrated Float?
  eceCalibrated   Float?
  oofArtifactKey  String?  // referência ao _oof.npy no AgentArtifact
  prodArtifactKey String?  // referência ao _prod.pkl
  notes           String?  // cross-pollination
  lockedAt        DateTime? @default(now()) // append-only a partir daqui
}
```

#### 4.2.3 Gate síncrono pré-escrita (o `auto_critic` do formiga)

O agentic-ml audita ANTES de escrever. Adaptar como função `auditExperiment(entry, sessionConfig)` chamada no `arena-engine.ts` antes do `repo.insertExperiment`:

```
auditExperiment():
  gate 1 [overfit]      abs(trainScore - cvMean) > gapThreshold(tier) → REJECTED
  gate 2 [content_hash] entry.contentHash !== session.contentHash     → REJECTED [stale]
  gate 3 [leakage_cal]  oof artifact tem <50 probs únicas (saturação) → REJECTED [cal_leak]
  gate 4 [too_good]     univariate AUC ≥ 0.99 sem justificativa        → WARN
  gate 5 [budget]       teamCount >= maxIter                            → REJECTED [budget]
  gate 6 [significance] Nadeau-Bengio p>=0.05 OU delta<0.5pp vs best   → WARN (não keep)
  → primeira REJECTED para; WARNs acumulam
```

Isso transforma o `makeDecision` atual (pós-escrita, só métrica) num auditor pré-escrita com motivo transparente — exatamente o ganho de rigor do agentic-ml.

---

### 4.3 Feature engineering

O formiga já lista técnicas avançadas no `AGENTS.md` do feature-engineer (mRMR, permutation importance, RFECV, Yeo-Johnson, MICE, etc. — feature-engineer/AGENTS.md:182-194). O gap não é a lista, é a **ausência de gates bloqueantes e de determinismo**.

#### 4.3.1 Gates bloqueantes (estrutural)

Portar os 10 quality gates do agentic-ml como um `feature_quality_gate.py` que o feature-engineer deve rodar antes de `STATUS: done`. O `benchmark_runner.py` (contrato da arena) pode chamar esse gate e falhar a step `features` se não passar:

```
gate 1  colinearidade        max |Spearman| ≤ 0.95
gate 2  VIF                  ≤ 10
gate 3  adversarial AUC      train-vs-holdout ≤ 0.75 (>0.80 = FAIL severo)
gate 4  univariate too-good  < 0.99
gate 5  estabilidade Nogueira φ ≥ 0.75 (top-K features estável entre folds)
gate 6  missing ratio        ≤ 0.70 por coluna
gate 7  dimensionalidade     N/p ≥ 10
gate 8  leakage CV-interno   todos transformers fit-per-fold
gate 9  near-zero variance   sem coluna >95% dominante
gate 10 re-execução bit-idêntica  MD5(features) reproduzível com SEED=42
```

#### 4.3.2 Determinismo (comportamental + estrutural)

Adicionar ao `AGENTS.md` do feature-engineer o bloco de determinismo do agentic-ml (adaptado):

> **Determinismo obrigatório.** `PYTHONHASHSEED=42`, `random_state=42` em tudo. LightGBM: `deterministic=True, num_threads=1, force_col_wise=True`. XGBoost: `nthread=1`. CatBoost: `thread_count=1`. Sempre `sorted(glob(...))` — ordem de filesystem é não-determinística. Uma re-execução deve produzir MD5 bit-idêntico de `features.parquet`.

E no `benchmark_runner.py`, forçar essas env vars no spawn (`arena-engine.ts:46-84`, `trainScript`).

#### 4.3.3 Adversarial validation (estrutural, bloqueante)

É a técnica de maior ROI que falta. Treinar LightGBM para distinguir train vs holdout:
- AUC ≤ 0.55 → IID ✅
- 0.55–0.70 → drift leve
- 0.70–0.80 → WARN, dropar colunas vazadas
- > 0.80 → FAIL severo, abortar step `features`

Isso captura exatamente a classe de bug que o git history do formiga mostra ter acontecido (leakage de `order_status` pós-evento é o exemplo canônico no EDA). Deve ser gate bloqueante, não sugestão.

#### 4.3.4 Target encoding leakage-proof (comportamental)

O formiga diz "Bayesian Target Encoding" sem o guardrail. Portar a regra do agentic-ml:

> **Target encoding É a fonte #1 de leakage.** Sempre `TargetEncoder(cv=5, smooth="auto")` (sklearn≥1.3) ou `CatBoostEncoder` — NUNCA fitar no dataset completo antes do split. Para cardinalidade extrema + modelo linear, `GLMMEncoder` (Pargent 2022). Todo encoder é fit-per-fold dentro do CV, nunca global.

Referência: Kapoor & Narayanan 2023 (leakage por pré-split encoding é o erro #1).

---

### 4.4 Diversidade & ensemble

#### 4.4.1 Terceiro time: `modeler-creative` (comportamental + workflow)

O formiga tem 2 times. O agentic-ml tem 3, sendo o terceiro **dedicado a decorrelação**. Adicionar `arena-modeler-creative` ao `workflow.yml` e à `ARENA_AGENTS` (arena-workflow.ts:36-60), com território distinto:

- **Território:** Denoising Autoencoder (swap noise 15-30%), entity embeddings standalone, mRMR agressivo (~20 features forçando decorrelação), target permutation (null importance), monotonic constraints do EDA, blending Bayesiano/Dirichlet, materialização de interações SHAP.
- **Proibido:** abordagens padrão dos outros dois times (deve diferenciar).
- **Meta explícita:** produzir modelos com Spearman OOF corr < 0.85 vs top-1. Se a iteração N não produziu modelo decorrelacionado, parar.

O `strategyHint` (arena-workflow.ts) desse time deve codificar essa meta de decorrelação, para que `buildPromptsForRound` a injete.

#### 4.4.2 Ensemble final por Nelder-Mead sobre OOF (estrutural)

Hoje o `reporter` só resume. Portar o papel do `ml-critic` de composição de ensemble:

- Dos top-5 APPROVED, selecionar os de menor correlação média de Spearman (sobre OOF).
- Otimizar pesos `w ∈ Δ^4` via `scipy.optimize.minimize(method='Nelder-Mead')` maximizando a métrica primária no OOF blend, com constraint `max_pair_corr < 0.95`.
- Persistir como `Experiment` separado (`team: ensemble`, `is_single_model: false`).

**Pré-requisito:** os modelers precisam salvar `_oof.npy` (item 4.1.3). Sem OOF por modelo, não há ensemble por correlação.

#### 4.4.3 OOT holdout como métrica oficial (estrutural)

O arena mede só CV. Portar o conceito de OOT do agentic-ml:

- O feature-engineer já tem diretório `holdout/` (mencionado no EDA AGENTS.md:14). Torná-lo obrigatório: um período temporal futuro isolado, ou um split estratificado reservado, **nunca visto em CV**.
- Após a arena, o `reporter` (ou um novo step `audit`) carrega o `_prod.pkl` (modelo refitado em 100% não-OOT), prediz no OOT, computa AUC/Brier/ECE.
- Se AUC OOT cai > 5pp vs CV → concept drift severo, promover com caveat.
- OOT vira a métrica oficial de produção no relatório final (não CV).

#### 4.4.4 Artefato de produção `_prod.pkl` (comportamental)

Hoje os modelers salvam `modeler-X_roundN.pkl` (ensemble de fold). Portar a distinção do agentic-ml:

- **CV artifact** (`_raw.pkl`, ensemble 5-fold): valida a hipótese.
- **Production artifact** (`_prod.pkl`, 1 modelo refitado em 100% não-OOT): é o que vai para deploy. Preferido sobre fold-ensemble (1× latência/RAM, retraining de drift mais fácil).

Adicionar aos persona files: todo modeler single-estimator deve produzir `_prod.pkl` via `build_production_model`. Blends/stackings declaram `prodArtifactKey = null` (tratados como ensemble).

---

## 5. Crítica da própria proposta (limites e riscos)

1. **Nadeau-Bengio exige folds por modelo.** Se o `_results.json` não tiver `fold_scores`, o gate decai para o comportamento atual. A extensão do JSON é bloqueadora e depende do agente obedecer — não há garantia determinística sem validação no `benchmark_runner.py`. **Mitigação:** o runner deve computar e sobrescrever `fold_scores` ele mesmo (não confiar no script do agente).

2. **`makeDecision` retrocompatível é uma fachada.** Adicionar parâmetros opcionais preserva a assinatura, mas se quem chama não passar `richMetrics`, o rigor não se aplica. Melhor: tornar `richMetrics` obrigatório quando `bestMetric !== null`, e falhar a rodada se o `_results.json` estiver incompleto (forçar o contrato).

3. **Terceiro time custa tokens.** `modeler-creative` adiciona ~5 iterações de harness por arena. Em datasets pequenos o ROI pode ser negativo. **Mitigação:** gate de complexidade — só ativar creative em MEDIUM/LARGE (já existe tiering em `dataset-context.ts`).

4. **OOT nem sempre existe.** Datasets sem dimensão temporal não têm OOT "futuro". **Mitigação:** fallback para holdout estratificado isolado; documentar que OOT é best-effort, não bloqueador.

5. **Determinismo single-thread degrada performance.** `num_threads=1` em datasets LARGE pode ser proibitivo. O agentic-ml aceita isso pelo bit-identity. **Mitigação:** aplicar determinismo estrito só na step `features` e no gate de re-execução; permitir multithread no treino dos modelers (aceitando que CV-mean pode variar ±1e-4, dentro do ruído que o Nadeau-Bengio já captura).

6. **Append-only vs editabilidade do leaderboard.** O dashboard React provavelmente assume `Experiment` editável. Adicionar `lockedAt` + `ExperimentAudit` preserva a edição de campos de display mas congela o verdict. **Mitigação:** auditar o consumo do `Experiment` no dashboard antes de congelar campos.

---

## 6. Plano de implementação sugerido (fases, não executado aqui)

| Fase | Escopo | Risco | Bloqueador |
|---|---|---|---|
| **F1** | Estender `_results.json` com `fold_scores`, `train_score` + `benchmark_runner.py` validá-los | Baixo | — |
| **F2** | `auditExperiment()` pré-escrita com gates 1,2,5,6 (overfit, content_hash, budget, significância) | Médio | F1 |
| **F3** | `contentHash` no `ArenaSession` + feature-engineer o computa | Médio | F2 |
| **F4** | Persona files: calibração leakage-proof, determinismo, sem scale_pos_weight, target encoding | Baixo | — |
| **F5** | `feature_quality_gate.py` com 10 gates bloqueantes na step `features` | Médio | — |
| **F6** | Adversarial validation gate (bloqueante) | Médio | F5 |
| **F7** | `modeler-creative` (3º time) com strategyHint de decorrelação | Médio | F1 (precisa OOF) |
| **F8** | Ensemble Nelder-Mead no `reporter`/novo step `audit` | Médio | F1, F7 |
| **F9** | OOT holdout obrigatório + métrica oficial de produção | Médio | F8 |
| **F10** | `_prod.pkl` via `build_production_model` nos persona files | Baixo | F9 |

F1 → F2 → F3 é o caminho crítico (rigor estatístico sem ele é impossível). F4 é paralelo e de baixo risco. F7 → F8 → F9 é o caminho da diversidade.

---

## 7. Conclusão

O formiga tem a **infraestrutura** que o agentic-ml simulou com prompts e scripts: scheduler self-healing, claim atômico, arena persistida, dashboard ao vivo. O agentic-ml tem a **disciplina analítica** que o formiga ainda não codificou: significância estatística, gates bloqueantes, ledger com integridade, feature engineering determinístico anti-leakage, diversidade forçada, OOT como verdade de produção.

O port proposto é seletivo: a expertise vai onde ela naturalmente mora no formiga — **persona files** para o que é comportamental (calibração, determinismo, regras anti-leakage, territórios dos times) e **arena-engine / scripts Python** para o que é estrutural (gates pré-escrita, Nadeau-Bengio, content_hash, ensemble por OOF, OOT). Nenhuma das adaptações exige reescrever o scheduler ou o modelo de claims — a arquitetura do formiga absorve a expertise sem mudar de forma.

O caminho crítico é curto e bem definido: **F1 (folds no JSON) → F2 (auditor pré-escrita) → F3 (content_hash)** destrava todo o rigor estatístico. O resto é paralelizável.
