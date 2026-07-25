# Spec: Resiliência e Hardening do Harness — Formiga

**Status:** Draft (para validação)
**Autor:** Arquitetura
**Origem:** Monitoramento do run `367d0f4e` → [run-367d0f4e-monitor-report.md](run-367d0f4e-monitor-report.md)
**Data:** 2026-07-24

---

## 0. Contexto e Motivação

O run `367d0f4e` (workflow `ml-autoresearch`, dataset Iris) travou permanentemente no step `features` sem nunca completar. O travamento não teve causa única: foi uma **falha em cascata de 3 camadas de defesa**, cada uma parecendo correta isoladamente. Esta spec formaliza o diagnóstico e define as correções para tornar o projeto resiliente a essa classe de falhas.

### Princípio arquitetural norteador

> **O formiga não deve depender de o modelo LLM digitar um comando externo corretamente para descobrir se há trabalho.** A descoberta de trabalho é responsabilidade do orquestrador, não do agente.

O estado de "há trabalho para o agente X?" já é conhecido pelo formiga (ele consulta o SQLite). Hoje essa informação é delegada ao agente via um prompt em texto natural que instrui rodar `node bin/formiga step peek`. Isso inverte a confiança: o sistema confiável depende de uma ação incerta do modelo. Esta spec corrige essa inversão.

---

## 1. Diagnóstico Formal da Falha

### 1.1. Falha-1: Contrato do harness instrui comando inválido

- **Arquivo:** [src/installer/scheduler/prompts.ts:79](../../src/installer/scheduler/prompts.ts#L79), [:177](../../src/installer/scheduler/prompts.ts#L177)
- **Sintoma:** O prompt instrui o agente a executar `node "${cli}" step peek ...` onde `${cli}` = `resolveFormigaCli()` = `bin/formiga`.
- **Causa-raiz:** `bin/formiga` é um shell script POSIX (`#!/bin/sh`), não um módulo JS. `node bin/formiga` produz `SyntaxError: Invalid or unexpected token`.
- **Evidência:** Capturado em 3 pi-outputs independentes do feature-engineer; o agente (kimi-k2.6) até raciocina corretamente sobre o erro e reexecuta via shell.
- **Nota:** O comentário em [src/installer/paths.ts:110-111](../../src/installer/paths.ts#L110-L111) justifica o uso do shell launcher para centralizar flags do Node — a decisão é correta; o bug está em envolvê-lo com `node` no prompt.

### 1.2. Falha-2: `step peek` não enxerga steps `running` órfãos

- **Arquivo:** [src/installer/steps/claim.ts:47-63](../../src/installer/steps/claim.ts#L47-L63)
- **Sintoma:** `peekStep()` retorna `HAS_WORK` apenas para steps em status `pending`. O step `features` estava em `running` (claimado pelo 1º feature-engineer, que morreu em heartbeat).
- **Causa-raiz:** Não há re-claim. Um step em `running` cujo processo dono morreu fica **órfão e invisível** ao peek — nenhum agente consegue re-claimá-lo. Impasse permanente.
- **Por que o primeiro feature-engineer claimou e morreu:** combinou Falha-1 (peek quebrou) + mecanismo de heartbeat (ver 1.3).

### 1.3. Falha-3: Heartbeat é tratado como ociosidade, não como falha

- **Arquivo:** [src/installer/scheduler/polling-parser.ts:34-40](../../src/installer/scheduler/polling-parser.ts#L34-L40), [src/installer/scheduler/shared.ts:91-101](../../src/installer/scheduler/shared.ts#L91-L101)
- **Sintoma:** Um agente que nasce, falha em ~6s, e emite só `HEARTBEAT_OK` é classificado como `heartbeat` (sem trabalho). O scheduler relança com backoff.
- **Causa-raiz:** `classifyPollingRoundOutcome` trata output não-`STATUS:done` como heartbeat. Um agente que **falhou em sequer começar o trabalho** é indistinguível de um agente ocioso.
- **Agravação:** O backoff deveria ser exponencial após 3 heartbeats (1→2→4→8, cap 8), mas os spawns ficaram estáveis em ~2 min — o contador de heartbeats consecutivos está sendo resetado em algum ponto (anomalia a investigar na implementação).

### 1.4. Falha-4: Os mecanismos de recuperação não cobriram o caso

- **Reconciler** ([src/medic/reconciler-checks.ts:34](../../src/medic/reconciler-checks.ts#L34)): procura steps `pending` com `claim_pid IS NULL`. Step estava `running` → invisível.
- **Run-timeout** ([src/medic/run-timeout.ts:75](../../src/medic/run-timeout.ts#L75)): exige `claim_pid === null`. Step órfão ainda tinha `claim_pid` do processo morto anotado → invisível.
- **Medic stuck-step** ([src/medic/medic.ts:44-62](../../src/medic/medic.ts#L44-L62)): **este teria pego** — procura steps `running` há >30 min e faz `reset_step`. Mas 30 min é janela longa demais para um loop visível, e depende de `steps.updated_at` estar congelado (o que estava, porque heartbeats não o renovam — ver 1.5).
- **Escalada humana** ([src/installer/steps/fail.ts:33](../../src/installer/steps/fail.ts#L33)): `escalate_to: human` só dispara via `step fail` exausto. Loops de heartbeat nunca chamam `step fail` → escalada inalcançável.

### 1.5. Falha-5: Observabilidade mente durante o loop

- `runs.updated_at` **é** renovado a cada polling round ([polling-round.ts:154](../../src/installer/scheduler/polling-round.ts#L154)), mas `steps.updated_at` e `last_progress_at` **não**.
- Resultado: o campo `updatedAt` exposto pela API ficou em `18:44:30` durante todo o loop, fazendo o dashboard aparentar estar "congelado em feature_engineering" enquanto o scheduler estava ativo.
- `tokens_spent` reportado como `0` durante backoff ([polling-round.ts:691](../../src/installer/scheduler/polling-round.ts#L691) suprime registro) — enganoso.

---

## 2. Escopo

### Inclui (P0–P2)
- Correção do contrato do harness (Falha-1).
- Inversão da descoberta de trabalho para o lado do formiga (elimina a classe de bugs "modelo digitou errado").
- Reconciler de steps `running` órfãos (Falha-2, Falha-4).
- Circuito de heartbeat → `step fail` → escalada (Falha-3, Falha-4).
- Observabilidade honesta: progresso por step, contador de heartbeats/spawns (Falha-5).
- Persistência/truncamento de logs de agente.

### Exclui (P3 — norte de médio prazo)
- Harness em-processo via SDK (reescrita do `pi-runner`/`hermes-runner`). Documentado em §7 como direção futura; não faz parte desta spec.

### Fora de escopo
- Mudanças no algoritmo da arena/leaderboard.
- Refator de UX do dashboard (coberto por `docs/refact.md` / `docs/DASHBOARD_UX_REVIEW.md`).

---

## 3. Requisitos Funcionais

### RF-1 — Comando de peek válido no prompt (P0)
O prompt gerado por `buildAgentPrompt`, `buildWorkPrompt` e `buildPollingPrompt` **não deve** envolver o CLI com `node` quando o CLI for um shell launcher.

- **Aceite:** `resolveFormigaCli()` retorna `bin/formiga` (shell script). O prompt deve invocá-lo como `"${cli}"` (executável direto) ou `sh "${cli}"`, nunca `node "${cli}"`.
- **Aceite:** Existe um teste que valida que nenhum prompt gerado contém a substring `node "` imediatamente antes do caminho do CLI.

### RF-2 — Descoberta de trabalho injetada no prompt (P0)
O formiga já sabe se há trabalho para o agente (consulta SQLite). Essa informação deve ser **injetada diretamente no prompt**, eliminando a dependência de o agente invocar `step peek` corretamente.

- **Aceite:** `buildPollingPrompt` recebe um parâmetro `hasWork: boolean` (resultado de `peekStep` chamado pelo scheduler, não pelo agente).
- **Aceite:** Quando `hasWork === false`, o prompt instrui o agente a emitir `HEARTBEAT_OK` imediatamente — **sem rodar nenhum comando CLI**.
- **Aceite:** Quando `hasWork === true`, o scheduler já claimou o step (ou instrui o claim) e injeta o `stepId` + `input` no prompt. O agente executa o trabalho e reporta via `step complete`/`step fail`.
- **Aceite:** O agente nunca precisa executar `step peek`. O comando `step peek` permanece no CLI para uso humano/diagnóstico, mas é removido dos prompts de polling.

### RF-3 — Re-claim de steps `running` órfãos (P0)
Um step em `running` cujo processo dono morreu deve ser detectado e revertido para `pending` automaticamente.

- **Aceite:** Existe um check (novo, no `medic` ou `reconciler`) que, para steps em `running`, valida se `claim_pid` corresponde a um processo vivo (`process.kill(pid, 0)` ou equivalente cross-platform).
- **Aceite:** Se o processo estiver morto, o step é revertido para `pending` e `claim_pid` limpo, permitindo re-claim. O `retry_count` é incrementado.
- **Aceite:** Esse check roda no ticker do reconciler (a cada 30s), não apenas no medic pesado (a cada 5 min).
- **Aceite:** Janela de detecção configurável via `FORMIGA_ORPHAN_RUNNING_THRESHOLD_S` (default 90s — bem menor que os 30 min atuais do stuck-step).

### RF-4 — Circuito de heartbeat → falha (P1)
Heartbeats consecutivos sem progresso devem convergir para uma falha explícita, não para um loop infinito.

- **Aceite:** Após `N` heartbeats consecutivos para o mesmo `(jobId)` sem nenhum `work_done` entre eles, o step é falido via `step fail` com reason `heartbeat_loop_exhausted`.
- **Aceite:** `N` é configurável via `FORMIGA_HEARTBEAT_FAILURE_THRESHOLD` (default 5).
- **Aceite:** Ao faltar, o fluxo de `on_fail`/`escalate_to` normal é acionado — ou seja, `escalate_to: human` finalmente fica alcançável.
- **Aceite:** Antes de falir, o último pi-output do agente é preservado (ver RF-6) como evidência.

### RF-5 — Backoff de heartbeat deve acumular corretamente (P1)
O contador de heartbeats consecutivos não deve ser resetado indevidamente.

- **Aceite:** Investigar e corrigir por que os spawns do `367d0f4e` permaneceram a ~2 min em vez de aplicar o backoff exponencial definido em `shared.ts:91`.
- **Aceite:** Existe um teste unitário que simula 6 heartbeats consecutivos e valida que os intervalos de skip seguem 1→2→4→8 (cap 8).

### RF-6 — Logs de agente persistentes e truncados (P2)
Os pi-outputs hoje são efêmeros (apagados ao final do agente) e desproporcionais (62MB para o data-analyst).

- **Aceite:** Ao final de cada polling round (ou ao encerrar o agente), um **resumo persistente** é salvo: texto do assistente (final, não streaming incremental), tools chamadas, outputs de tools, e o outcome.
- **Aceite:** O resumo é truncado (tamanho máximo configurável, default 64KB) e indexado por `(runId, stepId, agentId, round)`.
- **Aceite:** O log bruto completo pode ser descartado, mas o resumo permite auditoria pós-run.
- **Aceite:** Um DS pode recuperar "o que o modeler X pensou no round 3" sem precisar do log bruto.

### RF-7 — Observabilidade honesta por step (P1/P2)
O dashboard deve refletir o sofrimento do step em tempo real.

- **Aceite:** A cada polling round, `steps.updated_at` é renovado (mesmo em heartbeat).
- **Aceite:** A API expõe, por step: `consecutive_heartbeats`, `spawn_count`, `last_outcome`, `last_outcome_at`.
- **Aceite:** O dashboard distingue visualmente `running` saudável (progresso recente) de `running` em loop (heartbeats consecutivos > 0).
- **Aceite:** `tokens_spent` reflete tokens reais consumidos, mesmo em backoff (ou, se suprimido, há um campo `tokens_suppressed: true` explícito).

---

## 4. Requisitos Não-Funcionais

- **NFR-1 (Compatibilidade):** As mudanças não quebram workflows existentes (`ml-autoresearch`, `ml-pipeline`). Testes E2E atuais devem passar.
- **NFR-2 (Performance):** O check de processo vivo (RF-3) deve ser barato — `process.kill(pid, 0)` é O(1) syscall. Rodar para todos os steps `running` a cada 30s é aceitável.
- **NFR-3 (Cross-platform):** `process.kill(pid, 0)` funciona em macOS e Linux. Não usar `pgrep`/`ps` parsing (já há proposta antiga de orphan-daemon em `docs/refact.md` que usa `pgrep` — evitar para steps, preferir a syscall).
- **NFR-4 (Segurança):** RF-3 valida apenas que o PID está vivo; não mata processos arbitrários. A reversão é de estado de DB, não de processo.
- **NFR-5 (Observabilidade das mudanças):** Toda ação de remediação (reset de step órfão, falha por heartbeat loop) emite um evento no event log JSONL com reason claro.
- **NFR-6 (Migração):** RF-3/Rf de observabilidade podem precisar de colunas novas em `steps` (`claim_pid_at`, `consecutive_heartbeats`, `spawn_count`). Adicionar via migrations idempotentes (padrão `ALTER TABLE ... ADD COLUMN` com guarda de coluna existente, como já faz [migrations.ts:100](../../src/database/migrations.ts#L100)).

---

## 5. Design de Implementação

### 5.1. Inversão da descoberta de trabalho (RF-1 + RF-2) — núcleo da spec

**Hoje:**
```
scheduler → spawn pi → pi recebe prompt "rode node bin/formiga step peek"
                              → modelo decide rodar (ou não) o comando
                              → pi-output → parser classifica heartbeat/work_done
```

**Depois:**
```
scheduler → peekStep(agentId, runId)  [SQLite, no formiga]
          → if NO_WORK: spawn pi com prompt "emita HEARTBEAT_OK" (sem CLI)
          → if HAS_WORK: claimStep → injeta stepId+input no prompt → spawn pi
                         → pi executa trabalho → reporta via step complete/fail
```

**Mudanças de assinatura:**
- `buildPollingPrompt(workflowId, agentId, runId, persona)` → `buildPollingPrompt(workflowId, agentId, runId, persona, work: { hasWork: boolean; step?: { stepId; input } })`
- O caller em [polling-round.ts:746](../../src/installer/scheduler/polling-round.ts#L746) passa o resultado do peek/claim.

**Risco e mitigação:** isso muda o contrato do prompt. Modelos já treinados para o formato antigo podem confundir-se com a ausência da instrução de peek. Mitigação: o prompt novo é mais simples e direto ("Você já tem trabalho: ..."), o que tende a melhorar aderência. Validar com os 2 modelos em uso (kimi-k2.6 via ifood-genplat, e qualquer outro) antes de generalizar.

### 5.2. Reconciler de step órfão (RF-3)

Novo check em `src/medic/reconciler-checks.ts` (ou arquivo novo `orphan-running.ts`):

```typescript
// Pseudocódigo — não é código final
export async function findOrphanedRunningSteps(): Promise<OrphanedStep[]> {
  const steps = await prisma.step.findMany({
    where: { status: "running", claim_pid: { not: null }, run: { status: "running" } },
    select: { id, step_id, run_id, agent_id, claim_pid, updated_at },
  });
  const now = Date.now();
  const thresholdMs = (Number(process.env.FORMIGA_ORPHAN_RUNNING_THRESHOLD_S) || 90) * 1000;
  return steps
    .filter(s => s.claim_pid != null)
    .filter(s => now - s.updated_at.getTime() > thresholdMs)
    .filter(s => !isProcessAlive(s.claim_pid));  // process.kill(pid, 0)
}

export async function remediateOrphanedStep(s: OrphanedStep): Promise<void> {
  // revert to pending, clear claim_pid, increment retry_count, emit event
  await prisma.step.update({ where: { id: s.id }, data: {
    status: "pending", claim_pid: null, retry_count: { increment: 1 }, updated_at: new Date(),
  }});
  emitEvent({ event: "step.orphan_reclaimed", runId: s.run_id, stepId: s.step_id,
              detail: `claim_pid ${s.claim_pid} dead; reverted to pending` });
}
```

Integrar no tick do reconciler (30s), não só no medic (5 min). O `reset_step` existente do medic (30 min) permanece como rede de segurança mais lenta.

### 5.3. Circuito de heartbeat (RF-4)

Em `polling-round.ts`, onde `recordHeartbeat(job.id)` é chamado (linha ~798), adicionar verificação de limite:

```typescript
if (outputSummary.outcome === "heartbeat") {
  recordHeartbeat(job.id);
  const count = consecutiveHeartbeats.get(job.id) ?? 0;
  const threshold = Number(process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD) || 5;
  if (count >= threshold) {
    // preservar pi-output como evidência (RF-6) antes de falir
    await failStep({ stepId, reason: `heartbeat_loop_exhausted (${count} consecutive)` });
    resetHeartbeatBackoff(job.id);
    return; // sai do loop de polling para este job
  }
}
```

### 5.4. Observabilidade (RF-7)

- Migrations: adicionar `claim_pid_at`, `consecutive_heartbeats`, `spawn_count` à tabela `steps` (idempotente).
- Em `polling-round.ts`, a cada round: `steps.updated_at = now()` (mesmo em heartbeat) e incrementar `spawn_count` no spawn.
- API: estender `/api/pipeline/status` e `/api/pipeline/flow` com os novos campos.
- Dashboard: componente de health do nó do step (cor/ícone distinto para "em loop").

---

## 6. Plano de Entrega (incremental, P0 → P2)

### Fase 0 — Validação (P0, ~1 dia)
- [ ] Confirmar a anomalia do backoff (RF-5): reproduzir em teste unitário isolado o reset indevido do contador.
- [ ] Decidir: RF-2 (inversão do peek) é a mudança de maior impacto e risco. Validar o prompt novo manualmente com 1 run antes de generalizar.

### Fase 1 — Destravar (P0, ~2 dias)
- [ ] RF-1: corrigir `node "${cli}"` → `"${cli}"` em `prompts.ts` (linhas 79, 86, 96, 97, 124, 125, 177 e correlatas).
- [ ] RF-2: inverter peek (injetar `hasWork`/`stepId` no prompt; remover `step peek` do polling).
- [ ] RF-3: reconciler de step órfão + migration `claim_pid_at`.
- [ ] Testes: unitários para o novo prompt, E2E que reproduz o cenário do `367d0f4e` e valida recuperação.

### Fase 2 — Tornar visível (P1, ~2 dias)
- [ ] RF-4: circuito de heartbeat → `step fail`.
- [ ] RF-5: corrigir backoff + teste.
- [ ] RF-7 (parcial): `steps.updated_at` renovado + campos na API.
- [ ] Dashboard: health do nó em loop.

### Fase 3 — Auditoria (P2, ~2 dias)
- [ ] RF-6: persistência/truncamento de resumo de pi-output.
- [ ] RF-7 (restante): `spawn_count`, `consecutive_heartbeares`, `tokens_suppressed` na API/dashboard.

### Critério de aceite da Fase 1 (regressão do bug)
Um run `ml-autoresearch` idêntico ao `367d0f4e` deve, no pior caso (agente não consegue trabalhar), **falhar explicitamente em < 10 min** com reason `heartbeat_loop_exhausted` e escalar para humano — nunca ficar preso em `running` para sempre.

---

## 7. Direção Futura (P3, fora desta spec)

**Harness em-processo via SDK.** Hoje `pi` e `hermes` são ambos subprocessos externos ([pi-runner.ts](../../src/installer/scheduler/pi-runner.ts), [hermes-runner.ts](../../src/installer/scheduler/hermes-runner.ts)); o único SDK no `package.json` é `@modelcontextprotocol/sdk` (ferramentas, não orquestração). Um loop em-processo eliminaria: parsing de stdout, morte de processo com estado órfão (tornando RF-3 em grande parte desnecessário), e tornaria "claimou e morreu" impossível. É o caminho arquiteturalmente correto de longo prazo, mas é reescrita do runner e do modelo de polling — não incluída aqui.

**Modelo como cidadão de primeira classe.** Hoje o modelo (kimi-k2.6 via ifood-genplat) é opaco ao formiga. Tornar explícito qual modelo cada agente usa, e permitir fallback de modelo em falha, aumentaria resiliência a modelos instáveis.

---

## 8. Riscos e Trade-offs

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| RF-2 quebra aderência de modelos acostumados ao prompt antigo | Média | Alto | Validar manualmente com 1 run antes de generalizar; manter prompt claro e direto |
| RF-3 falso-positivo: mata step de agente lento mas vivo | Baixa | Médio | Threshold de 90s + validação `process.kill(pid,0)` (não mata, só checa) |
| RF-4 falha steps que legitimately estavam ociosos | Média | Médio | Threshold de 5 heartbeats + só conta consecutivos sem `work_done` entre eles |
| Migration quebra DBs existentes | Baixa | Alto | Padrão idempotente já usado no projeto (guarda de coluna) |
| Mudanças no prompt exigem re-testar 2 harnesses (pi+hermes) | Média | Médio | Ambos compartilham `buildPollingPrompt`; testar ambos |

---

## 9. Questões em Aberto — Resolvidas (validação de código)

Validadas em 2026-07-24 após inspeção do código. Achados abaixo atualizam os requisitos.

### Q1 — RF-2 / hermes: **RESOLVIDA — transparente**
`hermes-runner` e `pi` **compartilham o mesmo `pollingPrompt`** ([polling-round.ts:624](../../src/installer/scheduler/polling-round.ts#L624) → usado em :720 para hermes e :746 para pi). A inversão do peek (RF-2) é transparente para ambos — basta mudar `buildPollingPrompt`. **Sem adaptação extra no `hermes-runner`.**

### Q2 — RF-5 / backoff: **RESOLVIDA — bug confirmado e localizado**
Há **dois** `recordHeartbeat` e **dois** `resetHeartbeatBackoff`, e a lógica interage incorretamente:

- [polling-round.ts:494-518](../../src/installer/scheduler/polling-round.ts#L494-L518): um pré-check consulta o DB por steps `pending`/`waiting`. Se **não há work** → `recordHeartbeat` (linha 507) e `return` (não spawna o harness). Se há work → `resetHeartbeatBackoff` (linha 516).
- [polling-round.ts:798-801](../../src/installer/scheduler/polling-round.ts#L798-L801): **depois** de spawnar o harness, se o outcome for `heartbeat` → `recordHeartbeat` de novo; senão → `resetHeartbeatBackoff`.

**O bug do `367d0f4e`:** o step `features` estava em `running` (órfão), então o pré-check (:497) com `status: { in: ["pending","waiting"] }` **não o encontra** → cai no `recordHeartbeat`+`return` da linha 507-513 **a cada round**, **sem nunca spawnar o harness**. Mas os eventos mostraram spawns reais a cada ~2 min — então há um caminho que spawna mesmo assim (provável: o `direct-spawn` pós-advance ou o reconciler nudge). O contador `consecutiveHeartbeats` cresce no pré-check, mas é **resetado** sempre que o harness efetivamente spawna e o outcome não é `heartbeat` puro (ou por outro fluxo). Resultado: o backoff exponencial nunca estabiliza porque o contador oscila entre os dois pontos de record/reset.

**Correção:** unificar em um único ponto de record/reset; garantir que o pré-check (:497) **também considere steps `running` órfãos como trabalho** (ou que o reconciler de RF-3 os reverta para `pending` antes do pré-check, tornando-os visíveis). Isso liga RF-3 ↔ RF-5: com RF-3 revertendo o órfão para `pending`, o pré-check o encontrará e o fluxo volta ao caminho saudável.

### Q3 — RF-6 / privacidade: **RESOLVIDA — concern real, confirmado por evidência**
O pi-output **contém dados do dataset**. Verificado no log de 62MB do data-analyst: nomes de colunas (`sepal_length`, etc.), classes (`setosa`/`versicolor`/`virginica`), ~3779 valores float tipo Iris, e referências a `read_csv`/`df.head`/`shape`. Para Iris é inócuo; **para datasets sensíveis (PII, financeiro, médico) o resumo persistido vaza dados**.

**Decisão:** RF-6 deve (a) ter retenção configurável (`FORMIGA_AGENT_LOG_RETENTION_DAYS`, default 7), (b) opção de redigir valores de dados no resumo (configurável por run via flag `redact_dataset_values`), (c) o resumo persiste **raciocínio e decisões**, não dumps de dados. Para o feature-engineer (que falhou em peek, não leu dados), o risco é baixo; para data-analyst/modelers é alto.

### Q4 — Decisão de produto / falhar cedo: **RESOLVIDA — recomendação mantida**
Para um time de DS competindo em tempo real, **falhar cedo e escalar > rodar em silêncio**. Justificativa: o custo de um run preso (tokens, ciclos, falsa expectativa de progresso) supera o custo de re-tentar após intervenção humana. O threshold (RF-4) fica **configurável por workflow** (`heartbeat_failure_threshold` no `loop_config` ou variável de ambiente), default 5, para acomodar workflows de rounds longos.

---

*Esta spec é derivada de evidências de monitoramento real, não de hipótese. Implementações devem validar cada RF com teste que reproduz o cenário do run `367d0f4e`.*
