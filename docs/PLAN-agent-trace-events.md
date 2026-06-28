# Plano: Traces em Tempo Real para Agentes

## Problema

O endpoint `/api/trace/:agentName/:roundNumber` retorna `[]` para a maioria dos agentes porque:
- Ele consulta apenas a tabela `experiments` (que só é populada por agentes ML que produzem métricas)
- Agentes como `data-analyst`, `feature-engineer`, `planner`, etc. nunca escrevem na tabela experiments
- Mesmo agentes ML só registram experiments **após** completar — não há dados durante execução

Resultado: o `TraceTimeline` com LIVE polling mostra vazio mesmo com agente rodando.

## Descoberta Chave

O sistema **já emite eventos em tempo real** via `emitEvent()` (em `src/installer/events.ts`):
- Grava em `~/.formiga/events/<runId>.jsonl` e `~/.formiga/events/all.jsonl`
- Eventos existentes: `step.running`, `step.done`, `step.failed`, `step.retry`, `step.timeout`, `story.started`, `story.done`, `story.failed`, `pipeline.advanced`
- Cada evento tem: `{ ts, event, runId, workflowId, stepId, agentId, detail }`

**O endpoint `/api/trace` simplesmente não lê esses eventos.** A correção é conectar as duas coisas.

---

## Plano de Implementação

### Fase 1: Conectar `/api/trace` aos eventos JSONL existentes

**Arquivo:** `src/server/dashboard.ts` — função `handleTrace`

**Mudança:** Além de consultar a tabela `experiments`, ler os eventos JSONL do run e filtrar por `agentId` correspondente ao `agentName`.

```typescript
// handleTrace — nova lógica:
import { getRunEvents } from "../installer/events.js";

// 1. Ler eventos do run filtrados por agentId
const agentId = `ml-pipeline_${agentName}`; // formato do agent_id no DB
const runEvents = getRunEvents(runId)
  .filter(e => e.agentId === agentId || e.stepId?.includes(agentName))
  .map(e => ({
    timestamp: e.ts,
    event: e.event,
    detail: e.detail ?? undefined,
    level: e.event.includes("failed") ? "error" as const
         : e.event.includes("retry") || e.event.includes("timeout") ? "warn" as const
         : "info" as const,
  }));

// 2. Manter os experiment entries (para ML agents que produzem métricas)
const experimentEntries = rows.map(r => ({ ... })); // código existente

// 3. Merge por timestamp
const entries = [...runEvents, ...experimentEntries]
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
```

**Resultado:** Todos os agentes mostram trace events em tempo real (step.running, step.done, etc.)

---

### Fase 2: Emitir eventos mais granulares durante execução do pi

**Arquivo:** `src/installer/scheduler/polling-round.ts`

**Eventos novos a emitir:**
- `agent.spawned` — quando pi é lançado (no callback `onSpawn`)
- `agent.stdout` — resumo periódico do progresso (opcional, pode ser ruidoso)
- `agent.completed` — quando pi termina com sucesso
- `agent.failed` — quando pi termina com erro

```typescript
// Em executePollingRound, após runPi retornar:
emitEvent({
  ts: new Date().toISOString(),
  event: "agent.spawned",
  runId,
  stepId: step.step_id,
  agentId: step.agent_id,
  detail: `PID ${handle.pid}`,
});
```

**Arquivo:** `src/installer/steps/claim.ts`

Já emite `step.running` — verificar se `agentId` está preenchido (atualmente está em algumas chamadas, confirmar consistência).

---

### Fase 3: Melhorar a resolução do filtro de agentName

**Problema:** O `agent_id` no banco é `ml-pipeline_data-analyst`, mas o frontend pede por `data-analyst`. Precisamos de um mapeamento consistente.

**Arquivo:** `src/server/dashboard.ts`

**Solução:** Criar helper que faz match parcial:
```typescript
function matchesAgent(event: FormigaEvent, agentName: string): boolean {
  if (!event.agentId) return false;
  // agent_id = "ml-pipeline_data-analyst" → suffix = "data-analyst"
  const suffix = event.agentId.split("_").slice(1).join("_");
  return suffix === agentName || event.agentId === agentName;
}
```

---

### Fase 4 (Opcional): Tabela dedicada `trace_events`

Se a performance de ler JSONL se tornar problema (muitos eventos, runs longos), migrar para tabela Prisma:

```prisma
model TraceEvent {
  id         Int      @id @default(autoincrement())
  run_id     String
  agent_name String
  round      Int
  timestamp  DateTime @default(now())
  event      String
  detail     String?
  level      String   @default("info")

  @@index([run_id, agent_name, round])
  @@map("trace_events")
}
```

**Decisão:** Adiar esta fase. O JSONL funciona bem para runs com dezenas/centenas de eventos. Só implementar se houver problema de escala.

---

## Arquivos a Modificar

| Arquivo | Mudança |
|---------|---------|
| `src/server/dashboard.ts` | `handleTrace` lê eventos JSONL + experiments |
| `src/installer/scheduler/polling-round.ts` | Emitir `agent.spawned` no onSpawn |
| `src/installer/steps/claim.ts` | Garantir `agentId` em todos os `emitEvent` |
| `src/shared/dashboard-types.ts` | (sem mudança — `TraceEntry` já suporta tudo) |
| `src/dashboard/src/screens/AgentDetail.tsx` | (sem mudança — já tem polling 3s) |
| `src/dashboard/src/api/api.ts` | (sem mudança — `useTrace` já tem refetchInterval) |

---

## Validação

1. Iniciar pipeline: `formiga workflow run ml-pipeline 'dataset_path=data/train.csv target_column=price'`
2. Abrir dashboard em `/agents/data-analyst`
3. Verificar que TraceTimeline mostra `step.running` em tempo real
4. Após step completar, verificar que `step.done` aparece
5. Para modeler agents, verificar que experiment entries (SUCCESS/FAILED) também aparecem

---

## Sequência de Execução

1. **Modificar `handleTrace`** para ler JSONL — fix imediato, zero mudanças no fluxo de agentes
2. **Adicionar `agent.spawned`** no polling-round — melhora granularidade
3. **Garantir consistência do `agentId`** nos eventos existentes
4. Testar end-to-end com pipeline real
