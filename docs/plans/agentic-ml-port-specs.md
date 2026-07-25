# Specs — Port da Expertise do agentic-ml para o Formiga

**Status:** Spec (referência de implementação)
**Data:** 2026-07-24
**Companion:** [agentic-ml-expertise-port.md](agentic-ml-expertise-port.md) (estudo comparativo)
**Decisão de arquitetura central:** o `Experiment` table absorve o comportamento do `journal.jsonl` (ver §1).

---

## 0. Glossário de termos cruzados

| Termo agentic-ml | Termo formiga | Notas |
|---|---|---|
| `journal.jsonl` entry | `Experiment` row | Mesmo conceito: uma linha por experimento. |
| `verdict` (APPROVED/WARN/REJECTED) | `decision` (keep/discard/crash) + `status` (SUCCESS/AUDITED/FAILED/OVERFITTED) | Formiga tem dois campos; unificar (§1.4). |
| `auto_critic.audit()` síncrono pré-escrita | `critic-processor` pós-step | Formiga já tem o conceito, mas no path de step, não no path da arena (§1.3). |
| `content_hash_features` | `dataset_signature` | Já existe; estender para hash de features+split (§1.5). |
| `notes` (cross-pollination) | `learned` + `next_focus` | Já existe por agente; promover a campo de ledger visível (§4). |
| `nadeau_bengio` | `confidence_score`/`confidence_band` (MAD) | Formiga já tem scoring de confiança; falta o teste de significância (§2.1). |
| `train_val_gap` | `train_metric` + `val_metric` | Já existe; falta o gate (§2.2). |
| `_prod.pkl` | `artifact_path` (modelo de fold) | Falta a distinção CV vs produção (§6.4). |
| OOT holdout | — | Ausente; adicionar (§6.3). |
| `modeler-creative` | — | Ausente; adicionar 3º time (§5.1). |

---

## 1. Decisão de arquitetura: o `Experiment` absorve o journal

### 1.1 Pergunta

> O `Experiment` pode absorver o comportamento do `journal.jsonl`?

### 1.2 Resposta: **Sim, e deve.**

O `journal.jsonl` do agentic-ml é **uma linha por experimento**, append-only, com schema rico (hypothesis, result, significance, verdict, artifact_paths, content_hash, notes). O `Experiment` do formiga **já é uma linha por experimento** com a maioria desses campos: `hypothesis`, `learned`, `next_focus`, `train_metric`/`val_metric`, `confidence_score`/`confidence_band`, `reject_reason`/`rejected_at`, `dataset_signature`, rich metrics. São o mesmo conceito.

### 1.3 Por que absorver (não criar tabela separada)

1. **Mesma cardinalidade.** Uma entrada de journal = um experimento = uma linha de `Experiment`. Não há relação 1:N a justificar uma tabela à parte.
2. **O dashboard já consome `Experiment`.** Criar `ExperimentAudit` paralela introduz dupla fonte de verdade e requer refator do dashboard (`src/server/dashboard.ts`, `src/dashboard/src/api/api.ts`).
3. **O agentic-ml não tem revisões.** O journal é one-shot: um experimento é escrito uma vez, com verdict, e nunca reescrito. Não há histórico de revisões que justifique append-only em tabela separada.
4. **Já existe metade do mecanismo.** `critic-processor.ts` já faz auto-reject/auto-audit pós-step via `repository.reject()`/`autoAudit()`, e o `status` já transita `PENDING → SUCCESS/AUDITED/FAILED/OVERFITTED`. O que falta é (a) trazer isso para o path da arena (hoje só roda no path de step) e (b) tornar o verdict imutável.

### 1.4 O que "absorver" significa concretamente

O `Experiment` vira o ledger append-only **do verdict**. Regras:

| Campo | Mutável? | Quando |
|---|---|---|
| `decision`, `status`, `reject_reason`, `rejected_at`, `promoted_at`, `verdict_locked_at` (novo) | **Imutável após `verdict_locked_at` setado** | O auditor (`auditExperiment`) seta `verdict_locked_at = now()` ao gravar o verdict. UPDATEs posteriores nesses campos são rejeitados em nível de repo. |
| `train_metric`, `val_metric`, rich metrics, `fold_scores` (novo), `hyperparameters`, `hypothesis`, `learned`, `next_focus`, `notes` (novo) | **Imutáveis** | Escritos uma vez no `registerArena`. |
| Campos de display (destaque no leaderboard, ordenação custom) | Mutáveis | Se surgirem, moram em coluna separada (`display_flags` JSON) — nunca nos campos de ledger. |

**Unificação de verdict:** hoje há redundância entre `decision` (keep/discard/crash/checks_failed — path arena) e `status` (PENDING/SUCCESS/AUDITED/FAILED/OVERFITTED — path step). Spec: `decision` passa a ser a fonte canônica no path arena, mapeando para `status`:

```
keep        → status = AUDITED (promovido)
warn        → status = SUCCESS (mantido com ressalva)
rejected    → status = FAILED + reject_reason preenchido
crash       → status = FAILED (exit code != 0)
checks_failed → status = OVERFITTED (gates falharam)
```

### 1.5 `dataset_signature` → `content_hash`

Hoje `dataset_signature` é hash de colunas+rows (bom para warm-start cross-run). O `content_hash_features` do agentic-ml é MD5 de `features.parquet ‖ split.pkl ‖ config` — garante que dois experimentos comparados usaram o **mesmo dataset processado**, não só o mesmo dataset raw.

Spec: adicionar `content_hash String?` ao `Experiment` (e `ArenaSession`), computado pelo feature-engineer. O auditor rejeita (`[content_hash] mismatch`) qualquer experimento cujo hash não bate com o da sessão. Mantém `dataset_signature` para warm-start (são propósitos distintos: warm-start cross-run vs integridade intra-run).

---

## 2. Rigor estatístico

### 2.1 Nadeau-Bengio (spec funcional)

**Requisito:** a decisão `keep` só ocorre se a melhoria for **estatisticamente significativa e não-trivial**.

**Fórmula (Nadeau & Bengio 2003, CV ressubamostrada):**
```
correction = 1/n_folds + (n_folds - 1)/n_folds
t = delta_mean / (delta_std * sqrt(correction) + eps)
p = two_sided_t_sf(|t|, df = n_folds - 1)
```
onde `delta_mean`/`delta_std` são a média e o desvio-padrão das diferenças **por fold** entre o candidato e o melhor atual.

**Critério de decisão (estatisticamente justo, do ml-critic):**
- `p >= 0.05` → não significante → **rejected** (é ruído de CV)
- `p < 0.05` E `delta_pp < 0.5` → significante mas trivial → **rejected**
- `p < 0.05` E `delta_pp >= 0.5` → **keep**

`delta_pp = |candidate_cv_mean - best_cv_mean| * 100` (em pontos percentuais).

**Fallback determinístico:** se `fold_scores` ausente, o `benchmark_runner.py` deve computá-lo (não confiar no script do agente). Sem folds → rejeitar com `[no_folds]` (não degradar para comparação crua).

**Local da implementação:** `src/arena/arena-decision.ts`, nova função `nadeauBengioP()`, `makeDecision()` estendida. Lib estatística: portar uma `twoSidedTSf` minimalista (não adicionar dependência pesada) ou usar `simple-statistics`/`@stdlib/stats`.

### 2.2 Gate de overfitting (train-val gap)

**Requisito:** rejeitar modelos com gap train→val excessivo.

**Thresholds por tier de complexidade** (já existe tiering em `dataset-context.ts`):
```
TINY   (<500):    gap > 0.06 → rejected [overfit]
SMALL  (500-2K):  gap > 0.05 → rejected [overfit]
MEDIUM/LARGE:     gap > 0.03 → rejected [overfit]
```
`gap = train_metric - val_metric` (classificação); para regressão, normalizar pela escala do target.

**Pré-requisito:** `train_metric` já existe no schema. O `_results.json` do agente já é exigido; estender para garantir `train_score`.

### 2.3 Calibração leakage-proof

**Requisito (comportamental, persona files):** todo modeler calibra probabilidades.

- Métodos: `IsotonicRegression` (default, N≥1k/classe), `Platt` (sigmoid), `Beta calibration` (Kull, Nelder-Mead).
- **Regra de ouro anti-leakage:** `fit` em `train_probs`/`y_train`, `predict` em `oof`. **Nunca** `iso.fit(oof, y).predict(oof)` — produz ECE ≈ 0 por saturação, não por calibração.
- Salvar `_raw.pkl`, `_calibrated.pkl`, `_oof.npy` (referenciados por `oof_artifact_key`, `prod_artifact_key` no `Experiment`).

**Requisito (estrutural):** o `benchmark_runner.py` expõe `calibrate(train_probs, y_train, oof_probs)` — contrato compartilhado, análogo ao `calibrate_and_save` do agentic-ml.

### 2.4 Regra "sem scale_pos_weight / class_weight para AUC"

**Comportamental (persona files):** AUC é métrica de ranking; reponderar não a melhora, só distorce calibração. Probabilidades honestas vêm de calibração pós-hoc.

### 2.5 ECE com quantile bins (gate)

**Requisito:** o auditor computa ECE com **bins de quantil** (não equal-width) a partir do `_oof.npy` + labels salvos. Flags:
- `n_unique_probs < 50` → colapso patológico → rejected `[cal_leak]`
- `ece < 1e-6` → suspeitosamente perfeito → rejected `[cal_leak]`

---

## 3. Auditor pré-escrita (`auditExperiment`) — o `auto_critic` do formiga

### 3.1 Posicionamento

Hoje o `critic-processor` roda **pós-step** (path de step). A arena (`registerArena`) escreve o `Experiment` **sem auditoria** — `makeDecision` é pós-métrica, sem gate. Spec: mover a auditoria para **pré-escrita no path da arena**, chamada em `arena-engine.ts:274` antes de `registerArena`.

### 3.2 Gates (em ordem, primeira REJECTED para; WARNs acumulam)

```
auditExperiment(entry, sessionConfig, tier):
  G1  [overfit]        abs(train - val) > gapThreshold(tier)        → REJECTED [overfit]
  G2  [content_hash]   entry.content_hash !== session.content_hash   → REJECTED [stale]
  G3  [no_folds]       entry.fold_scores missing/empty              → REJECTED [no_folds]
  G4  [cal_leak]       oof n_unique < 50  OR  ece < 1e-6            → REJECTED [cal_leak]
  G5  [too_good]       univariate AUC >= 0.99 (sem justificativa)   → WARN
  G6  [budget]         teamCount(entry.agent) >= maxIter            → REJECTED [budget]
  G7  [dedup]          (team, model_type, hyperparams, metric) dup  → DUPLICATE (não escreve)
  G8  [significance]   nadeau_bengio p>=0.05 OU delta_pp<0.5 vs best → WARN (não keep)
  G9  [stability]      feature stability φ < 0.75 (top-K entre folds) → WARN
  → sem REJECTED: verdict = (G8 WARN ? 'warn' : 'keep'); locked_at = now()
```

### 3.3 Transparência

Todo REJECTED é **escrito no ledger** com `reject_reason` (não descartado silenciosamente), para auditoria — análogo ao agentic-ml escrever REJECTED `[budget]` para transparência. Budget excedido conta como slot consumido.

---

## 4. Cross-pollination (`notes`)

**Requisito:** promover `learned`/`next_focus` a canal de ledger visível no próximo round.

- Hoje `buildPromptsForRound` (arena-engine.ts:389-402) injeta `myHistory` (hipótese + métrica + decision) e `othersKept` (hipótese + métrica). Spec: injetar também `notes` (sugestão explícita dirigida ao outro time), lendo do `Experiment` do round anterior.
- Adicionar campo `notes String?` ao `Experiment` (canal estruturado, distinto de `learned` que é reflexão própria).
- No prompt do próximo round: `### Sugestões do outro time\n{notes}`.

---

## 5. Diversidade & ensemble

### 5.1 Terceiro time: `arena-modeler-creative`

**Requisito:** adicionar 3º modeler dedicado a decorrelação.

- **workflow.yml:** novo agente `arena-modeler-creative` com persona files (`AGENTS.md`/`IDENTITY.md`/`SOUL.md`).
- **arena-workflow.ts:** adicionar a `ARENA_AGENTS` com `strategyHint` codificando a meta de decorrelação.
- **Território:** DAE (swap noise 15-30%), entity embeddings standalone, mRMR agressivo (~20 features), target permutation (null importance), monotonic constraints, blending Bayesiano/Dirichlet, materialização de interações SHAP.
- **Proibido:** abordagens padrão dos outros dois times.
- **Meta:** Spearman OOF corr < 0.85 vs top-1. Se iteração N não decorrelaciona, parar.
- **Gate de ativação:** só ativar em tier MEDIUM/LARGE (ROI negativo em TINY/SMALL).

### 5.2 Ensemble Nelder-Mead sobre OOF

**Requisito:** o `reporter` (ou novo step `audit`) compõe ensemble final.

- Top-5 `keep`/`warn` com menor correlação média de Spearman (sobre `_oof.npy`).
- Otimizar pesos `w ∈ Δ^4` via `scipy.optimize.minimize(method='Nelder-Mead')` maximizando métrica primária no OOF blend, constraint `max_pair_corr < 0.95`.
- Persistir como `Experiment` (`agent_name: "ensemble"`, `is_single_model: false`, `prod_artifact_key: null`).
- **Pré-requisito:** `_oof.npy` por modelo (§2.3).

### 5.3 OOT holdout como métrica oficial de produção

**Requisito:** métrica de produção = OOT, não CV.

- Feature-engineer produz `holdout/` obrigatório (período temporal futuro isolado OU split estratificado reservado, nunca visto em CV).
- Pós-arena, step `audit` carrega `_prod.pkl` (§6.4), prediz no OOT, computa AUC/Brier/ECE.
- AUC OOT cai > 5pp vs CV → concept drift severo → promover com caveat.
- OOT = métrica oficial no relatório final.
- **Fallback (sem dimensão temporal):** holdout estratificado isolado. OOT é best-effort, não bloqueador.

### 5.4 `_prod.pkl` vs `_raw.pkl`

**Requisito (comportamental + estrutural):** distinguir artifact de CV do de produção.

- `_raw.pkl` = ensemble 5-fold (valida hipótese).
- `_prod.pkl` = 1 modelo refitado em 100% não-OOT (deploy).
- Single-estimators produzem `_prod.pkl` via `build_production_model`. Blends/stackings declaram `prod_artifact_key = null`.
- `promoted_at` só é setado em experimento com `prod_artifact_key` válido.

---

## 6. Feature engineering determinístico

### 6.1 Gates bloqueantes (step `features`)

**Requisito:** `feature_quality_gate.py` rodado antes de `STATUS: done`. Falha → step `features` falha.

```
G1  colinearidade        max |Spearman| ≤ 0.95
G2  VIF                  ≤ 10
G3  adversarial AUC      train-vs-holdout ≤ 0.75 (>0.80 = FAIL severo)
G4  univariate too-good  < 0.99
G5  estabilidade Nogueira φ ≥ 0.75 (top-K estável entre folds)
G6  missing ratio        ≤ 0.70 por coluna
G7  dimensionalidade     N/p ≥ 10
G8  leakage CV-interno   todos transformers fit-per-fold
G9  near-zero variance   sem coluna >95% dominante
G10 re-execução bit-idêntica  MD5(features) reproduzível com SEED=42
```

### 6.2 Determinismo

**Comportamental (persona files) + estrutural (benchmark_runner spawn):**
- `PYTHONHASHSEED=42`, `random_state=42`.
- LightGBM: `deterministic=True, num_threads=1, force_col_wise=True`. XGBoost: `nthread=1`. CatBoost: `thread_count=1`.
- `sorted(glob(...))`.
- **Escopo:** determinismo estrito só na step `features` + gate G10. Modelers podem usar multithread no treino (ruído ±1e-4 capturado pelo Nadeau-Bengio).

### 6.3 Adversarial validation (gate bloqueante)

LightGBM train-vs-holdout: ≤0.55 IID ✅, 0.55–0.70 drift, 0.70–0.80 WARN drop vazados, >0.80 FAIL. Captura leakage pós-evento (ex: `order_status`).

### 6.4 Target encoding leakage-proof

**Comportamental:** `TargetEncoder(cv=5, smooth="auto")` (sklearn≥1.3) ou `CatBoostEncoder`. Nunca fit global pré-split. `GLMMEncoder` (Pargent 2022) para cardinalidade extrema + linear. Fit-per-fold.

---

## 7. Critérios de aceite globais (definition of done do port)

1. Um experimento `keep` no path da arena passou por `auditExperiment` pré-escrita com G1–G9.
2. `decision`/`status` imutáveis após `verdict_locked_at`; UPDATE rejeitado em nível de repo.
3. `content_hash` em todo `Experiment` da arena; mismatch = REJECTED `[stale]`.
4. Nadeau-Bengio calculado a partir de `fold_scores` (computados pelo runner, não pelo agente).
5. `_results.json` estendido com `fold_scores`, `train_score`, `oof_path`, `prod_path`, `brier_*`, `ece`.
6. Persona files dos 3 modelers + feature-engineer + data-analyst contêm as diretivas de calibração, determinismo, target encoding, sem scale_pos_weight.
7. 3º time `arena-modeler-creative` ativo em MEDIUM/LARGE.
8. Ensemble Nelder-Mead persistido como `Experiment` quando há ≥2 OOFs decorrelacionados.
9. OOT reportado no relatório final; drift >5pp gera caveat.
10. Step `features` falha se `feature_quality_gate.py` não passar.

---

## 8. Não-goals (explicitamente fora do escopo)

- Reescrever o scheduler, o modelo de claims, ou o harness (`pi`/`hermes`).
- Substituir o dashboard React.
- Chamar LLM diretamente (formiga continua spawnando harnesses).
- Portar o `deploy-engineer` (empacotamento `_prod.pkl` em `deploy/{dataset}/vN/` com smoke test) — tarefa separada, só vale a pena depois de §5.4.
- Portar o `teammate_idle.sh` (legado, supersedido pelo arena+budget).
