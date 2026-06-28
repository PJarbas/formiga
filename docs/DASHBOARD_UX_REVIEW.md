# Revisão Crítica: UX/UI do Dashboard Formiga ML

**Data:** 28 de Junho de 2026  
**Especialista:** Design UI/UX  
**Escopo:** Análise completa das 4 telas e componentes do dashboard com recomendações de melhoria

---

## 📋 Sumário Executivo

O dashboard atual apresenta estrutura sólida mas sofre com **falta de hierarquia visual**, **informação dispersa**, **fluxos incompletos de navegação** e **empty states que não informam**. Usuários ficam perdidos durante execução de workflows porque:

1. **Command Center** mistura muita informação sem destacar o que importa agora
2. **Experiment Board** não diferencia visualmente qual etapa está rodando
3. **Navegação entre telas** não funciona (clique no Run ID não navega, Agent Detail hardcoded)
4. **Status visual** é genérico e não comunica urgência/importância
5. **Estados contraditórios** ("Running" + "Phase idle") confundem em vez de informar
6. **Empty states** no início do pipeline não dão qualquer indicação de progresso

### Heurísticas de Usabilidade Violadas (Nielsen)

| Heurística | Violação | Problema(s) |
|-----------|----------|-------------|
| **#1 Visibilidade do status** | Não fica claro o que está acontecendo agora | §1, §9, §11, §12 |
| **#2 Compatibilidade sistema-mundo real** | Status usa jargão técnico ("idle", "phase") em vez de linguagem do usuário | §9 |
| **#3 Controle e liberdade** | Não há como navegar de um card/run para detalhe e voltar | §3, §5, §10 |
| **#5 Prevenção de erros** | Lanes com "No cards" poluem a tela, overload cognitivo | §4 |
| **#6 Reconhecimento > memorização** | Status dots requerem aprendizado de código de cor | §6 |
| **#8 Design minimalista** | Command Center mostra tudo ao mesmo tempo | §1, §7 |

### Métricas de Sucesso
- **Time to Insight**: Tempo para o usuário entender "em qual passo estamos" → meta: < 2s
- **Time to Action**: Tempo para tomar uma ação pendente (approve/reject) → meta: < 3 clicks
- **Cognitive Load Score**: Número de seções visíveis simultaneamente → meta: ≤ 4 acima da dobra

---

## 🎯 Problema 1: Command Center Sobrecarregado

### Issue Identificado
A tela principal (Command Center) tenta ser um hub para tudo, resultando em:
- Run ID em destaque, mas sem contexto do que significa
- PipelineStepper mostra fases mas **não diferencia qual está rodando ativamente**
- Decisions Pending compete por atenção com Quick Stats
- Agent Strip em 5 colunas é difícil de escanear rapidamente
- Usuário não sabe em qual fase/etapa está o workflow

### Raiz do Problema
**Falta de hierarquia de importância.** Tudo tem o mesmo visual weight.

### Cenário de Dor
> "Rodei o workflow de ML. Qual é a próxima etapa? Está errando? Preciso fazer algo agora?"

Resposta atual: Usuário precisa:
1. Ler o Run ID para contexto
2. Olhar o PipelineStepper para saber qual fase está correndo
3. Verificar Decisions Pending para ver se precisa agir
4. Escanear Agent Strip para saber qual agente está trabalhando

### Recomendação: Reorganizar para Status-Driven

**Nova hierarquia:**

```
┌─────────────────────────────────────────────────────────────┐
│ TOPO: STATUS CARD DESTACADO                                 │
│ ┌──────────────────────────────────────────────────────┐   │
│ │ 🔵 RUNNING: Feature Engineering (Round 3/5)           │   │
│ │                                                        │   │
│ │ Current Agent: Feature Engineer                        │   │
│ │ Elapsed: 2min 45sec  │  Est. Remaining: 5min         │   │
│ └──────────────────────────────────────────────────────┘   │
│                                                              │
│ SEÇÃO 2: PIPELINE PROGRESS (Visual + Numeric)              │
│ [●--- ] EDA (done)  [●--- ] Feat Eng (RUNNING) ...         │
│                                                              │
│ SEÇÃO 3: AÇÕES IMEDIATAS (Se houver decisions pending)     │
│ ⚠️  SPEC APPROVAL NEEDED: Feature Set 3                     │
│    [APPROVE] [REJECT] [EDIT]                               │
│                                                              │
│ SEÇÃO 4: KPIs SECUNDÁRIOS (Quick Stats)                    │
│ Experiments: 12  |  Best: 0.8432  |  Tokens: 2,450        │
│                                                              │
│ SEÇÃO 5: AGENTE QUE ESTÁ RODANDO (destaque)               │
│ ┌─────────────────────────────────────┐                   │
│ │ Feature Engineer (RUNNING)           │                   │
│ │ 8 trials completed, 2 in progress   │                   │
│ │ Best CV: 0.8234                      │                   │
│ └─────────────────────────────────────┘                   │
│                                                              │
│ SEÇÃO 6: OUTROS AGENTES (muted, apenas reference)         │
│ [Data Analyst: idle] [Modeler: idle] [ML Critic: idle]   │
└─────────────────────────────────────────────────────────────┘
```

### Mudanças Concretas

#### 1. **Status Card Dominante no Topo**
- Tamanho maior, cores vibrantes para cada status
- Status atual em **CAPS + EMOJI**
- Mostrar: `🔵 RUNNING: [Fase Atual] (Round X/Y)`
- Mostrar agente que está trabalhando
- Mostrar tempo decorrido e estimativa restante

```tsx
// Novo StatusCard component
<div className="bg-[var(--accent-blue)]/10 border-2 border-[var(--accent-blue)] rounded-lg p-6">
  <div className="flex items-center gap-3">
    <span className="text-3xl">🔵</span>
    <div>
      <h2 className="text-2xl font-bold text-[var(--accent-blue)]">
        RUNNING: Feature Engineering
      </h2>
      <p className="text-sm text-[var(--text-secondary)]">
        Round 3/5 · Agent: Feature Engineer
      </p>
    </div>
    <div className="ml-auto text-right">
      <p className="text-sm text-[var(--text-muted)]">Elapsed</p>
      <p className="text-2xl font-mono text-[var(--text-primary)]">02:45</p>
    </div>
  </div>
</div>
```

#### 2. **PipelineStepper Melhorado**
- Mostrar tempo decorrido POR FASE
- Fase em execução com pulso/animação
- Cores: ✅ green (done), 🔵 blue (running), ⚪ gray (pending), ❌ red (failed)

```
[✅ EDA (3:42)] → [🔵 FEAT ENG (2:45) ⏱️] → [⚪ MODEL (—)] → [⚪ AUDIT (—)] → [⚪ DONE (—)]
```

#### 3. **Decisions Pending como ALERT Box**
- Se há decisions pending, mostrar como um card destacado com fundo colorido
- Exemplo: fundo laranja/vermelho se há algo urgente
- Botões claros de ação (CTA - Call to Action)

#### 4. **Agent Strip Horizontal Colapsável**
- Ao invés de grid 5 colunas, usar scroll horizontal
- Destacar o agente que está RUNNING com cor e border
- Outros agentes em estado muted

#### 5. **Quick Stats Reduzido**
- Mover para rodapé ou colapsar
- Apenas 2-3 KPIs principais visíveis

---

## 🎯 Problema 2: Experiment Board Status View Não é Default

### Issue Identificado
Na tela Experiment Board, há 3 abas: **Phase | Agent | Status**

Seu feedback é excelente: **Status deveria ser o DEFAULT**, mostrando:
- Pending (etapas não iniciadas, desabilitadas)
- Running (etapas em execução, destaque visual)
- Done (etapas completadas)
- Failed (etapas com erro)

Atualmente está em "Phase" por padrão, o que é confuso porque:
- Usuário vê fase "Feature Eng" com múltiplos cards
- Não fica claro qual está rodando, qual falhou, qual está pendente

### Recomendação: Status como Default + Visual Hierarchy

```tsx
// ExperimentBoard.tsx
const [view, setView] = useState<ViewMode>("status");  // ← Mude de "phase" para "status"
```

#### Status View Design

```
Round — Experiment Board
Snapshot at 9:31:56 AM

[Phase] [Agent] [Status]  ← Status deve estar selecionado

┌──────────────────────────────────────────────────────────────┐
│ ⚪ PENDING (2/5)                                             │
│ ┌─────────────────────────────┐ ┌────────────────────────┐  │
│ │ Data analyst step           │ │ Feature engineer step  │  │
│ │ updated 2026-06-28T...      │ │ updated 2026-06-28T... │  │
│ │ [DETAILS]                   │ │ [DETAILS]              │  │
│ └─────────────────────────────┘ └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ 🔵 RUNNING (1/5)                                             │
│ ┌─────────────────────────────────────────────────────────┐  │
│ │ ⚡ Modeler classic step                                 │  │
│ │ updated 2026-06-28T12:10:51.313+00:00                   │  │
│ │ [APPROVE] [EDIT] [REJECT] [DETAILS]                     │  │
│ └─────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ ✅ DONE (2/5)                                                │
│ ┌─────────────────────────┐ ┌────────────────────────────┐  │
│ │ Data analyst step       │ │ Feature engineer step      │  │
│ │ ✓ completed             │ │ ✓ completed                │  │
│ │ [DETAILS]               │ │ [DETAILS]                  │  │
│ └─────────────────────────┘ └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│ ❌ FAILED (0/5)                                              │
│ No cards                                                      │
└──────────────────────────────────────────────────────────────┘
```

#### Visual Differentiation

| Status | Background | Border | Icon | Opacity |
|--------|------------|--------|------|---------|
| **PENDING** | Gray | Gray | ⚪ | 60% (disabled look) |
| **RUNNING** | Blue/bright | Blue | 🔵 + pulse | 100% |
| **DONE** | Green | Green | ✅ | 80% (completed) |
| **FAILED** | Red | Red | ❌ | 100% (error) |

---

## 🎯 Problema 3: Navegação Incompleta (Run ID Não Clica)

### Issue Identificado
User clica no Run ID esperando navegar para detalhes, mas não acontece nada.

Impacto: Usuário quer context switching rápido mas fica preso na tela atual.

### Recomendação: Implementar Navegação Funcional

#### 1. **Run ID como Link Clicável**
```tsx
// App.tsx - breadcrumb no header
{status?.runId && (
  <div className="flex items-center gap-2 cursor-pointer hover:opacity-80">
    <span className="text-[var(--text-secondary)]">Run</span>
    <Link 
      to={`/runs/${status.runId}`}
      className="text-[var(--text-primary)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded text-xs font-mono hover:bg-[var(--accent-blue)] hover:text-white transition"
    >
      {status.runId.slice(0, 8)}
    </Link>
  </div>
)}
```

#### 2. **Nova Tela: Run Details**
Criar página `/runs/:runId` que mostra:
- Informações completas do run (start time, duration, status, etc)
- Quick links para as 4 telas principais
- Timeline visual de eventos

#### 3. **Breadcrumb Navigation**
```
Formiga ML > Run 9ea789aa > Command Center
Formiga ML > Run 9ea789aa > Experiment Board
Formiga ML > Run 9ea789aa > Model Arena
Formiga ML > Run 9ea789aa > Agent Detail > data-analyst
```

---

## 🎯 Problema 4: Kanban Mostra Todas as Etapas — Confuso

### Issue Identificado
Você mencionou: "a tela de kanban mostra todas as etapas, mas qual realmente está funcionando?"

Problema visual:
- 5 lanes (EDA, Feat Eng, Modeling, Audit, Done) sempre visíveis
- Usuário precisa varrer olhos em cada uma para entender o que está acontecendo
- Lanes vazias ("No cards") poluem a tela

### Recomendação: Progressive Disclosure + Focus Mode

#### Opção A: Focus Mode (Recomendado para quando está rodando)
```
┌─────────────────────────────────────────────────────┐
│ Round — Experiment Board                            │
│                                                      │
│ View: [Phase] [Agent] [Status]                      │
│ ⚙️ Focus Mode: [OFF] → [ON]  ← nova toggle         │
└─────────────────────────────────────────────────────┘

Quando FOCUS MODE = ON:
- Mostrar APENAS a lane que está RUNNING + PENDING + DONE recent
- Esconder lanes vazias ou completadas
- Adicionar "swipe" ou botões [Previous Phase] [Next Phase]
```

#### Opção B: Collapse Completed Phases
```
[✅ EDA (completed) — click to expand]
  └─ 3 cards completed

[🔵 FEATURE ENG (running) — expanded]
  ├─ Feature engineer step (RUNNING)
  ├─ Card 2 (pending)
  └─ Card 3 (done)

[⚪ MODELING (pending)]
  └─ 2 cards pending

[⚪ AUDIT (pending)]
  └─ 1 card pending
```

#### Opção C: Horizontal Scroll com Indicador
```
Mostrar apenas 2-3 lanes por vez
← [PENDING] [RUNNING] [DONE] [FAILED] →
  Scroll horizontal para ver outras lanes
```

---

## 🎯 Problema 5: Card Click Não Navega para Segunda Página

### Issue Identificado
Na Experiment Board, clicar em um card abre um detail panel inline, mas não há navegação para uma página dedicated.

Isso é **partially correct** porque:
- ✅ Detail panel inline é bom para escanear rápido
- ❌ Mas não há saída para full-screen view se usuário quer detalhe completo

### Recomendação: Expandable Detail + Full-Screen Option

#### Opção A: Detail Panel com "Expand to Full Screen" Button
```tsx
<div className="detail-panel">
  <div className="flex justify-between">
    <h3>Feature engineer step</h3>
    <button onClick={() => navigate(`/runs/${runId}/card/${cardId}`)} className="hover:text-blue">
      🔗 Abrir em tela cheia
    </button>
  </div>
  {/* detail content */}
</div>
```

#### Opção B: Modal/Drawer para Detail
```tsx
// Ao clicar no card, abrir um modal/drawer ao invés de panel
<Modal isOpen={selectedCardId} onClose={() => setSelectedCardId(null)}>
  <CardDetailFull cardId={selectedCardId} />
</Modal>
```

---

## 🎯 Problema 6: Status Badge Genérico

### Issue Identificado
Status indicators (running, pending, completed, etc) usam cores mas sem affordance clara.

Usuário precisa aprender a code: 🔵 = running, ⚪ = pending, ✅ = done, ❌ = failed

### Recomendação: Status com Icon + Label + Color

```tsx
// Antes
<span className={`status-dot ${card.status}`} />

// Depois
<div className="flex items-center gap-2">
  <span className={`text-lg ${getStatusEmoji(card.status)}`} />
  <span className="text-xs font-medium">{card.status.toUpperCase()}</span>
</div>

// Ou usar component melhorado
<StatusBadge status={card.status} size="md" showLabel />
```

| Status | Emoji | Color | Label |
|--------|-------|-------|-------|
| idle/pending | ⚪ | Gray | PENDING |
| running | 🔵 | Blue | RUNNING |
| completed | ✅ | Green | DONE |
| failed | ❌ | Red | FAILED |

---

## 🎯 Problema 7: Agent Strip Difícil de Escanear

### Issue Identificado
Agent Strip com 5 agentes em grid 2/5 colunas é ruim para escanear status de todos.

Quando há 5 agentes em execução simultânea, usuário quer saber status de cada um num golpe de vista.

### Recomendação: Agent Status List Horizontal

```tsx
// Antes: grid 2x3 ou 1x5
<div className="grid grid-cols-2 md:grid-cols-5 gap-3">

// Depois: flex row com scroll horizontal ou flex wrap
<div className="flex flex-wrap gap-3">
  {agentStrip.map(a => (
    <div key={a.name} className="flex-shrink-0 min-w-[200px] border rounded p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`status-dot ${a.status}`} />
          <div>
            <h4 className="text-sm font-medium">{a.label}</h4>
            <p className="text-xs text-muted">{a.trials} trial(s)</p>
          </div>
        </div>
        {a.bestCvMean && (
          <p className="text-xs font-mono text-blue">{a.bestCvMean.toFixed(4)}</p>
        )}
      </div>
    </div>
  ))}
</div>
```

Ou usar tooltip/popover para não sobrecarregar espaço.

---

## 🎯 Problema 8: Leaderboard Sem Contexto

### Issue Identificado
Model Arena (Leaderboard) mostra scatter plot + table, mas não comunica:
- Qual modelo foi escolhido e por quê
- Qual é o estado do modelo atual (está em produção? Abandonado?)
- Como comparar com o baseline

### Recomendação: Adicionar Context

```tsx
// Topo do Leaderboard
<div className="bg-green/10 border border-green rounded p-4 mb-6">
  <h3 className="font-semibold text-green">🏆 Best Model Selected</h3>
  <p>
    <strong>xgboost_v3</strong> with CV Mean <code>0.8534</code>
    <br/>
    <span className="text-sm text-muted">
      Round 3 · Agent: modeler-classic · 
      <a href="#" className="text-blue">View Details</a>
    </span>
  </p>
</div>
```

---

## 🎯 Problema 9: Inconsistência de Status (Running + Phase Idle + Round 0/5)

### Issue Identificado
No screenshot real, o header mostra simultaneamente:
- Status: **Running** (dot azul)
- Phase: **Idle**
- Round: **0/5**
- Elapsed: **179:59**

Isso é uma contradição grave. Se está "Running", por que a phase é "idle"? Se está no round 0, o que está rodando há quase 3 horas?

O usuário olha isso e pensa: **"Está rodando ou não? Travou? Preciso reiniciar?"**

### Raiz do Problema
O backend provavelmente tem estados intermediários (pipeline "running" mas esperando input, ou round 0 = setup/initialization). Mas a UI não traduz isso para linguagem humana.

### Recomendação: Mapear estados compostos para mensagens claras

```tsx
// Em vez de mostrar status + phase + round separados:
function getHumanReadableStatus(status: string, phase: string, round: number, maxRounds: number) {
  if (status === "running" && phase === "idle" && round === 0) {
    return { label: "Initializing...", icon: "⏳", description: "Pipeline is setting up" };
  }
  if (status === "running" && phase === "idle") {
    return { label: "Waiting for input", icon: "⏸️", description: "Pipeline paused — awaiting decision" };
  }
  if (status === "running" && round > 0) {
    return { label: `Running: ${phase}`, icon: "🔵", description: `Round ${round}/${maxRounds}` };
  }
  if (status === "completed") {
    return { label: "Completed", icon: "✅", description: `${round} rounds finished` };
  }
  if (status === "failed") {
    return { label: "Failed", icon: "❌", description: `Failed at ${phase}, round ${round}` };
  }
  return { label: status, icon: "⚪", description: "" };
}
```

Princípio: **Nunca mostrar dados brutos do backend quando a combinação pode confundir.** Traduzir para linguagem situacional.

---

## 🎯 Problema 10: Agent Detail com Link Hardcoded na Navegação

### Issue Identificado
No `App.tsx`, o link para Agent Detail está fixo:
```tsx
{ to: "/agents/data-analyst", label: "Agent Detail" }
```

Impacto:
- Usuário só pode ver detalhe do "data-analyst" via nav
- Não existe dropdown ou lista de agentes
- Se o modeler está falhando, não há caminho rápido para chegar nele

### Recomendação: Dropdown de Agentes ou Página Índice

#### Opção A: Dropdown na navegação
```tsx
// App.tsx
<div className="relative group">
  <button className="nav-link">Agent Detail ▾</button>
  <div className="absolute hidden group-hover:block bg-[var(--bg-secondary)] border rounded shadow-lg">
    {agents.map(a => (
      <NavLink key={a.name} to={`/agents/${a.name}`} className="block px-4 py-2 text-sm hover:bg-tertiary">
        <span className={`status-dot ${a.status}`} /> {a.label}
      </NavLink>
    ))}
  </div>
</div>
```

#### Opção B: Página /agents como índice
Rota `/agents` mostra lista de todos agentes com status e clica para detalhe.

#### Opção C: Agent strip no Command Center como links
Cada card do Agent Strip vira clickable → navega para `/agents/{name}`.

---

## 🎯 Problema 11: Empty States Dominam no Início de Pipeline

### Issue Identificado
Olhando os screenshots, quase todas as seções mostram estado vazio:
- "0 experiments", "No experiments yet"
- "No prior round available to diff against yet"
- "No trace events recorded yet"
- "No rounds completed yet"
- "No log entries"
- "0 trial(s)" em todos os agents

Esse é **exatamente** o momento em que o usuário está ansioso para saber o que está acontecendo. E o dashboard mostra... nada.

### Recomendação: Empty States Informacionais

Em vez de "No X yet", mostrar **o que está acontecendo e o que esperar**:

```tsx
// Antes
<p className="text-xs text-muted italic">No experiments yet.</p>

// Depois
<div className="text-center py-6 space-y-2">
  <span className="text-2xl">⏳</span>
  <p className="text-sm text-[var(--text-secondary)]">
    Pipeline is initializing — first experiment expected in ~2 minutes
  </p>
  <p className="text-xs text-[var(--text-muted)]">
    Current step: Setting up agents and loading data
  </p>
  <div className="w-48 mx-auto h-1 bg-[var(--bg-tertiary)] rounded overflow-hidden">
    <div className="h-full bg-[var(--accent-blue)] rounded animate-pulse w-1/3" />
  </div>
</div>
```

Cada seção vazia deve comunicar:
1. **O que está acontecendo** (por que está vazio)
2. **O que esperar** (quando vai popular)
3. **Indicador visual de progresso** (barra, pulso, spinner)

---

## 🎯 Problema 12: Sem Feedback em Tempo Real (Live Activity)

### Issue Identificado
O polling de 3 segundos atualiza os dados, mas o usuário não tem sensação de "algo está acontecendo agora". A tela parece estática entre os polls.

Quando um workflow ML leva vários minutos por fase, o usuário precisa de reassurance contínuo.

### Recomendação: Activity Feed / Live Log Mini

Adicionar um **Activity Feed** compacto no Command Center:

```
┌─────────────────────────────────────────────┐
│ ⚡ Recent Activity                          │
│                                              │
│ 12:10:53  data-analyst → initialized        │
│ 12:10:54  feature-engineer → initialized    │
│ 12:10:55  modeler-classic → waiting         │
│ 12:10:55  Pipeline entered phase: setup     │
│ 12:11:02  data-analyst → running EDA...     │
│           ↓ auto-scroll                     │
└─────────────────────────────────────────────┘
```

Implementação:
```tsx
// Mini activity feed — últimos 10 eventos do pipeline
function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="rounded-lg border bg-secondary p-4 max-h-[200px] overflow-y-auto">
      <h3 className="text-sm font-semibold mb-2">⚡ Recent Activity</h3>
      {events.map((e, i) => (
        <div key={i} className="flex gap-2 text-xs py-1 border-b border-border last:border-0">
          <span className="text-muted font-mono shrink-0">{e.time}</span>
          <span className="text-secondary">{e.message}</span>
        </div>
      ))}
    </div>
  );
}
```

---

## 🎯 Problema 13: Sistema de Notificações/Toast Insuficiente

### Issue Identificado
O toast atual é um `<div>` com texto pequeno, sem animação, fácil de perder:
```tsx
<div className="text-xs text-[var(--text-secondary)] bg-[var(--bg-tertiary)] border ...">
  {toast}
</div>
```

Quando o usuário faz uma ação (approve/reject), o feedback visual é quase imperceptível.

### Recomendação: Toast System Robusto

```tsx
// Toast positions: top-right, com auto-dismiss e ícones de status
<Toast 
  type="success"  // success | error | warning | info
  message="Spec approved successfully"
  duration={4000}
  position="top-right"
/>
```

Usar uma biblioteca leve (react-hot-toast, sonner) ou implementar com animação CSS:
- Sucesso: ✅ fundo verde, desaparece em 4s
- Erro: ❌ fundo vermelho, fica até dismiss
- Warning: ⚠️ fundo laranja, desaparece em 6s

---

## 📊 Mapa Priorizado de Melhorias

### P0 (Crítico) — Implementar ASAP
| # | Item | Problema Ref | Esforço |
|---|------|-------------|---------|
| 1 | Status como default view no Experiment Board | §2 | Baixo (1 linha) |
| 2 | Command Center: Status Card dominante no topo | §1 | Médio |
| 3 | Mapear status compostos para linguagem humana | §9 | Médio |
| 4 | Run ID clickable + navegação funcional | §3 | Médio |
| 5 | Empty states informativos (progress indicators) | §11 | Médio |

### P1 (Alta) — Próxima sprint
| # | Item | Problema Ref | Esforço |
|---|------|-------------|---------|
| 6 | Agent Detail: dropdown/lista de agentes na nav | §10 | Médio |
| 7 | Status badges com label textual visível | §6 | Baixo |
| 8 | Activity Feed (mini log tempo real) | §12 | Médio |
| 9 | Toast system robusto (posicionado, com icons) | §13 | Médio |
| 10 | Detail panel com "expand to full screen" | §5 | Médio |

### P2 (Média) — Roadmap
| # | Item | Problema Ref | Esforço |
|---|------|-------------|---------|
| 11 | Leaderboard: banner "Best Model Selected" | §8 | Baixo |
| 12 | Agent Strip redesign (clickable → agent detail) | §7 | Médio |
| 13 | PipelineStepper: tempo por fase | §1 | Médio |
| 14 | Focus Mode no Experiment Board | §4 | Alto |
| 15 | Collapse completed phases | §4 | Médio |
| 16 | Run Details page (dedicated URL) | §3 | Alto |

---

## 🎨 Design System Updates Necessários

### 1. Status Badge Component — Melhoria
```tsx
interface StatusBadgeProps {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'pending';
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  showEmoji?: boolean;
}

const statusConfig = {
  idle: { emoji: '⚪', color: 'gray', label: 'PENDING' },
  running: { emoji: '🔵', color: 'blue', label: 'RUNNING' },
  completed: { emoji: '✅', color: 'green', label: 'DONE' },
  failed: { emoji: '❌', color: 'red', label: 'FAILED' },
  pending: { emoji: '⚪', color: 'gray', label: 'PENDING' },
};
```

### 2. Novo Component: StatusCard (Dominante)
```tsx
interface StatusCardProps {
  status: string;
  currentPhase: string;
  round: number;
  maxRounds: number;
  currentAgent: string;
  elapsedTime: string;
  estimatedRemaining?: string;
}

export function StatusCard(props: StatusCardProps) {
  const { emoji, color } = getStatusConfig(props.status);
  return (
    <div className={`bg-${color}/10 border-2 border-${color} rounded-lg p-6`}>
      {/* large, visible status info */}
    </div>
  );
}
```

### 3. Color System Update
```css
/* Adicionar cores mais vibrantes */
--status-idle: #6e7681;      /* gray */
--status-pending: #6e7681;   /* gray */
--status-running: #0969da;   /* bright blue */
--status-completed: #1a7f37; /* bright green */
--status-failed: #da3633;    /* bright red */
--status-warning: #9e6a03;   /* orange */
```

---

## 🔄 Fluxo de Implementação Recomendado

### Sprint 1: Clareza Imediata (P0)
- [ ] `ExperimentBoard.tsx` linha 137: mudar default de `"phase"` para `"status"`
- [ ] Criar `StatusCard.tsx` component — status dominante no topo do CommandCenter
- [ ] Implementar `getHumanReadableStatus()` — traduzir running+idle+round0 para mensagem clara
- [ ] Tornar Run ID clicável no header (App.tsx) — navegar para Command Center ou futuro `/runs/:id`
- [ ] Substituir empty states genéricos por mensagens contextuais com progress indicator

### Sprint 2: Navegação e Feedback (P1)
- [ ] Agent Detail nav: dropdown com lista de agentes OU página-índice `/agents`
- [ ] `StatusBadge.tsx` — adicionar prop `showLabel` e sempre mostrar texto do status
- [ ] Criar `ActivityFeed.tsx` — mini log de eventos recentes no CommandCenter
- [ ] Substituir toast DIV por sistema posicionado com ícones e auto-dismiss
- [ ] Detail panel no ExperimentBoard: adicionar botão "Open Full View" → drawer ou rota dedicada
- [ ] Tornar Agent Strip cards clicáveis → navegar para `/agents/{name}`

### Sprint 3: Contexto e Polish (P2)
- [ ] Leaderboard: banner "Best Model Selected" no topo com link para detalhes
- [ ] PipelineStepper: mostrar elapsed time por fase + animação pulse na fase ativa
- [ ] Focus Mode toggle no Experiment Board (mostrar só lanes relevantes)
- [ ] Collapse automático de lanes completadas com indicador
- [ ] Página dedicada `/runs/:runId` com timeline completa

---

## 📝 Casos de Uso Validados

### Caso 1: "Iniciar workflow e monitorar"
**ANTES:** Usuário abre Command Center, vê tudo, fica confuso sobre o que importa
**DEPOIS:** Abre Command Center, vê imediatamente "🔵 RUNNING: Feature Engineering (Round 2/5)"

### Caso 2: "Verificar em qual etapa estamos"
**ANTES:** Precisa olhar PipelineStepper e depois Experiment Board
**DEPOIS:** CommandCenter já mostra fase atual + agente rodando

### Caso 3: "Ver quais steps estão atrasados/falhados"
**ANTES:** Abre Experiment Board em "Phase" view, precisa varrer 5 lanes
**DEPOIS:** Abre Experiment Board em "Status" view (default), vê imediatamente RUNNING + FAILED

### Caso 4: "Tomar ação rápida (approve/reject spec)"
**ANTES:** Decisions Pending misturado com outras informações
**DEPOIS:** Status Card no topo identifica ações pendentes em destaque

---

## 📱 Responsive Considerations

- [ ] Command Center em mobile: Stack status card + decisions + quick stats verticalmente
- [ ] Experiment Board: Considerar horizontal scroll para lanes em mobile
- [ ] Agent Strip: Sempre horizontal scroll em mobile
- [ ] Leaderboard: Table scrollável horizontalmente

---

## ✅ Checklist de Validação Pós-Implementação

- [ ] Usuário consegue identificar status atual em < 2 segundos
- [ ] Usuário consegue tomar ação (approve/reject) em < 3 cliques
- [ ] Status visual diferencia claramente running vs pending vs done vs failed
- [ ] Navegação entre telas funciona (breadcrumb + links)
- [ ] Detail panels oferecem opção de full-screen
- [ ] Leaderboard comunica qual modelo foi selecionado e por quê
- [ ] Agent Strip mostra status de todos os agentes num golpe de vista

---

## 📞 Próximos Passos

1. **Validar com usuários:** Mostre mockups das telas redesenhadas antes de implementar
2. **Priorizar P0:** Implemente status default + StatusCard + badges melhorados primeiro
3. **Iteração rápida:** Teste em um sprint e recolha feedback
4. **Documentar padrões:** Atualize design system com novos componentes

