# Issues de Implementação — Port da Expertise do agentic-ml

**Spec de referência:** [agentic-ml-port-specs.md](agentic-ml-port-specs.md)
**Estudo:** [agentic-ml-expertise-port.md](agentic-ml-expertise-port.md)

Convenção: `[B]` bloqueia, `[P]` paralelo, `[D]` depende de. Numeração = ordem sugerida de execução dentro do caminho crítico.

---

## Caminho crítico: Rigor estatístico (F1 → F2 → F3)

### ISSUE-01 — Estender `_results.json` com folds e artefatos de calibração
**Tipo:** feature · **Risco:** baixo · **Depende de:** — · **Bloqueia:** ISSUE-02, ISSUE-08, ISSUE-09

**Contexto:** Nadeau-Bengio, ensemble por OOF e gate de overfitting precisam de dados por-fold que hoje não existem. O `benchmark_runner.py` é o único ponto determinístico — não confiar no script do agente.

**Escopo:**
- [ ] Estender o schema de `_results.json` exigido em `buildPromptsForRound` (`src/arena/arena-engine.ts:438-490`) com: `fold_scores: number[]`, `train_score: float`, `oof_path: string`, `prod_path: string|null`, `brier_raw`, `brier_calibrated`, `ece_calibrated`.
- [ ] `benchmark_runner.py` (gerado pelo feature-engineer) computa e **sobrescreve** `fold_scores` e `train_score` a partir da própria CV — não confia no que o agente escreve.
- [ ] `validateSubmissionSidecar` (`src/leaderboard/sidecar-schema.ts`) valida os novos campos.
- [ ] Atualizar `ArenaExperiment` type + `fromArenaExperiment` (`src/leaderboard/repository.ts`) para persistir os novos campos.

**Critério de aceite:** um experimento arena com `_results.json` válido persiste `fold_scores` não-vazio no `Experiment`; um JSON sem `fold_scores` faz a rodada falhar com `[no_folds]`.

**Arquivos:** `src/arena/arena-engine.ts`, `src/leaderboard/repository.ts`, `src/leaderboard/sidecar-schema.ts`, persona `feature-engineer/AGENTS.md`.

---

### ISSUE-02 — `auditExperiment()` pré-escrita no path da arena
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-01 · **Bloqueia:** ISSUE-03

**Contexto:** Hoje `registerArena` (`src/arena/arena-engine.ts:274`) escreve sem auditoria; `makeDecision` (arena-decision.ts) é pós-métrica. O `critic-processor` existe mas roda no path de step. Spec §3.

**Escopo:**
- [ ] Criar `src/arena/audit.ts` com `auditExperiment(entry, sessionConfig, tier)` rodando gates G1–G9 (specs §3.2).
- [ ] Chamar antes de `registerArena` em `arena-engine.ts`; só escrever se não-DUPLICATE.
- [ ] REJECTED é escrito no ledger com `reject_reason` (não descartado). Budget excedido = REJECTED `[budget]` e conta como slot.
- [ ] Mapear verdict → `status`: keep→AUDITED, warn→SUCCESS, rejected/crash→FAILED, checks_failed→OVERFITTED (specs §1.4).
- [ ] Tests: cada gate com caso REJECTED/WARN/pass.

**Critério de aceite:** experimento com gap de overfit excede threshold vira REJECTED `[overfit]` no ledger antes de aparecer como `keep`; ledger mostra o motivo.

**Arquivos:** `src/arena/audit.ts` (novo), `src/arena/arena-engine.ts`, `src/arena/arena-decision.ts`, `src/arena/arena-repository.ts`.

---

### ISSUE-03 — `content_hash` de features+split+config no `Experiment` e `ArenaSession`
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-02 · **Bloqueia:** —

**Contexto:** `dataset_signature` existe para warm-start cross-run, mas não garante que dois experimentos comparados usaram o mesmo dataset processado. Spec §1.5.

**Escopo:**
- [ ] Feature-engineer computa `content_hash = MD5(features.parquet ‖ split.pkl ‖ benchmark_config.json)` e salva em `features_metadata`.
- [ ] Adicionar `content_hash String?` ao `Experiment` e `ArenaSession` (migration Prisma).
- [ ] `ArenaSession` carrega o hash na criação; `auditExperiment` G2 rejeita mismatch com `[stale]`.
- [ ] Manter `dataset_signature` intacto (propósito distinto: warm-start).

**Critério de aceite:** rodar a arena com features regeradas (hash diferente) rejeita experimentos antigos pendentes como `[stale]`; warm-start ainda funciona por `dataset_signature`.

**Arquivos:** `prisma/schema.prisma`, `src/leaderboard/repository.ts`, `src/arena/arena-engine.ts`, persona `feature-engineer/AGENTS.md`.

---

## Rigor estatístico (comportamental, paralelo)

### ISSUE-04 — Diretivas de calibração leakage-proof nos persona files
**Tipo:** docs/behavior · **Risco:** baixo · **Depende de:** — · **Paralelo a:** tudo

**Contexto:** Spec §2.3, §2.4. Modelers não calibram; ausência total.

**Escopo:**
- [ ] Adicionar aos `AGENTS.md` de `arena-modeler-classic` e `arena-modeler-advanced`: bloco de calibração (Isotonic/Platt/Beta) com a regra de ouro anti-leakage verbatim (`fit` em train_probs, `predict` em oof; nunca `iso.fit(oof,y).predict(oof)`).
- [ ] Adicionar regra "sem `scale_pos_weight`/`class_weight` para AUC".
- [ ] Exigir save de `_raw.pkl`, `_calibrated.pkl`, `_oof.npy` (referenciados em ISSUE-01).

**Critério de aceite:** persona files contêm as diretivas; smoke de uma rodada arena produz `_oof.npy`.

**Arquivos:** `workflows/ml-autoresearch/agents/arena-modeler-classic/AGENTS.md`, `.../arena-modeler-advanced/AGENTS.md`.

---

### ISSUE-05 — ECE com quantile bins no auditor
**Tipo:** feature · **Risco:** baixo · **Depende de:** ISSUE-01 · **Paralelo a:** ISSUE-02

**Contexto:** Spec §2.5. Detecção de calibração saturada (bug ECE≈0).

**Escopo:**
- [ ] No `audit.ts` (ou helper), computar ECE com bins de quantil a partir de `_oof.npy` + labels.
- [ ] Flags: `n_unique_probs < 50` → `[cal_leak]`; `ece < 1e-6` → `[cal_leak]`.
- [ ] Portar ECE quantile minimalista em TS (ou chamar helper Python via runner).

**Critério de aceite:** OOF com probs colapsadas (ex: só 2 valores) é rejeitado `[cal_leak]`.

**Arquivos:** `src/arena/audit.ts`.

---

## Imutabilidade do ledger

### ISSUE-06 — `verdict_locked_at` + imutabilidade de verdict no repo
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-02 · **Paralelo a:** ISSUE-03

**Contexto:** Spec §1.4. `Experiment` absorve o journal; verdict deve ser imutável.

**Escopo:**
- [ ] Adicionar `verdict_locked_at DateTime?` e `notes String?` ao `Experiment` (migration).
- [ ] `LeaderboardRepositoryImpl`: UPDATE de `decision/status/reject_reason/rejected_at/promoted_at/verdict_locked_at` rejeita (throw) se `verdict_locked_at !== null`.
- [ ] `auditExperiment` seta `verdict_locked_at = now()` ao gravar.
- [ ] Auditoria de consumo: garantir que `dashboard.ts`/`api.ts` não UPDATE nesses campos (só read/display).
- [ ] Campos de display futuros → coluna `display_flags JSON` mutável (não-ledger).

**Critério de aceite:** após lock, tentativa de mudar `decision` lança erro; dashboard continua renderizando.

**Arquivos:** `prisma/schema.prisma`, `src/leaderboard/repository.ts`, `src/server/dashboard.ts`, `src/dashboard/src/api/api.ts`.

---

## Feature engineering determinístico

### ISSUE-07 — `feature_quality_gate.py` com 10 gates bloqueantes
**Tipo:** feature · **Risco:** médio · **Depende de:** — · **Paralelo a:** ISSUE-01

**Contexto:** Spec §6.1. O formiga lista técnicas mas não valida.

**Escopo:**
- [ ] Criar `feature_quality_gate.py` (template que o feature-engineer instancia) com G1–G10 (specs §6.1).
- [ ] `benchmark_runner.py` chama o gate antes de aceitar features; falha → step `features` falha (`on_fail: escalate_to_human` já no workflow.yml).
- [ ] Bloco de determinismo (§6.2) no persona + env vars no spawn (`trainScript`, arena-engine.ts:46-84): `PYTHONHASHSEED=42`.
- [ ] Gate G10 (bit-identical) executa 2× e compara MD5.

**Critério de aceite:** features com coluna >95% dominante falham a step; re-execução produz MD5 idêntico.

**Arquivos:** `workflows/ml-autoresearch/agents/feature-engineer/AGENTS.md`, novo template de script, `src/arena/arena-engine.ts` (env vars no spawn).

---

### ISSUE-08 — Adversarial validation gate (bloqueante)
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-07 · **Paralelo a:** —

**Contexto:** Spec §6.3. Maior ROI anti-leakage; captura `order_status` pós-evento.

**Escopo:**
- [ ] No `feature_quality_gate.py`, treinar LightGBM train-vs-holdout.
- [ ] Thresholds: ≤0.55 IID, 0.55–0.70 drift, 0.70–0.80 WARN drop vazados, >0.80 FAIL.
- [ ] Output do gate lista colunas suspeitas para o feature-engineer agir.

**Critério de aceite:** dataset com coluna pós-evento → AUC >0.80 → step `features` falha com lista de suspeitos.

**Arquivos:** `feature_quality_gate.py`, persona `feature-engineer/AGENTS.md`.

---

### ISSUE-09 — Target encoding leakage-proof (comportamental)
**Tipo:** docs/behavior · **Risco:** baixo · **Depende de:** — · **Paralelo a:** ISSUE-07

**Contexto:** Spec §6.4. O formiga diz "Bayesian Target Encoding" sem guardrail.

**Escopo:**
- [ ] No `AGENTS.md` do feature-engineer: `TargetEncoder(cv=5, smooth="auto")` ou `CatBoostEncoder`; nunca fit global pré-split; `GLMMEncoder` para cardinalidade extrema+linear; fit-per-fold.
- [ ] Referência Kapoor & Narayanan 2023.

**Critério de aceite:** persona contém a regra; gate G8 (leakage CV-interno) do ISSUE-07 valida fit-per-fold.

**Arquivos:** `workflows/ml-autoresearch/agents/feature-engineer/AGENTS.md`.

---

## Diversidade & ensemble

### ISSUE-10 — Terceiro time `arena-modeler-creative`
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-01 (precisa OOF) · **Paralelo a:** —

**Contexto:** Spec §5.1. Só 2 times; sem diversidade forçada.

**Escopo:**
- [ ] Persona files: `workflows/ml-autoresearch/agents/arena-modeler-creative/{AGENTS,IDENTITY,SOUL}.md`.
- [ ] `workflow.yml`: declarar agente (modelar nos existentes, workflow.yml:62-88).
- [ ] `arena-workflow.ts`: adicionar a `ARENA_AGENTS` (arena-workflow.ts:36-60) com `strategyHint` de decorrelação (meta: Spearman OOF corr < 0.85 vs top-1).
- [ ] Território: DAE, entity embeddings, mRMR agressivo, target permutation, monotonic constraints, blending Bayesiano, SHAP interactions.
- [ ] **Gate de ativação:** só spawnar em tier MEDIUM/LARGE (`dataset-context.ts`).

**Critério de aceite:** arena em dataset MEDIUM roda 3 times; em TINY roda só 2.

**Arquivos:** `workflows/ml-autoresearch/workflow.yml`, `workflows/ml-autoresearch/agents/arena-modeler-creative/*`, `src/arena/arena-workflow.ts`, `src/arena/arena-engine.ts`.

---

### ISSUE-11 — Ensemble Nelder-Mead sobre OOF no reporter
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-01, ISSUE-10 · **Paralelo a:** —

**Contexto:** Spec §5.2. Reporter só resume; sem composição de ensemble.

**Escopo:**
- [ ] Step `report` (ou novo step `audit` em workflow.yml) carrega `_oof.npy` dos top-5 keep/warn.
- [ ] Selecionar menor correlação média de Spearman; otimizar pesos `w ∈ Δ^4` via `scipy.optimize.minimize(method='Nelder-Mead')`, constraint `max_pair_corr < 0.95`.
- [ ] Persistir como `Experiment` (`agent_name: "ensemble"`, `prod_artifact_key: null`).
- [ ] Implementar em script Python invocado pelo reporter (harness), não em TS.

**Critério de aceite:** com ≥2 OOFs decorrelacionados, relatório inclui ensemble com pesos e métrica blend.

**Arquivos:** `workflows/ml-autoresearch/agents/reporter/AGENTS.md`, `workflows/ml-autoresearch/workflow.yml`, novo script Python.

---

### ISSUE-12 — OOT holdout como métrica oficial de produção
**Tipo:** feature · **Risco:** médio · **Depende de:** ISSUE-01, ISSUE-13 · **Paralelo a:** —

**Contexto:** Spec §5.3. Arena mede só CV.

**Escopo:**
- [ ] Feature-engineer produz `holdout/` obrigatório (período temporal futuro OU split estratificado reservado, nunca em CV).
- [ ] Step `audit` pós-arena carrega `_prod.pkl`, prediz no OOT, computa AUC/Brier/ECE.
- [ ] AUC OOT cai >5pp vs CV → caveat no relatório.
- [ ] **Fallback:** sem dimensão temporal → holdout estratificado; OOT best-effort, não-bloqueador.

**Critério de aceite:** relatório final mostra métrica OOT; drift >5pp gera caveat visível.

**Arquivos:** persona `feature-engineer/AGENTS.md`, `workflows/ml-autoresearch/workflow.yml`, persona `reporter/AGENTS.md`.

---

### ISSUE-13 — `_prod.pkl` via `build_production_model`
**Tipo:** feature · **Risco:** baixo · **Depende de:** ISSUE-01 · **Paralelo a:** ISSUE-04

**Contexto:** Spec §5.4, §6.4. Modelers salvam modelo de fold; sem distinção CV vs produção.

**Escopo:**
- [ ] Persona files dos modelers: single-estimators produzem `_prod.pkl` (1 modelo refitado em 100% não-OOT) via `build_production_model`; blends/stackings declaram `prod_artifact_key = null`.
- [ ] `promoted_at` só setado em experimento com `prod_artifact_key` válido.

**Critério de aceite:** experimento promoted tem `_prod.pkl`; blend tem `prod_artifact_key = null` e não é `promoted`.

**Arquivos:** `workflows/ml-autoresearch/agents/arena-modeler-*/AGENTS.md`, `src/arena/audit.ts`.

---

## Cross-pollination

### ISSUE-14 — `notes` como canal de ledger visível no próximo round
**Tipo:** feature · **Risco:** baixo · **Depende de:** ISSUE-06 · **Paralelo a:** —

**Contexto:** Spec §4. `learned`/`next_focus` existem mas não são injetados como sugestão ao outro time.

**Escopo:**
- [ ] Adicionar `notes String?` ao `Experiment` (incluído em ISSUE-06 migration).
- [ ] `buildPromptsForRound` (arena-engine.ts:389-402) injeta `### Sugestões do outro time\n{notes}` lendo do `Experiment` do round anterior.
- [ ] Persona files: instruir modelers a preencher `notes` dirigido ao outro time.

**Critério de aceite:** round N+1 mostra sugestão do time adversário preenchida no round N.

**Arquivos:** `src/arena/arena-engine.ts`, persona `arena-modeler-*/AGENTS.md`.

---

## Cross-pollination (persona data-analyst)

### ISSUE-15 — EDA: alinhar diretivas anti-leakage e hipóteses acionáveis
**Tipo:** docs/behavior · **Risco:** baixo · **Depende de:** — · **Paralelo a:** ISSUE-07

**Contexto:** Spec implícito (estudo §3). EDA do formiga é sólido mas pode portar: point-biserial >0.70 leakage flag, Cramer's V/Theil's U, KS drift temporal, ≥5 hipóteses acionáveis.

**Escopo:**
- [ ] No `AGENTS.md` do data-analyst: adicionar point-biserial >0.70 como flag de leakage, Cramer's V (cat-cat) e Theil's U (cat→target), KS para drift temporal.
- [ ] Exigir ≥5 hipóteses acionáveis na seção `feature_engineering_hypotheses`.

**Critério de aceite:** EDA reporta Theil's U para categóricas e flag de leakage point-biserial.

**Arquivos:** `workflows/ml-autoresearch/agents/data-analyst/AGENTS.md`.

---

## Backlog (não-planejado, pós-port)

- **ISSUE-B1** — Port do `deploy-engineer` (empacotamento `deploy/{dataset}/vN/` + smoke test). Só após ISSUE-13. Fora do escopo atual (specs §8).
- **ISSUE-B2** — Leaderboard ao vivo destacando o modelo promoted (⭐) no dashboard React. Hoje `critic-processor` já marca; falta UI.
- **ISSUE-B3** — Unificar path de step e path de arena (hoje `critic-processor` roda num, `auditExperiment` no outro). Dívida técnica de duplo path.

---

## Ordem de execução recomendada

```
Sprint 1 (crítico):  ISSUE-01 → ISSUE-02 → ISSUE-03
                     ISSUE-04 (paralelo, baixo risco)
Sprint 2:            ISSUE-06, ISSUE-05, ISSUE-07, ISSUE-09 (paralelos)
Sprint 3:            ISSUE-08 (dep ISSUE-07), ISSUE-13 (dep ISSUE-01)
Sprint 4:            ISSUE-10 → ISSUE-11, ISSUE-12 (diversidade)
                     ISSUE-14, ISSUE-15 (paralelos, baixo risco)
```

**Definição de pronto do port:** todos os 10 critérios de aceite do specs §7 passando.
