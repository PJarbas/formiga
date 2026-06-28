# Plano: Scheduling Sequencial de Agentes + Melhorias no Experiment Board

## Contexto

Atualmente todos os 5 agentes do ml-pipeline são agendados por cron **ao mesmo tempo** desde o início do run, mesmo que o pipeline seja sequencial. Isso causa:
- Heartbeats desnecessários (agentes fazem `peek → NO_WORK` repetidamente)
- Spawns de pi sem propósito (gasto de recursos)
- Latência de até 30 min entre step completar e próximo agente pegar (depende do cron interval)
- Control plane cai e agentes ficam presos como "running" no banco

---

## Parte 1: Scheduling Sequencial (Wakeup por Evento)

### Modelo Proposto

```
data-analyst → [done] → wakeup(feature-engineer)
feature-engineer → [done] → wakeup(modeler-classic, modeler-advanced)  // paralelo
modeler-classic + modeler-advanced → [ambos done] → wakeup(ml-critic)
ml-critic → [done] → run.completed
```

### Mudanças

#### 1.1. Remover cron global por agente

**Arquivo:** `src/installer/agent-scheduler.ts`

**Mudança:** Não agendar todos os agentes no `scheduleRunAgents()`. Em vez disso, agendar apenas o primeiro agente da pipeline (data-analyst) ao iniciar o run.

```typescript
// Antes: scheduleRunAgents(runId) → cria cron para TODOS os 5 agentes
// Depois: scheduleRunAgents(runId) → cria cron APENAS para o agente do primeiro step pending
```

#### 1.2. Wakeup direto ao completar step

**Arquivo:** `src/installer/steps/complete.ts` → após `advancePipeline()`

**Mudança:** Após `advancePipeline()` promover o(s) próximo(s) step(s) para `pending`, disparar imediatamente o(s) agente(s) responsáveis — sem esperar o cron.

```typescript
// Após advancePipeline():
const nextPendingSteps = await getNextPendingSteps(runId);
for (const step of nextPendingSteps) {
  await spawnAgentForStep(step);  // Dispara pi diretamente, sem cron
}
```

#### 1.3. Spawn direto (sem cron intermediário)

**Arquivo novo:** `src/installer/scheduler/direct-spawn.ts`

**Função:** `spawnAgentForStep(step)` — equivalente a um `executePollingRound` mas sem o timer. Spawna pi imediatamente para o agente correto.

```typescript
export async function spawnAgentForStep(step: Step): Promise<void> {
  const agentId = step.agent_id;
  const runId = step.run_id;
  // Build prompt, spawn pi, parse output, complete step
  // Reutiliza a lógica de executePollingRound mas sem guard de in-flight/cron
}
```

#### 1.4. Fallback: manter um heartbeat lento

Para robustez (caso o wakeup direto falhe ou o daemon reinicie), manter um único cron "supervisor" que verifica steps pending sem agente a cada 5 min e força um spawn se necessário.

---

## Parte 2: Melhorias no Experiment Board

### 2.1. Remover view "Status"

**Arquivo:** `src/dashboard/src/screens/ExperimentBoard.tsx`

**Mudança:**
- Remover `"status"` do `ViewMode` type e do toggle
- Manter apenas `"phase"` e `"agent"` como opções
- Mudar default de `"status"` para `"phase"`
- Remover `STATUS_GROUPS` e toda a lógica de buckets por status no `buildLanes`

```typescript
type ViewMode = "phase" | "agent";
// ...
const [view, setView] = useState<ViewMode>("phase");
```

### 2.2. Indicador de fase ativa (pulsando)

**Arquivo:** `src/dashboard/src/screens/ExperimentBoard.tsx`

**Mudança:** Na view "phase", a lane da fase atualmente em execução deve ter um indicador visual pulsante, e as fases que dependem dela devem aparecer desabilitadas (opacity reduzida, sem interação).

```tsx
// No header de cada lane:
{isActiveLane && (
  <span className="w-2 h-2 rounded-full bg-[var(--accent-blue)] animate-pulse" />
)}

// No container da lane:
<div className={`... ${isDependentLane ? 'opacity-40 pointer-events-none' : ''}`}>
```

**Lógica para determinar fase ativa:**
- Usar `phaseStats` do `/api/pipeline/status` (já retorna `dataAnalyst: "completed"`, `featureEngineer: "idle"`, etc.)
- A fase ativa é a primeira com status `"running"` ou a primeira `"idle"` após todas as `"completed"`

### 2.3. Desabilitar fases dependentes

Fases que ainda não podem rodar (dependem da fase ativa) devem:
- Ter opacity reduzida (40%)
- Não responder a cliques nas cards
- Mostrar tooltip "Waiting for previous phase"

---

## Parte 3: Persistência e Auditoria

### 3.1. Já existe: resultados no banco

Os modelers já persistem resultados na tabela `experiments` via leaderboard ingest. Cada modelo treinado tem: `model_type`, `cv_mean`, `train_mean`, `artifact_path`, `status`.

### 3.2. Trace events já gravados

Com as mudanças da PR #23, todos os lifecycle events (`agent.spawned`, `step.done`, `agent.completed`) já são gravados em JSONL. Isso fornece auditoria completa de quando cada agente rodou.

---

## Arquivos a Modificar

| Arquivo | Mudança |
|---------|---------|
| `src/installer/agent-scheduler.ts` | Agendar apenas primeiro agente, não todos |
| `src/installer/steps/complete.ts` | Wakeup direto do próximo agente após step completar |
| `src/installer/scheduler/direct-spawn.ts` | Novo — spawn sem cron |
| `src/installer/scheduler/polling-round.ts` | Extrair lógica reutilizável |
| `src/dashboard/src/screens/ExperimentBoard.tsx` | Remover view status, adicionar pulse + disabled |
| `src/dashboard/src/api/api.ts` | (sem mudança — phaseStats já vem no pipeline/status) |

---

## Sequência de Execução

1. **Experiment Board UI** (rápido, visual)
   - Remover view "status"
   - Adicionar pulse na fase ativa + disabled nas dependentes

2. **Direct spawn** (core da mudança)
   - Implementar `spawnAgentForStep`
   - Integrar em `complete.ts` após `advancePipeline`
   - Testar que feature-engineer é trigado imediatamente após data-analyst completar

3. **Reduzir cron global**
   - Agendar apenas o primeiro agente
   - Manter supervisor lento como fallback

4. **Testes E2E**
   - Rodar pipeline completo
   - Verificar que cada agente é spawado por evento (não por cron)
   - Confirmar zero heartbeats desnecessários
