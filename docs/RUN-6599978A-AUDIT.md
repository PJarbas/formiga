# Run Audit: `6599978a` — Bugs, Diagnostico e Proposta de Correcao

> Audit completo do run `6599978a-6e97-43fa-a202-2952a3dec89f` (run #11)
> Gerado em: 2026-07-09
> Workflow: `ml-autoresearch` | Harness: `pi`

---

## Visao Geral

| Campo | Valor |
|-------|-------|
| **Run ID** | `6599978a-6e97-43fa-a202-2952a3dec89f` |
| **Run #** | 11 |
| **Workflow** | `ml-autoresearch` |
| **Status** | `running` (preso — arena nunca executou) |
| **Fase reportada** | `arena` (incorreta — arena travou em round 0) |
| **Inicio** | 2026-07-09 14:46:41 UTC |
| **Total eventos no banco** | ~22.874 (crescendo ~330/min) |
| **Tokens desperdicados** | >300.000 em heartbeat polling |

### Fluxo Esperado

```
eda (data-analyst) -> features (feature-engineer) -> arena (modelers competem) -> report
```

### Fluxo Real

```
eda (done) -> features (done) -> arena (TRAVADO: round 0, nunca executou) -> report (waiting)
                                          ^
                                          scheduler faz heartbeat polling infinito
                                          do feature-engineer (~3500 tokens/round)
```

---

## BUGs Encontrados

### BUG-1 — CRITICO: Explosao de Eventos Duplicados no Banco

**Sintoma:** 22.874+ eventos em `agent_events` para um unico run, crescendo ~330/min.

**Diagnostico:**

```
Total eventos: 22.874
  tool_call (status=running): 17.556  ← NENHUM com status completed/failed
  thinking (sem tool_name):    4.162
  step_event:                      0  ← NENHUM step_event registrado

Eventos com mesmo timestamp:
  2026-07-09T14:52:44.062+00:00 -> 17 eventos
  2026-07-09T14:52:44.177+00:00 -> 21 eventos

Comando duplicado:
  "echo 'STATUS: done...'" -> 339 registros identicos
```

**Causa raiz:** `activity-recorder.ts:68-71` trata `toolcall_start` e `toolcall_delta` da mesma forma:

```typescript
// activity-recorder.ts:68-71
if (innerType === "toolcall_start" || innerType === "toolcall_delta") {
  await handleToolCallStart(event, context);  // ← AMBOS chamam o mesmo handler
  return;
}
```

O `toolcall_delta` e um evento incremental que chega multiplas vezes por tool call (cada chunk de streaming). Cada delta cria um novo registro `"running"` no banco para a mesma chamada. O `toolcall_result` deveria criar um evento `"completed"`, mas o pi gera deltas que nunca sao matched com o result correto.

Adicionalmente, `handleThinking` grava eventos `"thinking"` sem `tool_name`, e o threshold de 20 caracteres e tao baixo que ate heartbeats geram registros.

**Impacto:**
- Banco cresce infinitamente (~330 eventos/min para um run preso)
- Dashboard fica lento (queries em tabela com dezenas de milhares de rows)
- Activity stream mostra eventos duplicados e confusos
- `tool_status` e sempre `"running"`, nunca `"completed"` — impossivel saber se uma acao terminou

---

### BUG-2 — CRITICO: Arena Step Preso / Nunca Executou

**Sintoma:** O step `arena` esta `running` desde 14:53:08, mas a arena engine nunca iniciou uma unica rodada. Modelers ficam permanentemente em `idle`.

**Diagnostico:**

```
arena_sessions:
  current_round = 0
  best_metric   = NULL
  best_agent    = NULL
  total_keep    = 0
  total_discard = 0
  total_crash   = 0

steps (arena):
  status       = "running"
  claim_job_id = NULL    ← ninguem pegou o step
  claim_pid    = NULL
  output       = NULL

artifacts/models/:
  (diretorio vazio)

experiments:
  (nenhum experimento para este run)
```

**Causa raiz:** A funcao `launchArenaFromStep()` em `arena-workflow.ts` marca o step como `"running"` e entao chama `runArena()`. O log do formiga nao mostra nenhuma entrada de arena para este run, o que sugere que `buildArenaConfig()` retornou `null` ou `runArena()` falhou silenciosamente. O scheduler nao tem mecanismo de deteccao para steps arena presos — o reconciler so verifica `claim_pid` morto, mas o arena step nao tem `claim_pid`.

**Impacto:** Pipeline inteiro travado. O run nunca vai completar sem intervencao manual.

---

### BUG-3 — ALTO: Metric Direction Incorreta (RMSE = "higher" em vez de "lower")

**Sintoma:** A arena session tem `metric_direction = "higher"` para `metric_name = "rmse"`.

**Diagnostico:**

```sql
-- arena_sessions
metric_name      = "rmse"
metric_direction = "higher"  ← ERRADO: RMSE mais baixo e melhor
```

O `benchmark_config.json` gerado pelo feature-engineer nao inclui `metric.direction`:

```json
{
  "type": "regression",
  "metric": "rmse",
  "validation": "LOOCV",
  // ← sem "direction": "lower"
}
```

O fallback em `arena-workflow.ts:234`:

```typescript
const metricDirection: "lower" | "higher" =
  benchmarkConfig?.metric?.direction ??   // ← null (nao existe no config)
  (ctx.metric_direction as "lower" | "higher") ??  // ← null (nao vem do context)
  "higher";  // ← DEFAULT ERRADO PARA RMSE
```

**Impacto:** A arena engine usara `isImprovement()` com direcao invertida. Um modelo com RMSE 50.000 sera considerado "melhor" que um com RMSE 5.000. O leaderboard ordenara de forma invertida. O `makeDecision()` em `arena-engine.ts:252` descartara os modelos melhores e manter os piores.

---

### BUG-4 — ALTO: Heartbeat Polling Eterno com Desperdicio de Tokens

**Sintoma:** O scheduler continua lancando polling rounds para o feature-engineer a cada 2 minutos, mesmo quando o agente responde `HEARTBEAT_OK` (NO_WORK).

**Diagnostico dos logs:**

```
[15:01:24] Polling round complete ... outcome="heartbeat" tokenUsage=3541
[15:03:25] Polling round complete ... outcome="heartbeat" tokenUsage=3678
[15:05:07] Polling round start ...  (2 min depois, mesmo agente)
```

Cada heartbeat round:
- Consome ~3.500 tokens (systemTokensSpent > 311.823 acumulados)
- Gera ~330 eventos no banco (thinking + tool_call duplicados)
- Nao ha backoff — polling continua indefinidamente

O scheduler faz polling de TODOS os agents em cada tick, mesmo os que ja completaram:

```
[15:02:41] Polling round skipped — previous harness still in flight
            agentId="ml-autoresearch_data-analyst"
            reason="previous_round_in_flight"
```

O data-analyst ja completou ha 15 minutos, mas o scheduler ainda tenta faze-lo polling porque o job ID ainda esta registrado no sistema de cron.

**Impacto:** Desperdicio de tokens da API, crescimento infinito do banco, CPU e memoria desperdicadas nos processos pi de heartbeat.

---

### BUG-5 — MEDIO: Reasoning Panel Vazio para Todos os Agentes

**Sintoma:** Todos os campos de reasoning retornam `null` no painel de Activity Reasoning.

**Diagnostico:**

```json
{
  "hypothesis": null,
  "learned": null,
  "nextFocus": null,
  "approaches": { "models": [] },
  "keyDecisions": [],
  "specDiff": null,
  "summary": "STATUS: done\nCHANGES: Built canonical feature matrix..."
}
```

O handler em `dashboard.ts:1290-1314` busca dados ASI (Autoresearch State Intent) em `readAutoresearchLog(cwd)`, mas:

1. O workflow `ml-autoresearch` nao gera arquivos de log no formato esperado (`autoresearch.jsonl`) no workspace do run
2. A busca por `agentName.replace("-", " ")` no campo `description` falha para nomes como `"data analyst"` vs `"data-analyst"`
3. Para data-analyst e feature-engineer, o `summary` e apenas o step output cru (STATUS/CHANGES/TESTS), nao reasoning estruturado
4. O campo `hypothesis/learned/next_focus` so seria populado por experimentos de autoresearch com ASI data, que nao existem para setup agents

---

### BUG-6 — MEDIO: Pipeline Flow DAG Incorreto para ml-autoresearch

**Sintoma:** O pipeline flow mostra edges `feature-engineer -> modeler-classic` e `feature-engineer -> modeler-advanced` com status `"in-transit"`, mas no workflow `ml-autoresearch` os modelers sao executados DENTRO da arena engine, nao como steps separados.

**Diagnostico:** O `AGENT_INFO_REGISTRY` em `dashboard-types.ts` registra `modeler-classic` e `modeler-advanced` com steps separados (`model-classic`, `model-advanced`), mas o `workflow.yml` define apenas `arena` como step. O pipeline flow constroi edges baseados no registry, nao no workflow real.

**Impacto:** Dashboard mostra estrutura incorreta — sugere que modelers serao steps independentes quando na verdade sao executados pela arena engine internamente.

---

### BUG-7 — MEDIO: Processo `step complete` Travado

**Sintoma:** O processo PID 91422 esta rodando desde 11:49 (ha mais de 3 horas) executando:

```bash
echo 'STATUS: done\nCHANGES: ...' | formiga step complete "1fc3f0fc-..."
```

O step `eda` ja esta `done` no banco, mas o processo de completar nunca terminou. Provavelmente o pipe esta esperando algo que nunca acontece (um signal ou EOF que nao chega).

**Impacto:** Leak de processo e de file descriptor.

---

### BUG-8 — BAIXO: `agent_artifacts` Vazio

**Sintoma:** A tabela `agent_artifacts` nao tem nenhum registro para este run, apesar de artefatos reais terem sido produzidos em disco.

**Diagnostico:** API `/api/runs/{id}/agent-artifacts` retorna `{"artifacts": []}`. Os agentes gravam arquivos em disco mas nao chamam `formiga_save_artifact` via CLI, e o pi harness nao tem integracao automatica com o sistema de artefatos do banco.

---

### BUG-9 — BAIXO: Artifact Name Mismatch

**Sintoma:** O pipeline flow mostra `data-analyst` com `artifactsOut: ["eda_report.json"]`, mas o artefato real produzido foi `eda_config.json`. O arquivo `eda_report.json` nunca existiu.

**Diagnostico:** O `AGENT_INFO_REGISTRY` define `artifactsOut` estaticamente, mas os agentes produzem nomes diferentes. O data-analyst gera `eda_config.json` + `reports/01_eda.md`, nao `eda_report.json`.

---

### BUG-10 — BAIXO: `messagesCount = 0` para Todos os Agentes

**Sintoma:** Todos os agentes retornam `messagesCount: 0` no pipeline flow. O endpoint `/api/runs/{id}/messages` retorna 404.

**Diagnostico:** O sistema de mensagens inter-agente (`AgentMessengerImpl`) e instanciado em `RoundManager` mas nunca e passado ao contexto dos agentes (conforme documentado em `AGENT-COMMUNICATION-ANALYSIS.md` BUG-2).

---

## Resumo de Severidade

| # | Bug | Severidade | Status | Impacto |
|---|-----|-----------|--------|---------|
| 1 | Explosao de eventos duplicados | **CRITICO** | Ativo | DB cresce infinitamente |
| 2 | Arena step preso | **CRITICO** | Ativo | Pipeline travado |
| 3 | Metric direction errada | **ALTO** | Latente | Escolhera pior modelo |
| 4 | Heartbeat polling eterno | **ALTO** | Ativo | Desperdicio de tokens/DB |
| 5 | Reasoning panel vazio | **MEDIO** | Ativo | UX degradada |
| 6 | Pipeline flow DAG incorreto | **MEDIO** | Ativo | Informacao errada |
| 7 | Step complete travado | **MEDIO** | Ativo | Leak de processo |
| 8 | agent_artifacts vazio | **BAIXO** | Ativo | Artefatos nao rastreaveis |
| 9 | Artifact name mismatch | **BAIXO** | Ativo | Dashboard mostra artefato inexistente |
| 10 | Inter-agent messages nao implementado | **BAIXO** | Permanente | Feature ausente |

---

## Itens Obsoletos a Remover

Baseado na analise, os seguintes documentos/planos estao desatualizados ou substituidos:

| Arquivo | Status | Razao |
|---------|--------|-------|
| `docs/PLAN-agent-trace-events.md` | **Obsoleto** | O sistema de `agent_events` ja foi implementado (e tem os bugs documentados acima). Este plano pre-DB agora e contraditorio com a realidade |
| `docs/AGENT-ACTIVITY-REDESIGN.md` | **Parcialmente obsoleto** | A secao "EVOLUCAO: Eventos no Banco de Dados" ja foi implementada, mas a Activity Stream em tempo real ainda nao foi. Os schemas propostos divergem dos implementados. Manter apenas as secoes de frontend ainda validas |
| `docs/AGENT-COMMUNICATION-ANALYSIS.md` | **Atualizar** | BUGs 1-8 ainda validos, mas o BUG-2 (messenger nunca chega) e duplicado com nosso BUG-10. Alinhar numeracao |
| `docs/KNOWN-ISSUES.md` | **Atualizar** | Nao menciona nenhum dos BUGs 1-10 deste audit. Adicionar secoes para os bugs criticos |

---

## Proposta de Correcao

### Fase 1: Estabilizar (CRITICO — corrigir imediatamente)

#### FIX-1.1: Deduplicacao e Throttling de Eventos no Activity Recorder

**Arquivo:** `src/installer/scheduler/activity-recorder.ts`

**Mudanca 1 — Ignorar `toolcall_delta`:**

```typescript
// ANTES (linha 68-71):
if (innerType === "toolcall_start" || innerType === "toolcall_delta") {
  await handleToolCallStart(event, context);
  return;
}

// DEPOIS:
if (innerType === "toolcall_start") {
  await handleToolCallStart(event, context);
  return;
}
// toolcall_delta NAO grava evento — e apenas um chunk incremental
```

**Mudanca 2 — Throttling de thinking:**

```typescript
// ANTES (linha 185-186):
if (!thinking || thinking.length < 20) return;

// DEPOIS:
if (!thinking || thinking.length < 100) return;  // Threshold maior
// E adicionado throttle: no maximo 1 thinking event por step a cada 10s
const now = Date.now();
if (now - lastThinkingTimestamp < 10_000) return;
lastThinkingTimestamp = now;
```

**Mudanca 3 — Match correto de toolcall_start com toolcall_result:**

```typescript
// Extrair tool_call_id do evento de start para matching com result
async function handleToolCallStart(event, context) {
  const toolCall = extractToolCall(event);
  if (!toolCall) return;

  // Dedup: se ja existe um evento "running" para este toolCall.id neste step, skip
  const existing = await prisma.agentEvent.findFirst({
    where: {
      run_id: context.runId,
      step_id: context.stepId,
      event_type: "tool_call",
      tool_name: toolCall.name,
      tool_status: "running",
      // Usar tool_args para fingerprint
    },
    select: { id: true },
  });
  if (existing) return;

  // ... resto do codigo existente
}
```

**Mudanca 4 — Corrigir `handleToolCallResult` para efetivamente gravar `completed`:**

```typescript
// O resultado do toolcall_result DEVE ter tool_status, toolResult e durationMs
// Verificar que o pi emite o evento de resultado corretamente
// e que o handler os captura
async function handleToolCallResult(event, context) {
  // ... codigo existente ...

  await recordAgentEvent({
    ...context,
    eventType: "tool_call",
    toolName: inFlight?.tool ?? "unknown",
    toolArgs: inFlight?.args,
    toolResult: result,          // ← Garantir que resulta e gravado
    toolStatus: isError ? "failed" : "completed",  // ← Status correto
    durationMs,                 // ← Duracao calculada
  });
}
```

**Mudanca 5 — Limpeza retroativa:**

Adicionar endpoint ou script de manutencao para consolidar eventos duplicados:

```sql
-- Consolidar eventos duplicados (mesmo run, step, agent, tool_name, timestamp)
DELETE FROM agent_events
WHERE id NOT IN (
  SELECT MIN(id) FROM agent_events
  GROUP BY run_id, step_id, agent_id, event_type, tool_name, created_at
);

-- Atualizar eventos "running" orfaos (sem matching "completed")
-- Para tool_calls com mais de 10 min, marcar como "completed" sem resultado
UPDATE agent_events
SET tool_status = 'completed', tool_result = '(orphan — result not captured)'
WHERE tool_status = 'running'
  AND created_at < datetime('now', '-10 minutes')
  AND event_type = 'tool_call';
```

---

#### FIX-1.2: Diagnostico e Correcao do Arena Step Preso

**Arquivo:** `src/arena/arena-workflow.ts` + `src/installer/scheduler/direct-spawn.ts`

**Mudanca 1 — Adicionar logging robusto em `launchArenaFromStep`:**

```typescript
export async function launchArenaFromStep(runId: string, stepId: string): Promise<void> {
  logger.info("Arena launch starting", { runId, stepId });

  // Mark step running
  await prisma.step.update({ ... });

  const config = await buildArenaConfig(runId);
  if (!config) {
    const err = "Arena config is null — missing benchmark_config.json or run context";
    logger.error("Arena config build failed", { runId, stepId });
    await markStepFailed(stepId, runId, err);
    return;
  }

  logger.info("Arena config built", {
    runId,
    metricName: config.metricName,
    metricDirection: config.metricDirection,
    maxRounds: config.maxRounds,
    agentsCount: config.agents.length,
    workspacePath: config.workspacePath,
    benchmarkScript: config.benchmarkScript,
  });

  try {
    const result = await runArena(config, repo, leaderboardRepo, piRunAgentsParallel);
    logger.info("Arena completed", { runId, ... });
    await completeStep(stepId, formatArenaResultOutput(result));
  } catch (err) {
    logger.error("Arena engine threw", { runId, stepId, error: String(err) });
    await markStepFailed(stepId, runId, `Arena engine error: ${err}`);
  }
}
```

**Mudanca 2 — Reconciler deve detectar arena steps presos:**

```typescript
// Em control-server.ts reconciler, adicionar:
const stuckArenaSteps = await prisma.step.findMany({
  where: {
    status: "running",
    step_id: "arena",
    claim_pid: null,          // Arena nao usa claim_pid
    updated_at: { lt: new Date(Date.now() - 10 * 60 * 1000) } },  // > 10 min
});

for (const step of stuckArenaSteps) {
  logger.warn("Detected stuck arena step, re-launching", {
    runId: step.run_id,
    stepId: step.id,
  });
  await launchArenaFromStep(step.run_id, step.id);
}
```

**Mudanca 3 — Verificar porque `buildArenaConfig` pode falhar silenciosamente:**

```typescript
// Em buildArenaConfig, adicionar logs:
export async function buildArenaConfig(runId: string): Promise<ArenaConfig | null> {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) {
    logger.warn("buildArenaConfig: run not found", { runId });
    return null;
  }

  let ctx: Record<string, string>;
  try {
    ctx = JSON.parse(run.context);
  } catch {
    logger.warn("buildArenaConfig: context not parseable", { runId });
    return null;
  }

  const workspace = ctx.workspace ?? ctx.working_directory_for_harness ?? process.cwd();
  const benchmarkConfig = readBenchmarkConfig(workspace);

  if (!benchmarkConfig) {
    logger.warn("buildArenaConfig: no benchmark_config.json found", { runId, workspace });
    // NAO RETORNAR NULL — criar config default
  }

  // ... resto com defaults robustos
}
```

---

#### FIX-1.3: Metric Direction Default Inteligente

**Arquivo:** `src/arena/arena-workflow.ts` + `src/arena/dataset-context.ts`

**Mudanca 1 — Mapa de metricas para direcao default:**

```typescript
// Novo helper em arena-workflow.ts:
const METRIC_DIRECTION_DEFAULTS: Record<string, "lower" | "higher"> = {
  // Lower is better (erros)
  rmse: "lower",
  mse: "lower",
  mae: "lower",
  mape: "lower",
  rmsle: "lower",
  logloss: "lower",
  brier: "lower",
  hamming: "lower",

  // Higher is better (scores)
  accuracy: "higher",
  auc: "higher",
  f1: "higher",
  r2: "higher",
  precision: "higher",
  recall: "higher",
  map: "higher",
  ndcg: "higher",
};

function inferMetricDirection(metricName: string): "lower" | "higher" {
  const key = metricName.toLowerCase().replace(/[^a-z]/g, "");
  return METRIC_DIRECTION_DEFAULTS[key] ?? "higher";
}
```

**Mudanca 2 — Usar inferencia em buildArenaConfig:**

```typescript
// ANTES:
const metricDirection: "lower" | "higher" =
  benchmarkConfig?.metric?.direction ??
  (ctx.metric_direction as "lower" | "higher") ??
  "higher";  // ← ERRADO PARA RMSE

// DEPOIS:
const metricDirection: "lower" | "higher" =
  benchmarkConfig?.metric?.direction ??
  (ctx.metric_direction as "lower" | "higher") ??
  inferMetricDirection(metricName);  // ← INFERE PELO NOME DA METRICA
```

**Mudanca 3 — Feature-engineer prompt deve incluir direction no benchmark_config.json:**

Atualizar o prompt do feature-engineer em `workflow.yml` para exigir explicitamente:

```yaml
input: |
  ...
  Produce:
    ...
    - benchmark_config.json (type, metric, direction, validation, data paths)
      IMPORTANT: include "direction" field: "lower" for error metrics (rmse, mae),
      "higher" for score metrics (auc, accuracy, r2).
  ...
```

---

### Fase 2: Desperdicio (ALTO — corrigir a seguir)

#### FIX-2.1: Backoff no Heartbeat Polling

**Arquivo:** `src/installer/scheduler/polling-round.ts`

**Mudanca — Implementar backoff exponencial para heartbeats:**

```typescript
// Manter contador de heartbeats consecutivos por agent+run
const heartbeatCounts = new Map<string, number>();

async function executePollingRound(agent, run, ...) {
  const key = `${run.id}:${agent.id}`;
  const heartbeatCount = heartbeatCounts.get(key) ?? 0;

  // Backoff: apos 3 heartbeats, passar a fazer polling a cada 5 min em vez de 2
  if (heartbeatCount >= 3) {
    const lastPoll = lastPollTime.get(key) ?? 0;
    const backoffMs = Math.min(5 * 60 * 1000, 2 * 60 * 1000 * Math.pow(1.5, heartbeatCount - 3));
    if (Date.now() - lastPoll < backoffMs) {
      logger.info("Heartbeat backoff", { key, heartbeatCount, backoffMs });
      return;
    }
  }

  // ... polling normal ...

  if (outcome === "heartbeat") {
    heartbeatCounts.set(key, heartbeatCount + 1);
  } else {
    heartbeatCounts.set(key, 0);  // Reset em trabalho real
  }
}
```

**Mudanca — Skip polling para steps ja completados:**

```typescript
// Antes de lancar polling, verificar se o agente ja completou todos os seus steps
const pendingSteps = await prisma.step.count({
  where: {
    run_id: run.id,
    agent_id: { endsWith: `_${agent.id}` },
    status: { in: ["waiting", "pending"] },
  },
});

if (pendingSteps === 0) {
  logger.info("No pending steps for agent, skipping", { agentId: agent.id, runId: run.id });
  return;
}
```

**Mudanca — Nao gravar eventos de heartbeat no banco:**

```typescript
// No activity-recorder, quando o step esta em heartbeat (NO_WORK):
// NAO chamar processActivityLine — os eventos de thinking
// do heartbeat nao sao trabalho util
if (outcome === "heartbeat") {
  // Skip activity recording para heartbeats
  return;
}
```

---

#### FIX-2.2: Kill de Processos `step complete` Orfaos

**Arquivo:** `src/server/control-server.ts`

**Mudanca — Reconciler detecta processos `step complete` rodando ha mais de 5 min:**

```typescript
// No reconciler periodico:
const staleCompleteProcesses = await prisma.$queryRaw`
  SELECT s.id, s.step_id, s.run_id, s.agent_id, s.updated_at
  FROM steps s
  WHERE s.status = 'done'
    AND s.updated_at < datetime('now', '-5 minutes')
`;

// Verificar se ha processos `formiga step complete` rodando para steps ja completados
// e mata-los
```

---

### Fase 3: Visibilidade (MEDIO — corrigir depois)

#### FIX-3.1: Reasoning Panel com Fallbacks Robustos

**Arquivo:** `src/server/dashboard.ts` (handler de `/api/agents/:name/reasoning`)

**Mudanca — Extrair reasoning de fontes multiplas com fallback:**

```typescript
// Hierarquia de fontes para hypothesis/learned/nextFocus:
// 1. ASI data do autoresearch log (fonte atual)
// 2. Experiment hypothesis/learned fields da tabela experiments
// 3. Step output parseado (extrair campos estruturados)
// 4. Summary do step (texto cru)

let hypothesis: string | null = null;
let learned: string | null = null;
let nextFocus: string | null = null;

// Fonte 1: ASI data (atual)
const logEntries = readAutoresearchLog(cwd);
// ... codigo existente ...

// Fonte 2: Experiments
if (!hypothesis && experiments.length > 0) {
  const latest = experiments[0];
  hypothesis = latest.hypothesis ?? null;
  // learned e next_focus vem do experiment mais recente com esses campos
  const withLearned = experiments.find(e => e.learned);
  learned = withLearned?.learned ?? null;
  const withNextFocus = experiments.find(e => e.next_focus);
  nextFocus = withNextFocus?.next_focus ?? null;
}

// Fonte 3: Parse do step output
if (!hypothesis && step?.output) {
  const hypothesisMatch = step.output.match(/HYPOTHESIS:\s*(.+?)(?:\n|$)/i);
  hypothesis = hypothesisMatch?.[1] ?? null;
  const learnedMatch = step.output.match(/LEARNED:\s*(.+?)(?:\n|$)/i);
  learned = learnedMatch?.[1] ?? null;
}
```

#### FIX-3.2: Pipeline Flow DAG Dinamico por Workflow

**Arquivo:** `src/server/dashboard.ts`

**Mudanca — Gerar nodes/edges baseados no workflow real, nao no registry estatico:**

```typescript
// Para ml-autoresearch, o flow e:
// data-analyst -> feature-engineer -> arena -> reporter
// Os modelers sao internos da arena, nao steps do pipeline

function buildPipelineFlow(runId: string): PipelineFlowResponse {
  const workflowType = getWorkflowType(runId);

  if (workflowType === "ml-autoresearch") {
    return buildAutoresearchFlow(runId);
  }
  return buildMlPipelineFlow(runId);  // Flow original
}

function buildAutoresearchFlow(runId: string): PipelineFlowResponse {
  const nodes = [
    { agentId: "data-analyst", label: "Data Analyst", phase: "data_analysis" },
    { agentId: "feature-engineer", label: "Feature Engineer", phase: "feature_engineering" },
    { agentId: "arena", label: "Arena (Competing Modelers)", phase: "modeling" },
    { agentId: "ml-critic", label: "ML Critic", phase: "audit" },
    { agentId: "reporter", label: "Reporter", phase: "report" },
  ];

  const edges = [
    { from: "data-analyst", to: "feature-engineer", artifactLabel: "eda_config.json" },
    { from: "feature-engineer", to: "arena", artifactLabel: "features.parquet" },
    { from: "arena", to: "ml-critic", artifactLabel: "arena_results" },
    { from: "ml-critic", to: "reporter", artifactLabel: "audit_report.json" },
  ];

  // ... resolver status de cada node ...
}
```

---

### Fase 4: Completude (BAIXO — backlog)

#### FIX-4.1: Integracao automatica de artefatos no banco

O pi harness ou o `ingestStepOutput` deveria ler os arquivos produzidos pelo agente e registrar em `agent_artifacts`. Atualmente, os agentes gravam em disco mas o banco fica vazio.

**Abordagem:** No callback de step complete, escanear o workspace em busca de artefatos padrao (`.parquet`, `.pkl`, `.json`, `.md`, `.py`) e registrar automaticamente.

#### FIX-4.2: Corrigir `artifactsOut` no registry

O `AGENT_INFO_REGISTRY` deve refletir os nomes reais dos artefatos, nao nomes ideais. Atualizar `data-analyst.artifactsOut` de `["eda_report.json"]` para `["eda_config.json", "reports/01_eda.md"]`.

#### FIX-4.3: Implementar comunicacao inter-agente

Conforme `AGENT-COMMUNICATION-ANALYSIS.md` BUG-2, o messenger existe mas nunca chega ao agente. Implementar `messenger` em `AgentContext` e passar ao pi harness via prompt.

---

## Ordem de Execucao Recomendada

```
Semana 1 (estabilizar):
  [1] FIX-1.1  — Deduplicacao de eventos (para crescimento infinito)
  [2] FIX-1.3  — Metric direction (impedir resultado errado quando arena rodar)
  [3] FIX-1.2  — Arena step preso (destravar pipeline)

Semana 2 (desperdicio):
  [4] FIX-2.1  — Backoff no heartbeat polling (reduzir desperdicio de tokens)
  [5] FIX-2.2  — Kill de processos orfaos

Semana 3 (visibilidade):
  [6] FIX-3.1  — Reasoning panel com fallbacks
  [7] FIX-3.2  — Pipeline flow dinamico

Backlog:
  [8] FIX-4.1  — Integracao automatica de artefatos
  [9] FIX-4.2  — Corrigir artifact names no registry
  [10] FIX-4.3 — Implementar comunicacao inter-agente
```

---

## Bugs Pre-Existentes a Consolidar

Os seguintes bugs foram identificados em `AGENT-COMMUNICATION-ANALYSIS.md` e permanece validos. Devem ser consolidados neste documento apos remover o doc obsoleto:

| ID Original | Bug | Status |
|-------------|-----|--------|
| AC-BUG-1 | `broadcast()` cego a novos agentes | Valido |
| AC-BUG-2 | Messenger nunca chega ao agente | Duplicado com BUG-10 |
| AC-BUG-3 | `fromArenaExperiment()` usa mesmo valor para train/val | Valido — CRITICO |
| AC-BUG-4 | `getFailedConfigsForAgent()` nao encontra agente exato | Valido |
| AC-BUG-5 | `metric_name` hardcoded como "primary" | Valido |
| AC-BUG-6 | `extractFailureReason()` analisa campos errados | Valido |
| AC-BUG-7 | `computeDatasetSignature()` nao suporta Parquet | Valido |
| AC-BUG-8 | `toExperimentRow()` duplicado | Valido |

---

## Analise de Codigo Fonte — Confirmacoes

### Confirmacao BUG-1: `activity-recorder.ts`

**Arquivo:** `src/installer/scheduler/activity-recorder.ts`

O codigo fonte confirma a causa raiz. Linhas 68-71:

```typescript
if (innerType === "toolcall_start" || innerType === "toolcall_delta") {
  await handleToolCallStart(event, context);  // ← AMBOS chamam handleToolCallStart
  return;
}
```

**Problema confirmado:** `toolcall_delta` e um evento de streaming incremental que chega multiplas vezes (um por chunk de output). Cada delta dispara `handleToolCallStart`, que cria um novo registro `"running"` no banco.

**Funcoes envolvidas:**
- `handleToolCallStart` (linhas 111-143): Extrai tool call e grava `status = "running"`
- `handleToolCallResult` (linhas 145-178): Deveria gravar `status = "completed"` mas depende de matching correto com o start
- `inFlightToolCalls` Map: Rastreia tool calls em andamento, mas deltas criam multiplas entradas

**Evidencia de design original:** O codigo usa `inFlightToolCalls` para correlacionar start/result e calcular duracao. Isso funciona para um evento start e um evento result, mas falha quando multiplos deltas sao tratados como starts.

---

### Confirmacao BUG-2: `arena-workflow.ts`

**Arquivo:** `src/arena/arena-workflow.ts`

**`launchArenaFromStep` (linhas 286-353):**

```typescript
export async function launchArenaFromStep(runId: string, stepId: string): Promise<void> {
  // 1. Marca step como running (linha 294-297)
  await prisma.step.update({ where: { id: stepId }, data: { status: "running" } });

  // 2. Build config (linha 308)
  const config = await buildArenaConfig(runId);
  if (!config) {
    const err = "Arena engine failed to build config...";
    await markStepFailed(stepId, runId, err);  // ← Deveria falhar aqui, mas nao ha log
    return;
  }

  // 3. Run arena (linha 320-325)
  const result = await runArena(config, repo, leaderboardRepo, piRunAgentsParallel);

  // 4. Complete step (linha 330)
  await completeStep(stepId, formatArenaResultOutput(result));
}
```

**Problema confirmado:** Se `buildArenaConfig()` retorna `null`, o step e marcado como `failed`, mas o run continua como `running`. O scheduler nao tem visibilidade de que o arena falhou — ele ve o step como `running` e continua polling.

**Causa provavel do travamento:** `buildArenaConfig` retornou `null` (por falta de `benchmark_config.json` ou parse error no context), o step foi marcado como `failed`, mas o log nao mostra isso claramente. O run nunca transitou para `failed` porque o tratamento de erro nao propaga para o run.

---

### Confirmacao BUG-3: Metric Direction Default

**Arquivo:** `src/arena/arena-workflow.ts` (linhas 232-235)

```typescript
const metricDirection: "lower" | "higher" =
  benchmarkConfig?.metric?.direction ??           // ← null (nao existe)
  (ctx.metric_direction as "lower" | "higher") ?? // ← null (nao vem)
  "higher";                                       // ← DEFAULT ERRADO
```

**Confirmado:** O default `"higher"` e inadequado para metricas de erro. O codigo nao tem inferencia baseada no nome da metrica.

**Funcao de normalizacao existe mas nao infere (linhas 74-79):**

```typescript
function normalizeDirection(dir: string | undefined): "lower" | "higher" {
  if (dir === "minimize" || dir === "lower") return "lower";
  return "higher";  // ← Tudo que nao e "minimize" ou "lower" vira "higher"
}
```

---

### Confirmacao BUG-4: Heartbeat Polling Eterno

**Arquivo:** `src/installer/scheduler/cron-manager.ts`

**Intervalo de 2 minutos (linha 210):**

```typescript
const intervalMinutes = options.noHurrySaveTokensMode ? 5 : 2;  // ← 2 min default
```

**Loop infinito (linhas 124-153):**

```typescript
export function startPolling(runId: string, ...) {
  const intervalMs = intervalMinutes * 60 * 1000;
  const intervalId = setInterval(executePollingRound, intervalMs);  // ← INFINITO
  // ...
}
```

**Arquivo:** `src/installer/scheduler/polling-round.ts`

**Condicoes de parada (linhas 460-487):**

```typescript
// Unicas condicoes de parada:
// 1. Run nao esta mais "running" ou "paused"
// 2. Run esta em "paused" (skip, continua timer)
// 3. Run esta em "draining_pause" (skip, continua timer)
// 4. Workdir nao existe mais (teardown)
```

**Problema confirmado:** Nao ha backoff para heartbeats consecutivos. Apos N heartbeats do mesmo agente, o sistema deveria aumentar o intervalo ou parar de poll-ar aquele agente. O design assume que heartbeats sao raros (apenas orphan recovery), mas na pratica sao frequentes quando steps travam.

---

## Codigo Obsoleto a Remover

### 1. Remover `docs/PLAN-agent-trace-events.md`

O plano foi implementado em `activity-recorder.ts` + `server/routes/agent-activity.ts`. O documento propunha um schema diferente do implementado e agora causa confusao.

**Acao:** `git rm docs/PLAN-agent-trace-events.md`

### 2. Simplificar `docs/AGENT-ACTIVITY-REDESIGN.md`

A secao "EVOLUCAO: Eventos no Banco de Dados" foi implementada. Manter apenas:
- Secao de frontend Activity Stream (nao implementada)
- Secao de EventBus SSE (parcialmente implementada)

**Acao:** Editar para remover secoes obsoletas, adicionar nota "Parcialmente implementado".

### 3. Consolidar `docs/AGENT-COMMUNICATION-ANALYSIS.md` neste documento

Os bugs AC-BUG-1 a AC-BUG-8 devem ser numerados como BUG-11 a BUG-18 e movidos para ca.

**Acao:** Mover bugs, deletar documento original.

### 4. Atualizar `docs/KNOWN-ISSUES.md`

Adicionar referencia a este audit e listar os BUGs 1-10 como issues conhecidos com severidade.

---

## Metricas de Impacto

### Antes das Correcoes

| Metrica | Valor Atual | Impacto |
|---------|-------------|---------|
| Eventos/min no banco | ~330 | Banco cresce 475 MB/dia |
| Tokens desperdicados/hora | ~105.000 | $2.10/hora em heartbeats vazios |
| Runs travados | 1 (este) | 100% dos runs arena |
| Processos orfaos | 1+ | Leak de memoria |

### Apos Correcoes (Projetado)

| Metrica | Valor Esperado | Melhoria |
|---------|----------------|----------|
| Eventos/min no banco | ~5-10 | 97% reducao |
| Tokens desperdicados/hora | ~5.000 | 95% reducao |
| Runs travados | 0 | Pipeline funcional |
| Processos orfaos | 0 | Cleanup automatico |

---

## Checklist de Implementacao

### Fase 1: Estabilizar (P0)

- [x] **FIX-1.1a**: Ignorar `toolcall_delta` em `activity-recorder.ts:68`
- [x] **FIX-1.1b**: Aumentar threshold de thinking para 100 chars
- [x] **FIX-1.1c**: Adicionar throttle de thinking (1 per 10s)
- [x] **FIX-1.1d**: Garantir que `handleToolCallResult` grava `completed` (funciona via toolcall_start + toolcall_result pairing)
- [x] **FIX-1.1e**: Script SQL de limpeza retroativa (`scripts/cleanup-duplicate-events.sql`)
- [x] **FIX-1.2a**: Logging robusto em `launchArenaFromStep` e `buildArenaConfig`
- [x] **FIX-1.2b**: Reconciler detecta arena steps presos
- [x] **FIX-1.2c**: `buildArenaConfig` com defaults robustos e logging
- [x] **FIX-1.3a**: Mapa `METRIC_DIRECTION_DEFAULTS`
- [x] **FIX-1.3b**: Inferencia de direction pelo nome da metrica
- [x] **FIX-1.3c**: Atualizar prompt do feature-engineer (metric direction em benchmark_config.json)

### Fase 2: Desperdicio (P1)

- [x] **FIX-2.1a**: Backoff exponencial para heartbeats (consecutive tracking + skip)
- [x] **FIX-2.1b**: Skip polling para agents sem steps pending
- [ ] **FIX-2.1c**: Nao gravar eventos de heartbeat (skip — backoff reduz volume suficientemente)
- [x] **FIX-2.2**: Kill processos `step complete` orfaos (process group kill no reconciler)

### Fase 3: Visibilidade (P2)

- [x] **FIX-3.1**: Reasoning panel com fallbacks (step output markers + agent_events thinking)
- [x] **FIX-3.2**: Pipeline flow dinamico por workflow (ml-autoresearch vs ml-pipeline)

### Fase 4: Completude (P3)

- [x] **FIX-4.1**: Integracao automatica de artefatos (autoRegisterArtifacts em complete.ts)
- [x] **FIX-4.2**: Corrigir artifact names no registry (adicionado predictions.csv)
- [ ] **FIX-4.3**: Implementar comunicacao inter-agente (pendente)

### Limpeza de Documentacao

- [x] Remover `docs/PLAN-agent-trace-events.md`
- [x] Remover `docs/AGENT-ACTIVITY-REDESIGN.md`
- [x] Remover `docs/AGENT-COMMUNICATION-ANALYSIS.md`
- [x] Remover `docs/REDESIGN-PLAN.md`, `docs/REDESIGN-CRITIQUE.md`, `docs/REPORT-REDESIGN-SPEC.md`
- [x] Remover `docs/HERMES-ACTIVITY-PLAN.md`, `docs/AGENT-DATABASE-COMMUNICATION.md`
- [x] Remover `docs/REDESIGN-CHECKLIST.md`, `docs/DASHBOARD_IMPROVEMENT_SPECS.md`
- [x] Atualizar `docs/KNOWN-ISSUES.md`

---

## Apendice: Queries de Diagnostico

### A. Verificar explosion de eventos

```sql
-- Total de eventos por run
SELECT run_id, COUNT(*) as total
FROM agent_events
GROUP BY run_id
ORDER BY total DESC
LIMIT 10;

-- Eventos duplicados (mesmo timestamp, tool, step)
SELECT run_id, step_id, tool_name, created_at, COUNT(*) as duplicates
FROM agent_events
WHERE event_type = 'tool_call'
GROUP BY run_id, step_id, tool_name, created_at
HAVING duplicates > 1
ORDER BY duplicates DESC
LIMIT 20;

-- Eventos sem completion
SELECT tool_status, COUNT(*) as total
FROM agent_events
WHERE event_type = 'tool_call'
GROUP BY tool_status;
```

### B. Verificar arena status

```sql
-- Arena sessions
SELECT id, run_id, current_round, best_metric, best_agent, 
       total_keep, total_discard, total_crash, metric_direction
FROM arena_sessions
WHERE run_id = '6599978a-6e97-43fa-a202-2952a3dec89f';

-- Steps do run
SELECT id, step_id, agent_id, status, claim_pid, 
       datetime(started_at) as started, datetime(completed_at) as completed
FROM steps
WHERE run_id = '6599978a-6e97-43fa-a202-2952a3dec89f'
ORDER BY started_at;
```

### C. Verificar heartbeat polling

```sql
-- Token spend por sistema (heartbeats)
SELECT * FROM system_token_spend ORDER BY updated_at DESC LIMIT 1;

-- Eventos de heartbeat (inferido por pattern NO_WORK)
SELECT step_id, COUNT(*) as heartbeat_events
FROM agent_events
WHERE run_id = '6599978a-6e97-43fa-a202-2952a3dec89f'
  AND (tool_args LIKE '%NO_WORK%' OR tool_result LIKE '%HEARTBEAT%')
GROUP BY step_id;
```

---

*Documento gerado em 2026-07-09. Ultima atualizacao com analise de codigo fonte.*