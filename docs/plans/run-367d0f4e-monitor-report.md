# Relatório de Monitoramento — Run `367d0f4e`

**Workflow:** `ml-autoresearch` (arena competitiva de ML)
**Task:** `dataset_path=data/classification.csv target_column=species` (dataset Iris, 150×5, multiclasse balanceado)
**Início:** 2026-07-24 18:43:02 UTC
**Monitoramento:** 18:45 → 18:56 UTC (~11 min), somente leitura — **nenhuma interferência na execução**
**Status final observado:** `running`, travado em `feature_engineering` (round 0) — **loop infinito de heartbeat**

---

## Resumo executivo

O run iniciou corretamente: o agente **data-analyst** completou a fase EDA em ~80s, gerando config e 5 figuras. Em seguida o pipeline avançou para o step **`features`** (feature-engineer), onde **travou num loop infinito**: o agente é spawnado, falha em obter trabalho, é classificado como `heartbeat` e relançado repetidamente, sem nunca progredir para as fases `arena` e `report`.

**Causa raiz (bug confirmado e reproduzido 3×):** o prompt do harness instrui o agente a executar `node "<path>/bin/formiga" step peek ...`, mas `bin/formiga` é um **shell script POSIX** (`#!/bin/sh`), não um módulo JS. Rodar um shell script com `node` produz `SyntaxError: Invalid or unexpected token`. O agente se recupera, executa o peek corretamente via shell, recebe `NO_WORK`, e o harness classifica a ausência de `STATUS: done` como heartbeat → agente encerrado → ciclo recomeça com backoff.

---

## Timeline de eventos (event log JSONL)

| Hora (UTC) | Evento | Detalhe |
|---|---|---|
| 18:43:02 | `run.started` | Run #3 |
| 18:43:02 | `agent.spawned` | data-analyst (PID 58061) |
| 18:43:09 | `step.running` | eda |
| 18:44:22 | `step.done` | eda ✅ |
| 18:44:22 | `agent.spawned` | feature-engineer (PID 58397) |
| 18:44:30 | `step.running` | features |
| 18:44:48 | `agent.completed` | **outcome=heartbeat** ❌ |
| 18:46:22 | `agent.spawned` | feature-engineer (PID 58849) |
| 18:46:27 | `agent.completed` | **outcome=heartbeat** ❌ |
| 18:48:22 | `agent.spawned` | feature-engineer (PID 59212) |
| 18:48:28 | `agent.completed` | **outcome=heartbeat** ❌ |
| 18:50:22 | `agent.spawned` | feature-engineer (PID 59673) |
| 18:50:49 | `agent.completed` | **outcome=heartbeat** ❌ |
| 18:52:22 | `agent.spawned` | feature-engineer (PID 60694) |
| 18:52:41 | `agent.completed` | **outcome=heartbeat** ❌ |
| 18:54:22 | `agent.spawned` | feature-engineer (PID 61706) |
| 18:55:07 | `agent.completed` | **outcome=heartbeat** ❌ |

**Totais no período observado:** 7 spawns do feature-engineer, 6 heartbeats consecutivos, zero avanço de pipeline. Intervalo entre spawns ≈ 2 min (backoff leve, não exponencial agressivo como o código sugere — ver "Anomalia secundária").

---

## Fase 1 — EDA (data-analyst): ✅ sucesso

Concluída normalmente. Artefatos produzidos em `runs/367d0f4e-.../`:
- `artifacts/eda_config.json` — scaling standard para todas as 4 features, 2 interações sugeridas, `random_state 42`.
- `reports/01_eda.md` — shape 150×5, target `species` multiclasse (3×50), sem missing/sentinelas.
- `figures/` — 5 PNGs: `target_distribution`, `correlation_heatmap`, `feature_distributions`, `scatter_vs_target`, `outliers_boxplot`.

**Observação:** o pi-output do data-analyst atingiu **62 MB** (streaming de tokens muito verboso — possível otimização de logging). O agente usou o modelo `kimi-k2.6` via `ifood-genplat`.

---

## Fase 2 — Features (feature-engineer): ❌ travado em loop de heartbeat

### O bug (reproduzido em 3 capturas independentes)

O agente feature-engineer recebe o prompt do polling (`buildPollingPrompt` em `src/installer/scheduler/prompts.ts:177`) contendo:

```
PHASE 1: PEEK
Run this exact command and capture its output:
node "<cli>" step peek "<agentId>" --run-id "<runId>"
```

onde `<cli>` = `resolveFormigaCli()` = `bin/formiga`.

`bin/formiga` é um **shell script** (`#!/bin/sh`) que internamente faz `exec node .../dist/cli/cli.js`. O comentário em `src/installer/paths.ts:110-111` explicita a escolha pelo shell launcher para centralizar flags do Node — **mas o prompt o envolve com `node "..."`**, o que é uma contradição.

#### Sequência observada em cada rodada (idêntica):

1. **Tool call (bash):** `node "<repo>/bin/formiga" step peek "ml-autoresearch_feature-engineer" --run-id "367d0f4e-..."`
   **Resultado:**
   ```
   file:///.../bin/formiga:2
   # Formiga CLI entry point
   ^
   SyntaxError: Invalid or unexpected token
       at compileSourceTextModule (node:internal/modules/esm/utils:355:16)
       ...
   ```

2. **Tool call (bash):** `file "<repo>/bin/formiga" && head -5 "<repo>/bin/formiga"`
   **Resultado:** `POSIX shell script text executable, ASCII text` / `#!/bin/sh`

3. **Raciocínio do agente (kimi-k2.6):**
   > "it's a shell script. The user instruction said to run it with node, but that's incorrect because the file is a shell script... I should run it as a shell script instead... The user's exact command is erroneous. I need to adapt and run it properly."

4. **Tool call (bash):** `"<repo>/bin/formiga" step peek "ml-autoresearch_feature-engineer" --run-id "367d0f4e-..."`
   **Resultado:** `NO_WORK`

5. O agente não produz `STATUS: done`. O parser (`classifyPollingRoundOutcome` em `src/installer/scheduler/polling-parser.ts:34`) classifica o output como **`heartbeat`**. Agente encerrado. Scheduler relança. Ciclo recomeça.

### Anomalia secundária: `NO_WORK` apesar do step estar "running"

O status do pipeline mostra `features` como `[running]` atribuído ao feature-engineer, mas `step peek` retorna `NO_WORK` — ou seja, **não há step pendente atribuível via peek**. Isso cria um impasse: o step foi marcado como "running" (claimado), mas o peek não o expõe como trabalho disponível. O agente nunca consegue claimar o trabalho que já deveria ser seu. Precisa de investigação adicional no `step peek` vs. estado "running" do step.

### Comportamento do backoff

O código (`src/installer/scheduler/shared.ts:91`) define backoff exponencial a partir de 3 heartbeats consecutivos (skip 1→2→4→8 rounds, cap 8). Na prática, os spawns permaneceram a ~2 min de intervalo (18:44→18:46→18:48→18:50→18:52→18:54), sugerindo que o contador de heartbeats está sendo **resetado** em algum ponto ou o backoff não está acumulando como esperado — outra anomalia a investigar.

### Efeito no dashboard

O campo `updatedAt` da API ficou em `18:44:30` (quando `features` iniciou) durante todo o loop — **o status da API não é atualizado a cada polling round de heartbeat**. Assim, o dashboard aparenta estar "parado" em `feature_engineering` enquanto o scheduler continua ativo em background.

---

## Evidências coletadas

Diretório: `/tmp/formiga-run-367d0f4e-watch/`

| Arquivo | Conteúdo |
|---|---|
| `evidence/events.jsonl` | Log estruturado completo de eventos do run |
| `evidence/formiga-logs.txt` | Saída legível de `formiga logs 367d0f4e` |
| `evidence/workflow-status.txt` | `formiga workflow status 367d0f4e` |
| `evidence/api-status.json` | Snapshot da API `/api/pipeline/status` |
| `evidence/run-artifacts-list.txt` | Lista de artefatos do run |
| `pioutput-captured/*.log` | **3 capturas** do pi-output efêmero do feature-engineer (logs que são apagados após o agente encerrar), capturadas por um watcher de alta frequência |
| `status-timeline.log` | Timeline de polling de status (15s) |

**Fontes de código relevantes:**
- `src/installer/scheduler/prompts.ts:79,177` — prompt instrui `node "<cli>"` (bug)
- `src/installer/paths.ts:109-113` — `resolveFormigaCli()` retorna `bin/formiga` (shell script)
- `src/installer/scheduler/polling-parser.ts:34-40` — classificação de heartbeat
- `src/installer/scheduler/shared.ts:91-101` — lógica de backoff
- `workflows/ml-autoresearch/workflow.yml` — definição do workflow

---

## Conclusão e impacto

- **O run `367d0f4e` não vai completar** enquanto estiver rodando com o código atual. Está preso em loop de heartbeat no step `features` e nunca alcançará `arena` nem `report`.
- Tokens reportados: `0` (o backoff suprime contagem/registro de eventos após heartbeats consecutivos, `polling-round.ts:691`).
- O data-analyst funcionou porque sua fase não dependia do peek via `node bin/formiga` (recebeu o trabalho de outra forma); o feature-engineer, porém, depende do polling prompt com o comando inválido.

## Sugestões de correção (não aplicadas — monitoramento only)

1. **Principal:** em `prompts.ts`, não envolver o CLI com `node`. Trocar `node "${cli}"` por `"${cli}"` (ou `sh "${cli}"`) já que `resolveFormigaCli()` retorna o shell launcher. Aplicar às linhas 79, 86, 96, 97, 124, 125, 177 e demais.
2. **Alternativa:** fazer `resolveFormigaCli()` retornar `dist/cli/cli.js` (módulo JS) para que `node "<cli>"` funcione — mas isso descarta a centralização de flags do Node que o shell launcher provê.
3. **Defesa em profundidade:** o parser poderia tratar `SyntaxError`/falha do peek como `work_failed` em vez de `heartbeat`, evitando o loop silencioso e sinalizando o erro.
4. Investigar por que `step peek` retorna `NO_WORK` para um step marcado como `running`.
5. Investigar por que o backoff não está acumulando exponencialmente conforme o código.

---

*Relatório gerado por monitoramento passivo. Nenhum comando de pausa/stop/resume foi executado contra o run, conforme solicitado.*
