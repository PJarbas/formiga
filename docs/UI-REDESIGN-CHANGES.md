# Dashboard UI Redesign - Documento de Mudanças

## Objetivo

Elevar o design do dashboard (Dark Mode) para padrão Enterprise, melhorando observabilidade, clareza na tomada de decisão dos agentes e facilidade de reprodução de experimentos.

## Sumário de Mudanças

| Módulo | Arquivo(s) | Ação Principal |
|--------|------------|----------------|
| Pipeline Flow | `AgentNode.tsx`, `ArtifactEdge.tsx`, `AgentSidePanel.tsx` | Remover aba Activity, melhorar contraste |
| Leaderboard | `Leaderboard.tsx`, `AucBarChart.tsx` | Refatorar lógica de barras, alinhamento numérico |
| Model Detail Panel | `ModelDetailPanel.tsx` | Remover bordas de métricas, abas com opacidade |
| Report Tab | `report/StructuredReportTab.tsx` | Estrutura semântica em 3 blocos |
| Script Tab | `ModelDetailPanel.tsx` | Syntax highlighting + botão copiar |
| StatTiles | `StatTiles.tsx` | Remover bordas, tipografia monospace |

---

## 1. Módulo: Pipeline Flow (Visualização do Grafo)

### Problema Atual
- Baixo contraste nos nós
- Arestas difíceis de ler
- Painel lateral com aba Activity vazia/confusa

### Mudanças

#### 1.1 AgentNode.tsx
**REMOVER:**
- Nada estrutural

**MODIFICAR:**
- Aumentar `backgroundColor` dos nós para `bg-slate-700` (mais claro que `bg-secondary`)
- Adicionar ícones por tipo de agente no título

**ADICIONAR:**
- Mapeamento de ícones: `data-analyst: 📊`, `feature-engineer: ⚙️`, `modeler: 🧠`, `critic: 🔍`, `reporter: 📋`

#### 1.2 ArtifactEdge.tsx
**MODIFICAR:**
- Cor das linhas e labels para `#A0AEC0` (cinza-médio) para melhor contraste WCAG
- Aumentar `strokeWidth` de `1.5` para `2`

#### 1.3 AgentSidePanel.tsx
**REMOVER:**
- Aba "Activity" do array TABS (temporariamente até ter conteúdo real)

**MODIFICAR:**
- Empty state melhorado com texto de instrução
- Opacidade 50% para abas inativas

---

## 2. Módulo: Leaderboard (Tabela e Gráficos)

### Problema Atual
- Conflito cognitivo: barra maior = pior modelo (RMSE menor é melhor)
- Falta de escaneabilidade numérica

### Mudanças

#### 2.1 AucBarChart.tsx
**MODIFICAR:**
- Lógica da barra: para métricas "lower is better", usar escala inversa
- Altura da barra: reduzir de `h-5` para `h-3` (50%)
- Adicionar `border-radius: 4px` no lado direito (`rounded-r-md`)
- Cor do campeão: azul primário, demais em cinza `#4A5568`

#### 2.2 Leaderboard.tsx
**MODIFICAR:**
- Colunas numéricas (RMSE CV, ±STD, GAP): `text-align: right`
- Tipografia numérica: adicionar `font-mono` e `tabular-nums`
- Linha do campeão: background sutil `bg-blue-500/10`

---

## 3. Módulo: ModelDetailPanel - Visão Geral

### Problema Atual
- Excesso de bordas ("caixas dentro de caixas")
- Poluição visual

### Mudanças

#### 3.1 MetricCard (dentro de ModelDetailPanel.tsx)
**REMOVER:**
- `border` e `background` dos cartões de métricas

**MODIFICAR:**
- Label: `text-xs uppercase text-gray-400`
- Valor: `text-xl font-mono text-white`

#### 3.2 Tabela de Hiperparâmetros
**MODIFICAR:**
- Aumentar `padding` vertical das células (`py-2.5` para `py-3`)
- Chave (parâmetro): cor cinza médio
- Valor: cor branca para alto contraste

#### 3.3 Navegação em Abas
**MODIFICAR:**
- Abas inativas: `opacity-50 hover:opacity-80`
- Aba ativa: `opacity-100` com sublinhado azul

---

## 4. Módulo: ModelDetailPanel - Relatório

### Problema Atual
- Blocos de texto longos, difíceis de escanear

### Mudanças

#### 4.1 StructuredReportTab.tsx
**REMOVER:**
- Formato de parágrafo longo

**ADICIONAR:**
- Estrutura em 3 blocos semânticos:
  1. `[🧠 Hipótese]` - O que o agente tentou fazer
  2. `[⚡ Ação]` - O que foi alterado
  3. `[📊 Veredito]` - O resultado

**MODIFICAR:**
- Rótulos: `font-mono text-xs uppercase text-gray-400`
- Veredito com cores condicionais:
  - Sucesso/melhoria: `text-green-400`
  - Falha/overfitting: `text-red-400`

---

## 5. Módulo: ModelDetailPanel - Script de Reprodução

### Problema Atual
- Código sem syntax highlighting
- Botão copiar sem feedback visual

### Mudanças

#### 5.1 ScriptTab (dentro de ModelDetailPanel.tsx)
**REMOVER:**
- Container `<pre><code>` sem estilo

**ADICIONAR:**
- `react-syntax-highlighter` com tema One Dark
- Botão "📋 Copiar" fixo no canto superior direito
- Estado de feedback: "✓ Copiado!" em verde por 2s

**MODIFICAR:**
- Container: fundo mais escuro que painel + bordas arredondadas

---

## 6. Módulo: StatTiles

### Problema Atual
- Bordas desnecessárias

### Mudanças

#### 6.1 StatTiles.tsx
**REMOVER:**
- `border` dos tiles

**MODIFICAR:**
- Manter `bg-[var(--bg-secondary)]` mas remover borda
- Valor: garantir `font-mono`

---

## Dependências a Instalar

```bash
npm install react-syntax-highlighter @types/react-syntax-highlighter
```

---

## Ordem de Implementação

1. **Fase 1 - Base**: Instalar dependências, atualizar CSS tokens
2. **Fase 2 - Pipeline Flow**: AgentNode, ArtifactEdge, remover Activity
3. **Fase 3 - Leaderboard**: AucBarChart, alinhamento numérico
4. **Fase 4 - ModelDetailPanel**: MetricCard, tabs, Script highlighting
5. **Fase 5 - Report**: Estrutura semântica em 3 blocos
6. **Fase 6 - Testes**: Verificar renderização e responsividade

---

## Arquivos Afetados

```
src/dashboard/src/
├── components/
│   ├── PipelineFlow/
│   │   ├── AgentNode.tsx          [MODIFICAR]
│   │   ├── ArtifactEdge.tsx       [MODIFICAR]
│   │   └── AgentSidePanel.tsx     [MODIFICAR]
│   ├── report/
│   │   └── StructuredReportTab.tsx [MODIFICAR]
│   ├── ModelDetailPanel.tsx       [MODIFICAR]
│   ├── AucBarChart.tsx            [MODIFICAR]
│   └── StatTiles.tsx              [MODIFICAR]
├── screens/
│   └── Leaderboard.tsx            [MODIFICAR]
└── index.css                      [MODIFICAR - tokens]
```

---

## Critérios de Aceite

- [ ] Aba Activity removida do painel lateral do Pipeline Flow
- [ ] Nós do DAG com melhor contraste e ícones por tipo
- [ ] Arestas com cor `#A0AEC0` passando contraste WCAG
- [ ] Gráfico de barras com lógica inversa para métricas "lower is better"
- [ ] Colunas numéricas alinhadas à direita com fonte monospace
- [ ] Métricas sem bordas, apenas tipografia hierárquica
- [ ] Abas inativas com opacidade 50%
- [ ] Script com syntax highlighting Python
- [ ] Botão copiar com feedback visual de 2s
- [ ] Relatório estruturado em 3 blocos com cores condicionais
