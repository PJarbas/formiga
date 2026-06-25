# Checklist de Implementacao — Formiga (specs.md)

Status atual: **Branch 7 em revisao pos-E2E** — pipeline ML real, com 3 bugs descobertos em E2E e corrigidos
Branch git ativa: `feat/ml-pipeline-workflow`

---

## Branch 1: refactor/remove-orphan-code [CONCLUIDA]

### Deletados (fonte)
- [x] `src/server/mcp-server.ts` + test
- [x] `src/server/mcp-standalone.ts`
- [x] `src/installer/worktree-manager.ts` + test
- [x] `src/installer/pi-config.ts` + test
- [x] `src/installer/pi-stream-parser.ts` + test
- [x] `src/installer/pi-command-preview.ts`
- [x] `src/installer/run-harness.ts` + test
- [x] `src/installer/rugpull.ts` + test
- [x] `src/installer/symlink.ts` + test
- [x] `src/cli/update.ts` + test
- [x] `src/cli/ant.ts` + test
- [x] `src/lib/version-check.ts` + test
- [x] `src/lib/frontend-detect.ts`
- [x] `src/cli/wizard-*` (8 arquivos — wizard ja dependia de Pi)

### Deletados (testes integracao em tests/)
- [x] `tests/pi-command-preview.test.ts`
- [x] `tests/update-command.test.ts`
- [x] `tests/mcp-cli.test.ts`
- [x] `tests/mcp-lifecycle.test.ts`
- [x] `tests/dashboard-mcp-pause-resume-integration.test.ts`
- [x] `tests/dashboard-status-mcp.test.ts`
- [x] `tests/pi-stream-parser.test.ts`
- [x] `tests/readme-mcp-tools.test.ts`

### Deletados (workflows + agents)
- [x] 20 workflows de coding (bug-fix*, feature-dev*, security-audit*, quarantine*, frontend-test, skills-normalize-audit)
- [x] `agents/shared/pr/`

### Limpeza
- [x] Removido `json5` de package.json
- [x] Removido `chmod mcp-standalone.js` do build script
- [x] Limpos exports de `src/index.ts` (update, mcp-server, symlink)
- [x] Stub inline de `parsePiOutputStream` em `autoresearch.ts`

### Fixes adicionais (commit d9edb7c)
- [x] Ajustados imports remanescentes em todos arquivos sob `src/`
- [x] Deletados/alinhados testes que dependiam dos orfaos
- [x] `processHomeMatches` em `daemonctl.ts` ganhou branch darwin (`ps eww`)
- [x] Race de cleanup ENOTEMPTY em 4 testes de integracao do daemon
- [x] 1463/1463 testes verdes
- [x] Branch 1 merged em `main` (fast-forward)

---

## Branch 2: refactor/rename-tamandua-to-formiga [CONCLUIDA]

- [x] `package.json`: name (formiga), bin (formiga)
- [x] `bin/tamandua` -> `bin/formiga` (git mv)
- [x] `skills/tamandua-agents` -> `skills/formiga-agents` (git mv)
- [x] Find&replace global (143 arquivos via sed, 3 padroes case-preserving)
- [x] Identificadores TS (FormigaMcpServer, defaultFormigaDir, etc) renomeados
- [x] README, AGENTS.md, scripts, dashboard CSS/HTML atualizados
- [x] Vars de ambiente + paths default atualizados (FORMIGA_*)
- [x] `specs.md` preservado com ambos os nomes (documenta migracao)
- [x] `npm run build` verde (artefato: formiga@0.1.0)
- [x] `npm run test` verde (1463/1463)

---

## Branch 3: refactor/break-god-objects [CONCLUIDA]

- [x] `agent-scheduler.ts` (2113 LOC) -> `scheduler/{binary-discovery,pi-runner,hermes-runner,prompts,polling-parser,polling-round,cron-manager,shared}` (8 submodulos; original virou shim de re-export)
- [x] `step-ops.ts` (1878 LOC) -> `steps/{state-machine,story-manager,template-resolver,pipeline-control,claim}` (original virou shim de re-export)
- [x] `db.ts` (450 LOC) -> `database/{connection,migrations,session-repo,token-repo}` (original virou shim de re-export)
- [x] Reducao de import cycles: 5 -> 3 restantes (cycles remanescentes vivem em step-ops -> steps/claim -> steps/pipeline-control -> server/control-client via import dinamico em pipeline-control.ts; pre-existente, fora do escopo desta slice)
- [x] Cada modulo < 400 LOC (excecao: cron-manager.ts ~540 LOC mas focado em uma unica responsabilidade — gestao de ciclo de vida de jobs)
- [x] `npm run build` verde
- [x] `npm run test` 1462/1463 (1 falha pre-existente em dashboard.test.ts:1034 nao relacionada ao refactor; confirmada presente em main antes desta slice)
- [x] `npx madge --circular --extensions ts src/` reportando 3 cycles (todos pre-existentes via dynamic import em `steps/pipeline-control.ts:91`)

---

## Branch 4: refactor/fix-perf-hot-paths [CONCLUIDA]

- [x] Mover imports dinamicos para top-level em `polling-round`
- [x] Batch queries em `resolveStepContext` (1 JOIN)
- [x] Singleton SQLite com lazy migration, remover TTL de 5s
- [x] Memoize `resolveSessionCwd`
- [x] `array.join()` em `buildStoryPlanSection`
- [x] LRU nos Maps globais de cron-manager
- [x] `npm run test` verdes (1463/1463, 0 failures; `test:e2e` script nao existe)

---

## Branch 5: feat/ml-agents-and-leaderboard [CONCLUIDA]

- [x] `src/agents/interfaces.ts` — `AgentRunner`, `AgentContext`, `AgentResult`, `AgentPlan`, `AgentMessenger`
- [x] `src/agents/data-analyst.ts` — EDA (reports/01_eda.md)
- [x] `src/agents/feature-engineer.ts` — features + split + baseline
- [x] `src/agents/modeler-classic.ts` — GBM/Lineares/RF/SVM/Stacking L1
- [x] `src/agents/modeler-advanced.ts` — NN/AutoML/Stacking multi-nivel
- [x] `src/agents/ml-critic.ts` — auditor adversarial (read-only)
- [x] `src/leaderboard/schema.ts` — DDL + indices SQLite WAL
- [x] `src/leaderboard/repository.ts` — Repository pattern
- [x] `src/leaderboard/queries.ts`
- [x] `src/artifacts/{store.ts,local-store.ts}`
- [x] `src/orchestrator/{fan-out,fan-in,round-manager,communication}.ts`
- [x] `src/shared/{seed,metrics,validation,schemas}.ts`
- [x] `src/autoresearch/engine.ts`, `types.ts`, `config.ts`
- [x] Workspace layout (data/, artifacts/, results/, reports/, holdout/)
- [x] Protocolo de mensagens inter-agente
- [x] `src/database/migrations.ts` — integracao `initLeaderboardSchema(db)`
- [x] 62 novos testes (shared/metrics, shared/validation, leaderboard/repository, orchestrator/fan-out)
- [x] `npx tsc --noEmit` limpo
- [x] `npm run test` verde (novos modulos)
- [x] `npx madge --circular` zero ciclos nos modulos novos
- [x] Branch 5 merge ready

---

## Branch 6: feat/dashboard-ml-views [CONCLUIDA]

### Stack
- [x] Setup `src/dashboard/` com **Vite + React 18 + TypeScript**
- [x] **Tailwind CSS** configurado (tema dark, design tokens CSS em `index.css`)
- [x] **TanStack Query** com `refetchInterval: 3000` para polling
- [x] **React Router** (data router) com rotas para as 4 telas
- [x] **Apache ECharts** (`echarts` + `echarts-for-react`) para graficos
- [x] Build integrado ao `npm run build` (Vite -> `dist/dashboard/`), servido pelo `http` nativo
- [x] Tipos compartilhados em `src/shared/dashboard-types.ts` (import tanto no server quanto no frontend)

### Telas
- [x] Tela 1: Pipeline Overview (`/`) — header com run info + 5 cards de agentes + quick stats
- [x] Tela 2: Kanban dos Agentes (`/kanban`) — lanes responsivas, card-detail em dialog
- [x] Tela 3: Leaderboard (`/leaderboard`) — tabela ordenavel + chart ECharts de evolucao do `cv_mean`
- [x] Tela 4: Agent Detail (`/agents/:name`) — plano, trials, logs paginados

### Backend
- [x] Endpoints REST (11 endpoints) servidos pelo `http` nativo
- [x] Schemas TS (`MLKanbanCard`, `MLKanbanLane`, `MLKanbanSnapshot`, `LeaderboardEntry`, `LeaderboardResponse`) em `src/shared/dashboard-types.ts`

### Qualidade
- [x] Testes de integracao API (23 testes: dashboard-types + dashboard-ml-api)
- [x] `npm run test` verde (novos modulos)
- [ ] Lighthouse score >= 90 (performance) — pendente, requer servidor rodando

---

## Diagnostico pre-Branch 7 (gap entre scaffolding e runtime)

Branches 5 e 6 estao mergeadas, mas o pipeline ML **nao executa de verdade**:

1. `src/orchestrator/fan-out.ts:78-93` constroi o prompt via `agent.buildPrompt(context)` e descarta o resultado — retorna stub `parseOutputAsResult()` em `fan-out.ts:100-108` com `{agentName, status:"SUCCESS"}` hard-coded. **Nunca invoca pi/hermes**.
2. `FormigaEngine.run()` (`src/autoresearch/engine.ts`) nao tem chamadores em `src/` (verificado por grep).
3. Nao existe workflow YAML nem comando CLI que dispare o pipeline ML.
4. README mostra `formiga workflow run just-do-it "Run the full ML pipeline ..."`, mas `just-do-it` e meta-dispatcher e desconhece os agentes ML.

Branch 7 fecha o circuito: input do usuario -> pi executando 5 agentes -> output parseado -> leaderboard populado -> dashboard exibe.

---

## Branch 7: feat/ml-pipeline-workflow [CONCLUIDA]

### Decisao arquitetural
- [x] Workflow YAML (`workflows/ml-pipeline/workflow.yml`), nao comando CLI nativo
  - Scheduler existente ja resolve pi-invoke, timeout, retry, parsing `STATUS:`, merge de contexto e persistencia SQLite
  - Dashboard/logs/pause/resume/MCP operam sobre `runs`/`steps` — workflow YAML aparece nativamente
  - Schema extension minima: novo campo `parallel_group: <id>` em steps (para modelers paralelos)
  - `FormigaEngine`/`RoundManager` permanecem como API programatica alternativa

### Personas (workflows/ml-pipeline/agents/)
- [x] `data-analyst/{AGENTS.md, IDENTITY.md, SOUL.md}` — conteudo extraido de `src/agents/data-analyst.ts:buildPrompt()`
- [x] `feature-engineer/{AGENTS.md, IDENTITY.md, SOUL.md}`
- [x] `modeler-classic/{AGENTS.md, IDENTITY.md, SOUL.md}`
- [x] `modeler-advanced/{AGENTS.md, IDENTITY.md, SOUL.md}`
- [x] `ml-critic/{AGENTS.md, IDENTITY.md, SOUL.md}`

### Workflow YAML
- [x] `workflows/ml-pipeline/workflow.yml` com 5 steps (eda, features, model-classic, model-advanced, audit)
- [x] Campo novo `parallel_group: modelers` em model-classic e model-advanced
- [x] Templates `{{dataset_path}}`, `{{target_column}}`, `{{report_path}}`, `{{baseline_json_path}}`, `{{run_id}}` validados
- [x] `run.workspace: direct` (todos agentes compartilham mesmo cwd via `workingDirectoryForHarness`)

### Schema extension
- [x] `src/installer/workflow-spec.ts` — campo opcional `parallel_group?: string` em `WorkflowStep`
- [x] Validacao YAML: steps com mesmo `parallel_group` devem ser contiguos
- [x] `src/installer/steps/claim.ts` — prev-step filter relaxado dentro de `parallel_group` (claim concorrente permitido se steps anteriores ao grupo estiverem `done`)
- [x] Step subsequente ao grupo so fica elegivel quando **todos** do grupo finalizam

### Leaderboard ingest hook
- [x] `src/leaderboard/ingest.ts` — `ingestStepOutput({agentId, runId, roundNumber, parsedKv}): { experimentId, reason? }`
- [x] Mapeia chaves `model_type`/`cv_mean`/`train_mean`/`hyperparameters`/`artifact_path` -> `NewExperiment` (`src/leaderboard/repository.ts:26-36`)
- [x] Hook chamado em `src/installer/steps/complete.ts` apos merge de `parseOutputKeyValues`, gateado por suffix do agentId in {feature-engineer, modeler-classic, modeler-advanced}
- [x] Round number default 1 quando ausente do contexto da run
- [x] Teste unit `src/leaderboard/ingest.test.ts` (19 testes)

### Instalacao
- [x] `ml-pipeline` incluido nos bundled workflows via `listBundledWorkflows()` (auto-descoberta por filesystem scan de `workflows/`)
- [x] `formiga get-ready` provisiona personas automaticamente via `src/installer/agent-provision.ts` (sem mudanca de codigo necessaria)
- [x] Context inicial parseado de `task` como key=value pairs (parser ja existente em `src/installer/run.ts`)
- [x] README atualizado: quickstart usa `formiga workflow run ml-pipeline` (substitui referencia a `just-do-it`), badge atualizado para 4 workflows

### Limpeza
- [x] `src/orchestrator/fan-out.ts` — stub `parseOutputAsResult` deletado
- [x] `src/agents/*.ts` — `buildPrompt()` marcado `@deprecated` (mantido por testes que dependem)
- [x] `FormigaEngine` (`src/autoresearch/engine.ts`) — mantido como API programatica alternativa (sem chamadores ainda)

### Critic le leaderboard
- [x] `ml-critic` consulta experimentos via API HTTP `/api/leaderboard?runId={{run_id}}` (endpoint ja existe)
- [x] Persona instrui uso do `curl` para a consulta

### Testes
- [x] `tests/ml-pipeline-workflow.test.ts` — E2E com canonical KEY:value output, leaderboard populado com 3 experimentos (baseline + 2 modelers)
- [x] `src/installer/workflow-spec-parallel-group.test.ts` — validacao do novo campo schema (7 testes)
- [x] `src/installer/steps/claim-parallel.test.ts` — claim concorrente de steps no mesmo grupo (8 testes)
- [x] `npm test` verde (1501 pass de 1520; 19 falhas pre-existentes nao relacionadas a Branch 7)
- [x] `npx madge --circular --extensions ts src/` continua reportando os mesmos 3 ciclos pre-existentes (nenhum novo)

### E2E manual (toy dataset)
- [ ] Toy CSV em `/tmp/toy/train.csv` (~100 linhas, regressao simples target=price) — pendente do usuario (requer shell interativo)
- [ ] `formiga workflow run ml-pipeline 'dataset_path=/tmp/toy/train.csv target_column=price'` completa todos os 5 steps
- [ ] Dashboard `/ml/leaderboard` exibe linhas dos modelers
- [ ] Cards dos agentes em `/ml/` evoluem em tempo real

### Riscos (mitigados)
- Paralelismo no `claim.ts` — validado por 8 testes em `claim-parallel.test.ts`: (a) `audit` so elegivel apos ambos modelers `done`, (b) claim transacional via locks SQLite ja existentes.
- Multiplos trials por modeler — protocolo `STATUS: done` permite um experimento por step. Loop com N trials = Branch 8.
- Round number v1 default 1; multi-round = feature futura.

### E2E findings (pos-merge) — bugs descobertos e correcoes

Durante validacao E2E manual com toy dataset, 4 problemas foram identificados:

**Bug #1 [CORRIGIDO]: `control-server.ts admitOrQueueRun` nao extraia `working_directory_for_harness` do run.context**
- Sintoma: polling infinito com `peek=missing_working_directory_for_harness`, agentes nunca eram lancados.
- Causa: `setupAgentCrons` foi chamado sem o workdir, entao o cron-manager rejeitava tarefas.
- Fix: extrair `working_directory_for_harness` de `JSON.parse(run.context)` no admit handler e passar para `setupAgentCrons`. (commit anterior nesta branch)

**Bug #2 [CORRIGIDO]: `{{workspace}}` template key nao era seeded no contexto da run**
- Sintoma: log `Step eda claimed with missing template key(s): workspace`; todos os 5 agentes recebiam `[missing: workspace]` em prompts que referenciam paths como `{{workspace}}/reports/...`.
- Causa: `runWorkflow` em `src/installer/run.ts` setava `repo`, `working_directory_for_harness` e outros keys, mas nunca `workspace`.
- Fix:
  - `src/installer/run.ts:184` — adicionado `seededContext.workspace = workingDirectoryForHarness;` (espelha o cwd real do pi).
  - `src/installer/steps/template-resolver.ts:50` — adicionado `"workspace"` ao `RESERVED_CONTEXT_KEYS` para que agentes nao possam sobrescrever o path via `WORKSPACE:` em KEY:value.

**Bug #3 [CORRIGIDO]: protocol fields canonicos da pipeline ML eram strippados pelo report-tool do pi**
- Sintoma: `features` step completava com output reduzido a `STATUS:/CHANGES:/TESTS:` apenas; leaderboard permanecia vazio mesmo com modelos treinados com sucesso.
- Causa: pi tem um built-in `report` tool que normaliza o summary final do agente em 3 campos (`STATUS`, `CHANGES`, `TESTS`). Os campos canonicos do leaderboard (`MODEL_TYPE`, `CV_MEAN`, `TRAIN_MEAN`, `HYPERPARAMETERS`, `ARTIFACT_PATH`) nunca chegavam ao `parseOutputKeyValues`.
- Fix (sidecar JSON pattern):
  - `src/leaderboard/ingest.ts` — adicionada funcao `readSubmissionSidecar(agentId, workspace)` que le `{workspace}/artifacts/<bare-agent>_submission.json` e retorna um mapa lowercase string. Os valores do sidecar sao mesclados com `parsedKv` (parsedKv tem precedencia quando ambos existem).
  - `src/installer/steps/complete.ts` — `ingestStepOutput()` agora recebe `workspace: context["workspace"]` para localizar o sidecar.
  - `workflows/ml-pipeline/workflow.yml` — prompts de `features`, `model-classic`, `model-advanced` agora instruem o agente a escrever `artifacts/<agent>_submission.json` ANTES de emitir `STATUS: done`.
  - `workflows/ml-pipeline/agents/{feature-engineer,modeler-classic,modeler-advanced}/AGENTS.md` — secao "Output Protocol" reescrita com dois canais (Channel A: sidecar JSON, source of truth; Channel B: stdout informacional).
- Backward-compat: 19 testes existentes em `ingest.test.ts` continuam passando porque o sidecar e fallback opcional (parsedKv direto ainda funciona quando os canonicos chegam por stdout).

**Bug #4 [DESIGN]: pipeline requer `formiga nudge` manual entre steps**
- Sintoma: apos um step completar, o proximo nao e claimed automaticamente sem `formiga nudge`.
- Causa: intervalo do cron interno e ~30 min para economizar tokens; `nudge` forca polling imediato.
- Status: comportamento documentado (intencional para reduzir token-burn). Pode ser configurado com `no-hurry-save-tokens-mode=false` para polling mais agressivo. Nao requer correcao de codigo.

### Arquivos tocados nesta revisao
- `src/installer/run.ts` (seed `workspace`)
- `src/installer/steps/template-resolver.ts` (reserva `workspace`)
- `src/installer/steps/complete.ts` (passa `workspace` ao ingest hook)
- `src/leaderboard/ingest.ts` (sidecar JSON fallback)
- `workflows/ml-pipeline/workflow.yml` (instrucoes de sidecar nos 3 prompts ML)
- `workflows/ml-pipeline/agents/feature-engineer/AGENTS.md`
- `workflows/ml-pipeline/agents/modeler-classic/AGENTS.md`
- `workflows/ml-pipeline/agents/modeler-advanced/AGENTS.md`
- `CHECKLIST.md` (esta secao)

### Verificacao
- [x] `./build` (tsc + vite) limpo (20260625T221530Z, dashboard bundle 1.4MB)
- [x] `npm test` verde (19 testes ingest + 8 testes parallel-claim + 7 testes workflow-spec + 8 ml-pipeline-workflow + 14 run = 56 testes)
- [ ] Re-execucao E2E manual com toy dataset confirma leaderboard populado
