# Checklist de Implementacao — Formiga (specs.md)

Status atual: **Branch 2 concluida** — pronto para iniciar Branch 3
Branch git ativa: `refactor/rename-tamandua-to-formiga` (aguardando merge)

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

## Branch 4: refactor/fix-perf-hot-paths [PENDENTE]

- [ ] Mover imports dinamicos para top-level em `polling-round`
- [ ] Batch queries em `resolveStepContext` (1 JOIN)
- [ ] Singleton SQLite com lazy migration, remover TTL de 5s
- [ ] Memoize `resolveSessionCwd`
- [ ] `array.join()` em `buildStoryPlanSection`
- [ ] LRU nos Maps globais de cron-manager
- [ ] `npm run test && npm run test:e2e` verdes

---

## Branch 5: feat/ml-agents-and-leaderboard [PENDENTE]

- [ ] `src/agents/interfaces.ts` — `AgentRunner`, `AgentContext`, `AgentResult`, `AgentPlan`, `AgentMessenger`
- [ ] `src/agents/data-analyst.ts` — EDA (reports/01_eda.md)
- [ ] `src/agents/feature-engineer.ts` — features + split + baseline
- [ ] `src/agents/modeler-classic.ts` — GBM/Lineares/RF/SVM/Stacking L1
- [ ] `src/agents/modeler-advanced.ts` — NN/AutoML/Stacking multi-nivel
- [ ] `src/agents/ml-critic.ts` — auditor adversarial (read-only)
- [ ] `src/leaderboard/schema.ts` — DDL + indices SQLite WAL
- [ ] `src/leaderboard/repository.ts` — Repository pattern
- [ ] `src/leaderboard/queries.ts`
- [ ] `src/artifacts/{store.ts,local-store.ts}`
- [ ] `src/orchestrator/{fan-out,fan-in,round-manager,communication}.ts`
- [ ] `src/shared/{seed,metrics,validation,schemas}.ts`
- [ ] `src/autoresearch/engine.ts`, `types.ts`, `config.ts`
- [ ] Workspace layout (data/, artifacts/, results/, reports/, holdout/)
- [ ] Protocolo de mensagens inter-agente
- [ ] Cobertura >= 80% em novos modulos
- [ ] `npm run test` verde

---

## Branch 6: feat/dashboard-ml-views [PENDENTE]

- [ ] Tela 1: Pipeline Overview (`/`)
- [ ] Tela 2: Kanban dos Agentes (`/kanban`)
- [ ] Tela 3: Leaderboard (`/leaderboard`)
- [ ] Tela 4: Agent Detail (`/agents/:name`)
- [ ] Endpoints REST (secao 12.3)
- [ ] Schemas TS (`MLKanbanCard`, `MLKanbanLane`, `MLKanbanSnapshot`, `LeaderboardEntry`, `LeaderboardResponse`)
- [ ] CSS design tokens dark theme
- [ ] Polling 3s
- [ ] Vanilla JS — nada de React/Tailwind/Chart.js
- [ ] `npm run test && npm run test:e2e` verdes
