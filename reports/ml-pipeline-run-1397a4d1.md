# Relatório de Execução: ml-pipeline (Run 1397a4d1)

**Data:** 2026-07-02  
**Workflow:** ml-pipeline  
**Task:** `dataset_path=data/train.csv target_column=price`  
**Status Final:** Completado  
**Duração Total:** ~26 minutos (15:04 → 15:30)  
**Tokens contabilizados:** 0 (bug — ver Problema #2)

---

## Cronologia dos Steps

| Step | Agente | Duração | Status | Observações |
|------|--------|---------|--------|-------------|
| eda | data-analyst | ~2min | done | Completou normalmente na primeira tentativa |
| features | feature-engineer | ~3min | done | Completou normalmente |
| model-classic | modeler-classic | ~5min | done | Precisou de pause/resume para recuperar de stuck |
| model-advanced | modeler-advanced | ~5min | done | Idem |
| audit | ml-critic | ~4min | done | Falhou 1x (retry 1/2), segundo spawn resolveu |

---

## Resultados dos Agentes

### EDA (data-analyst)
- Produziu `reports/01_eda.md` com 10 seções
- Config em `artifacts/eda_config.json`
- Achado-chave: `square_feet` com r=0.9993 com target (proxy quase perfeito)
- Dataset: 10 linhas, 5 colunas, zero missing

### Features (feature-engineer)
- Feature matrix: 10 rows × 12 cols
- Split: 6/2/2 (train/val/test), seed=42
- Baseline: Ridge (CV RMSE=0.1196 log-scale, train RMSE=$5681)
- 11 técnicas de feature engineering aplicadas
- Sidecar: `feature-engineer_submission.json` ✓

### Modeler Classic (modeler-classic)
- Modelo: Ridge (alpha=1.0)
- CV RMSE: 26958.25 | Train RMSE: 5772.23
- Artefato: `artifacts/ridge-alpha1.0.pkl`
- Sidecar: `modeler-classic_submission.json` ✓

### Modeler Advanced (modeler-advanced)
- Modelo: ridge-optuna (alpha=0.001027, Optuna 30 trials)
- CV RMSE: 2199.53 | Train RMSE: 733.32
- Features: square_feet, age_squared (LassoCV selector)
- Artefato: `artifacts/advanced-ridge_optuna.pkl`
- Sidecar: `modeler-advanced_submission.json` ✓

### Audit (ml-critic)
- Avaliou 3 entradas do leaderboard contra 8 critérios
- Problemas sistêmicos detectados:
  - cvStd=0 em todas as entradas (gap no protocolo de submission)
  - Escalas mistas de métricas (baseline em log vs dólares)
  - Target leakage: `price_per_sqft` em `features.parquet`
- Resultado: todos os 3 modelos rejeitados
  - model_5 (leakage)
  - model_6 (sem ganho sobre baseline + leakage + gap train/val)
  - model_7 (gap train/val — melhor modelo, passa 7/8 checks)

---

## Problemas Identificados

### Problema 1: Steps stuck no estado "running" sem agente ativo (CRÍTICO)

**Sintoma:** Os steps `model-classic`, `model-advanced` e `audit` ficaram marcados como `[running]` mas nenhum processo de agente estava executando.

**Causa raiz:** Race condition entre spawn automático no pipeline-advance e o nudge. Os primeiros agentes spawned (PIDs 64303/64304) fizeram claim mas completaram imediatamente com `outcome=heartbeat`. Subsequentes nudges geraram novos agentes que encontraram `NO_WORK` (step já claimed) e também retornaram heartbeat.

**Evidência:**
```
03:10 PM  modeler-classic  agent.spawned (PID 64304)
03:10 PM  modeler-classic  Claimed step
03:10 PM  modeler-classic  agent.completed (outcome=heartbeat)  ← completou sem fazer nada
```

**Workaround usado:** `formiga workflow pause` + `formiga workflow resume` reseta steps stuck para `[pending]`.

**Impacto:** Sem intervenção manual, o run ficaria eternamente stuck. O Medic detecta esse cenário mas com delay de ~1h.

**Sugestão de fix:**
- Implementar watchdog baseado em liveness do PID com janela curta (30s-60s)
- Quando um step está claimed mas o PID não existe, resetar automaticamente
- Investigar por que os primeiros spawns falham silenciosamente (stdout excedeu buffer capacity: "pi output exceeded buffer capacity — only tail retained")

---

### Problema 2: Tokens = 0 durante toda a execução (ALTO)

**Sintoma:** `tokens_spent` do run permanece em 0 do início ao fim, embora os agentes tenham processado trabalho significativo.

**Causa raiz provável:** O parser de output (`polling-parser.ts`) não está conseguindo extrair o token usage do output do pi. Logs mostram `totalBytesIngested: 824727` mas `linesDropped: 794` — o output é truncado pelo buffer e os metadados de token usage provavelmente estão no início (que foi descartado).

**Impacto:** Impossível rastrear custos, impossível fazer budget enforcement.

**Sugestão de fix:** Extrair token usage dos metadados JSON do pi antes do buffer overflow, ou usar disk streaming para preservar metadados independente do tamanho do output.

---

### Problema 3: Dashboard — Abas vazias após run completar (ALTO)

**Sintoma:** As abas "Model Arena" (Leaderboard) e "Experiment Board" (Kanban) não mostram nenhum dado após o run completar com sucesso.

**Causa raiz:** A função `findActivePipelineRunId()` em `src/server/pipeline-status.ts:228` filtra por `status IN ('running', 'paused')`. Quando o run completa, retorna `null` e todos os endpoints que dependem dela retornam arrays vazios.

```typescript
// pipeline-status.ts:231-237
const row = await prisma.run.findFirst({
  where: { status: { in: ["running", "paused"] } },  // ← exclui "completed"
  orderBy: { created_at: "desc" },
});
```

**Impacto:** O leaderboard tem 3 experimentos registrados (IDs 5, 6, 7) mas são invisíveis na UI. O kanban tem dados (verificado via API direta com runId) mas a navegação padrão não resolve para um run completado.

**Sugestão de fix:**
- Alterar `findActivePipelineRunId` para incluir runs completed recentemente (ex: último run independente do status)
- Ou: adicionar seletor de run no dashboard para que o usuário possa navegar para runs passados
- Alternativamente: fallback para o run mais recente quando não há run ativo

---

### Problema 4: Control-plane reportado como DOWN mas respondendo (BAIXO)

**Sintoma:** `formiga status` exibe `Control-plane: DOWN` mas `curl localhost:3339/control/health` retorna `{"status":"ok"}`.

**Causa provável:** O health check do status command pode estar usando um timeout muito curto ou verificando o processo errado.

---

### Problema 5: Exit code 143 (SIGTERM) após step completar (COSMÉTICO)

**Sintoma:** Agentes mostram `agent.failed (pi failed: exited with code 143)` DEPOIS de terem completado o step com sucesso.

**Evidência:**
```
03:30 PM  ml-critic  Step completed
03:30 PM  Run completed
03:30 PM  ml-critic  agent.failed (pi failed: exited with code 143)
```

**Causa:** O processo pi continua rodando após o step complete (possivelmente fazendo cleanup) e recebe SIGTERM do scheduler/parent. O código 143 = 128 + 15 (SIGTERM).

**Impacto:** Confunde logs, pode acionar alertas falsos.

**Sugestão:** Tratar SIGTERM pós-completion como evento normal (`agent.terminated`) em vez de `agent.failed`.

---

### Problema 6: `outcome=other_output` no modeler-classic (BAIXO)

**Sintoma:** O modeler-classic completou o step mas o polling-parser classificou o outcome como `other_output` em vez de `work_done`.

**Causa:** O output do agente não continha exatamente `STATUS: done` no formato esperado pelo regex `/STATUS:\s*done/i`. Provavelmente o pi's report tool reformatou o output.

**Impacto:** Funcional — o step foi completado corretamente. Mas a classificação errada pode afetar métricas/alertas.

---

### Problema 7: `ingestStepOutput` chamada sem `await` (MÉDIO)

**Localização:** `src/installer/steps/complete.ts:216`

**Sintoma:** A função async `ingestStepOutput` é chamada dentro de um `try/catch` síncrono, o que significa que rejeições de Promise são unhandled.

```typescript
try {
  ingestStepOutput({...});  // ← sem await! Promise fire-and-forget
} catch (err) {            // ← nunca captura erros async
  logger.warn("Leaderboard ingest threw", ...);
}
```

**Impacto:** Neste caso específico, o ingest funcionou (3 registros criados), mas se falhasse, o erro seria silenciosamente perdido. Em situações com erro no Prisma, o leaderboard ficaria silenciosamente vazio sem nenhum log de erro.

**Sugestão:** Adicionar `await` ou converter para `.catch(err => logger.warn(...))`.

---

## Resumo de Ações Recomendadas

| Prioridade | Problema | Ação |
|------------|----------|------|
| P0 | Steps stuck | Implementar PID liveness watchdog com janela curta |
| P0 | Dashboard vazio | Alterar `findActivePipelineRunId` para incluir runs completados |
| P1 | Tokens = 0 | Preservar metadados de token no disk streaming antes de buffer overflow |
| P1 | ingest sem await | Adicionar await ou .catch() explícito |
| P2 | Exit code 143 | Classificar SIGTERM pós-complete como evento normal |
| P2 | Control-plane status | Corrigir health check no `formiga status` |
| P3 | other_output | Relaxar regex ou aceitar sidecar-based completion como work_done |
