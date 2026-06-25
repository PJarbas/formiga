# Checklist de Implementacao — Formiga (specs.md)

Status atual: **Branch 1 em andamento**
Branch git ativa: `refactor/remove-orphan-code`

---

## Branch 1: refactor/remove-orphan-code [EM ANDAMENTO]

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

### Pendente
- [ ] Ajustar/stub imports remanescentes em:
  - `src/autoresearch/autoresearch.test.ts`
  - `src/server/daemon.ts`
  - `src/server/dashboard.ts`
  - `src/server/daemonctl.ts`
  - `src/server/control-server.ts`
  - `src/cli/cli.ts`
  - `src/cli/status-format.ts`
  - `src/installer/agent-scheduler.ts`
  - `src/installer/status.ts`
  - `src/installer/step-ops.ts`
  - `src/installer/install.ts`
  - `src/installer/run.ts`
- [ ] Ajustar/deletar testes restantes que dependem dos orfaos
- [ ] `npm run test` verde (ou pelo menos sem regressao)
- [ ] `git commit` da Branch 1

---

## Branch 2: refactor/rename-tamandua-to-formiga [PENDENTE]

- [ ] `package.json`: name, bin
- [ ] `bin/tamandua` -> `bin/formiga`
- [ ] Find&replace identificadores (TamanduaXxx -> FormigaXxx, defaultTamanduaDir -> defaultFormigaDir, etc)
- [ ] README, AGENTS.md, scripts, dashboard CSS/HTML
- [ ] Vars de ambiente + paths default
- [ ] `npm run test && npm run build` verdes

---

## Branch 3: refactor/break-god-objects [PENDENTE]

- [ ] `agent-scheduler.ts` (2070 LOC) -> `scheduler/{cron-manager,process-spawner,polling-round,binary-discovery}`
- [ ] `step-ops.ts` (1878 LOC) -> `steps/{state-machine,story-manager,template-resolver,pipeline-control}`
- [ ] `db.ts` (450 LOC) -> `database/{connection,migrations,session-repo,token-repo}`
- [ ] Eliminar 5 import cycles restantes via `types.ts`
- [ ] Cada modulo < 400 LOC
- [ ] `npm run test && npx madge --circular src/` verdes

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
