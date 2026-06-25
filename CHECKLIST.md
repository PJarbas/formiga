# Checklist de Implementacao — Formiga (specs.md)

Status atual: **Branch 5 completa** — iniciando Branch 6
Branch git ativa: `feat/ml-agents-and-leaderboard`

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

## Branch 6: feat/dashboard-ml-views [PENDENTE]

### Stack
- [ ] Setup `src/dashboard/` com **Vite + React 18 + TypeScript**
- [ ] **Tailwind CSS** configurado (tema dark via `darkMode: 'class'`, design tokens em `tailwind.config.ts`)
- [ ] **TanStack Query** com `refetchInterval: 3000` para polling
- [ ] **React Router** (data router) com rotas para as 4 telas
- [ ] **Apache ECharts** (`echarts` + `echarts-for-react`) para graficos
- [ ] Build integrado ao `npm run build` (Vite -> `dist/dashboard/`), servido pelo `http` nativo
- [ ] Tipos compartilhados em `src/shared/dashboard-types.ts` (import tanto no server quanto no frontend)

### Telas
- [ ] Tela 1: Pipeline Overview (`/`) — header com run info + 5 cards de agentes + quick stats
- [ ] Tela 2: Kanban dos Agentes (`/kanban`) — lanes responsivas, card-detail em dialog
- [ ] Tela 3: Leaderboard (`/leaderboard`) — tabela ordenavel + chart ECharts de evolucao do `cv_mean`
- [ ] Tela 4: Agent Detail (`/agents/:name`) — plano, trials, logs paginados

### Backend
- [ ] Endpoints REST (secao 12.3) servidos pelo `http` nativo
- [ ] Schemas TS (`MLKanbanCard`, `MLKanbanLane`, `MLKanbanSnapshot`, `LeaderboardEntry`, `LeaderboardResponse`) em `src/shared/dashboard-types.ts`

### Qualidade
- [ ] Testes de componente (React Testing Library + Vitest ou node:test com jsdom)
- [ ] `npm run test && npm run test:e2e` verdes
- [ ] Lighthouse score >= 90 (performance) no build de producao
