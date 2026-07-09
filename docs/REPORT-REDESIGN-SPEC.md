# Especificação de Redesign — Report Panel

**Data:** 2026-07-09  
**Autor:** Claude (assistente)  
**Escopo:** Refatoração visual completa da aba "Report" no `ModelDetailPanel`

---

## 1. Problema Atual

A aba "Report" atualmente exibe o conteúdo markdown bruto gerado pelos agentes ML. Os problemas identificados:

| Problema | Impacto |
|----------|---------|
| Texto em inglês técnico | Usuários brasileiros têm dificuldade de compreensão |
| Tabelas markdown mal formatadas | Difícil leitura em dispositivos menores |
| Sem hierarquia visual | Informações importantes se perdem no texto |
| Sem destaque de métricas | Números críticos (CV R², RMSE) não se destacam |
| Sem cores semânticas | Status ✅/❌/⚠️ são apenas emoji, não badges |
| Scroll infinito | Report completo pode ter 300+ linhas |

---

## 2. Solução Proposta

### 2.1 Arquitetura de Componentes

Substituir o renderer genérico de Markdown por um **parser estruturado** que extrai seções do report e as renderiza com componentes React customizados.

```
ModelDetailPanel
└── ReportTab (REFATORADO)
    ├── ReportHeader          # Metadados: Agent, Run, Date, Dataset
    ├── ReportSummaryCards    # Cards coloridos com métricas-chave
    ├── ReportSections        # Acordeão colapsável por seção
    │   ├── SectionFeatures   # Tabela com status badges
    │   ├── SectionMetrics    # Grid de métricas com sparklines
    │   ├── SectionAlgorithms # Comparativo de algoritmos
    │   └── SectionNotes      # Notas para modeladores
    └── ReportRawToggle       # Botão para ver markdown original
```

### 2.2 Design System — Paleta de Cores

Usar as variáveis CSS já definidas em `index.css`:

| Semântica | Variável | Uso |
|-----------|----------|-----|
| Sucesso/Aplicado | `--accent-green` | Status ✅ APLICADO |
| Alerta/Rejeitado | `--accent-orange` | Status ⚠️ REJEITADO |
| Erro/Falha | `--accent-red` | Status ❌ FALHA |
| Info/Neutro | `--accent-blue` | Métricas, links |
| Destaque | `--accent-purple` | Baseline, winner |

### 2.3 Tradução de Termos

Criar um dicionário de tradução para termos técnicos:

```typescript
const TRANSLATIONS = {
  // Seções
  "Feature Engineering Report": "Relatório de Engenharia de Features",
  "EDA Hypotheses Implemented": "Hipóteses do EDA Implementadas",
  "Imputation Strategy": "Estratégia de Imputação",
  "Encoding Strategy": "Estratégia de Encoding",
  "Features Created": "Features Criadas",
  "Feature Selection Applied": "Seleção de Features Aplicada",
  "Validation Strategy": "Estratégia de Validação",
  "Baseline": "Modelo Base",
  "Artifacts Generated": "Artefatos Gerados",
  "Notes for Modelers": "Notas para Modeladores",
  
  // Status
  "APPLIED": "APLICADO",
  "REJECTED": "REJEITADO", 
  "N/A": "N/A",
  "OBEYED": "SEGUIDO",
  "KEPT": "MANTIDO",
  "DROPPED": "REMOVIDO",
  
  // Métricas
  "CV Mean": "Média CV",
  "CV Std": "Desvio CV",
  "Train Mean": "Média Treino",
  "Train/Val Gap": "Gap Treino/Val",
  "R²": "R²",
  "RMSE": "RMSE",
  "MAPE": "MAPE",
  
  // Termos técnicos (manter em inglês com tooltip)
  "mRMR": "mRMR",
  "RFECV": "RFECV",
  "Lasso": "Lasso",
  "Ridge": "Ridge",
  "StandardScaler": "StandardScaler",
};
```

---

## 3. Especificação Detalhada dos Componentes

### 3.1 `ReportHeader`

**Propósito:** Exibir metadados do report de forma compacta e visual.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ 🔬 Engenharia de Features                                   │
│ ─────────────────────────────────────────────────────────── │
│ Agente: Feature Engineer    │  Run: 7559a1f8...            │
│ Data: 01/07/2026            │  Dataset: 10 linhas × 4 cols │
│ Target: price (regressão)   │  Status: ✅ Sucesso          │
└─────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface ReportHeaderProps {
  title: string;           // "Feature Engineering Report"
  agentName: string;       // "Feature Engineer"
  runId: string;
  date: string;
  datasetInfo: string;     // "10 rows × 4 features"
  target: string;          // "price"
  taskType: "regression" | "classification";
}
```

**Estilização:**
- Background: `var(--bg-tertiary)`
- Border-left: 4px solid `var(--accent-blue)`
- Title: `text-lg font-semibold text-[var(--text-primary)]`
- Labels: `text-xs text-[var(--text-muted)]`
- Values: `text-sm font-mono text-[var(--text-secondary)]`

---

### 3.2 `ReportSummaryCards`

**Propósito:** Destacar as métricas mais importantes em cards coloridos.

**Layout:**
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ 📊 CV R²     │ │ 📉 RMSE      │ │ ⚖️ Gap       │ │ 🎯 Features  │
│ 0.4697       │ │ 0.1460       │ │ 0.0012       │ │ 6            │
│ ± 0.1566     │ │ ± 0.0820     │ │ ✅ Baixo     │ │ selecionadas │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

**Props:**
```typescript
interface SummaryCard {
  icon: string;
  label: string;
  value: string | number;
  subValue?: string;
  status?: "good" | "warning" | "bad";
}

interface ReportSummaryCardsProps {
  cards: SummaryCard[];
}
```

**Estilização:**
- Grid: `grid-cols-2 sm:grid-cols-4 gap-3`
- Card: `rounded-lg border bg-[var(--bg-secondary)] p-4`
- Status colors:
  - good: border-l-4 `var(--accent-green)`
  - warning: border-l-4 `var(--accent-orange)`
  - bad: border-l-4 `var(--accent-red)`
- Value: `text-2xl font-bold font-mono`
- SubValue: `text-xs text-[var(--text-muted)]`

---

### 3.3 `ReportSections` (Acordeão)

**Propósito:** Organizar o conteúdo em seções colapsáveis para reduzir scroll.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ ▼ 1. Hipóteses do EDA Implementadas              [4 itens] │
├─────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Recomendação                    │ Status │ Notas      │ │
│  ├────────────────────────────────────────────────────────┤ │
│  │ Log-transform target            │ ✅     │ np.log()   │ │
│  │ Standard scaling                │ ✅     │ Treino     │ │
│  │ Interação sqft × age            │ ⚠️     │ MI < pai   │ │
│  │ Age binning                     │ ✅     │ 3 bins     │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

│ ▶ 2. Estratégia de Imputação                       [0 itens] │

│ ▶ 3. Features Criadas                              [3 itens] │
```

**Props:**
```typescript
interface ReportSection {
  id: string;
  title: string;
  titlePt: string;
  itemCount: number;
  defaultOpen: boolean;
  content: React.ReactNode;
}

interface ReportSectionsProps {
  sections: ReportSection[];
}
```

**Comportamento:**
- Seções com `itemCount > 0` iniciam expandidas
- Seções vazias ou "N/A" iniciam colapsadas
- Animação suave de expand/collapse (150ms ease-out)
- Ícone ▼/▶ à esquerda do título

**Estilização:**
- Header: `py-3 px-4 bg-[var(--bg-tertiary)] cursor-pointer hover:bg-[var(--bg-secondary)]`
- Title: `font-medium text-[var(--text-primary)]`
- Badge count: `text-xs bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] px-2 py-0.5 rounded-full`
- Content: `p-4 border-t border-[var(--border-default)]`

---

### 3.4 `StatusBadge` (Aprimorado)

**Propósito:** Renderizar status com cores semânticas e ícones.

**Variantes:**
```
┌─────────────────────────────────────────────────────────────┐
│ ✅ APLICADO   ⚠️ REJEITADO   ❌ FALHA   ➖ N/A   ✓ MANTIDO │
└─────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
type StatusType = 
  | "APPLIED" | "REJECTED" | "FAILED" | "NA" | "KEPT" 
  | "DROPPED" | "OBEYED" | "SKIPPED" | "PENDING";

interface StatusBadgeProps {
  status: StatusType;
  size?: "sm" | "md";
}
```

**Mapeamento de cores:**
```typescript
const STATUS_CONFIG = {
  APPLIED: { icon: "✓", bg: "green", label: "APLICADO" },
  REJECTED: { icon: "⚠", bg: "orange", label: "REJEITADO" },
  FAILED: { icon: "✕", bg: "red", label: "FALHA" },
  NA: { icon: "—", bg: "gray", label: "N/A" },
  KEPT: { icon: "✓", bg: "green", label: "MANTIDO" },
  DROPPED: { icon: "✕", bg: "red", label: "REMOVIDO" },
  OBEYED: { icon: "✓", bg: "green", label: "SEGUIDO" },
  SKIPPED: { icon: "→", bg: "gray", label: "PULADO" },
  PENDING: { icon: "◌", bg: "blue", label: "PENDENTE" },
};
```

---

### 3.5 `FeatureTable`

**Propósito:** Renderizar tabelas de features com status coloridos.

**Layout:**
```
┌────────────────────────────────────────────────────────────────┐
│  Feature           │ Importância │ Estabilidade │ Status      │
├────────────────────────────────────────────────────────────────┤
│  square_feet       │ ████████ 87% │ ✅ Estável   │ ✅ MANTIDO  │
│  age_years         │ ████░░░░ 74% │ ✅ Estável   │ ✅ MANTIDO  │
│  bedrooms          │ ██░░░░░░ 40% │ ⚠️ Instável │ ⚠️ FRAGIL  │
│  bathrooms         │ █░░░░░░░ 14% │ ⚠️ Instável │ ⚠️ FRAGIL  │
└────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface FeatureRow {
  name: string;
  importance?: number;      // 0-100
  stability?: number;       // 0-100
  status: StatusType;
  notes?: string;
}

interface FeatureTableProps {
  features: FeatureRow[];
  showImportance?: boolean;
  showStability?: boolean;
}
```

**Estilização:**
- Barra de importância: `h-2 bg-[var(--accent-blue)] rounded`
- Threshold visual: 70% = estável (verde), < 70% = instável (laranja)

---

### 3.6 `AlgorithmComparisonTable`

**Propósito:** Comparar algoritmos testados com destaque no vencedor.

**Layout:**
```
┌─────────────────────────────────────────────────────────────────┐
│  Algoritmo         │ CV RMSE (média) │ CV RMSE (std) │ Vencedor │
├─────────────────────────────────────────────────────────────────┤
│  🏆 Ridge          │ 10,968.97       │ 1,646.14      │ ✅       │
│  Lasso             │ 10,977.25       │ 1,641.38      │          │
│  XGBoost           │ 11,234.56       │ 2,103.22      │          │
└─────────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface AlgorithmResult {
  name: string;
  cvMean: number;
  cvStd: number;
  isWinner: boolean;
  hyperparameters?: Record<string, unknown>;
}

interface AlgorithmComparisonTableProps {
  algorithms: AlgorithmResult[];
  metric: string;           // "RMSE" | "R²" | "F1"
  direction: "lower" | "higher";  // lower is better for RMSE
}
```

**Estilização:**
- Winner row: `bg-[var(--accent-green)]/10 border-l-4 border-[var(--accent-green)]`
- Trophy icon: 🏆 antes do nome do vencedor

---

### 3.7 `MetricHighlight`

**Propósito:** Destacar uma métrica específica com contexto.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│  CV R² = 0.4697 ± 0.1566                                    │
│  ──────────────────────────────────────────────────────────  │
│  📊 Interpretação: Performance razoável para n=10.          │
│     Esperado variância alta com 3-fold CV.                  │
└─────────────────────────────────────────────────────────────┘
```

**Props:**
```typescript
interface MetricHighlightProps {
  name: string;
  value: number;
  std?: number;
  interpretation?: string;
  benchmarkLabel?: string;   // "Baseline", "Target"
  benchmarkValue?: number;
  status: "good" | "neutral" | "bad";
}
```

---

### 3.8 `ReportRawToggle`

**Propósito:** Permitir ver o markdown original para usuários avançados.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ [Ver markdown original ▼]                                   │
└─────────────────────────────────────────────────────────────┘
```

Quando expandido:
```
┌─────────────────────────────────────────────────────────────┐
│ [Ocultar markdown ▲]                     [📋 Copiar]       │
├─────────────────────────────────────────────────────────────┤
│ # Feature Engineering Report                                │
│ **Agent:** Feature Engineer...                              │
│ ...                                                         │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Parser de Markdown Estruturado

### 4.1 Estratégia de Parsing

O parser deve extrair seções baseadas em headers markdown (`#`, `##`, `###`).

```typescript
interface ParsedReport {
  type: "feature-engineer" | "modeler-classic" | "modeler-advanced" | "eda" | "audit";
  header: {
    agent: string;
    runId: string;
    date: string;
    dataset: string;
    target: string;
  };
  sections: ParsedSection[];
  rawContent: string;
}

interface ParsedSection {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  content: string;
  tables: ParsedTable[];
  lists: string[];
  codeBlocks: string[];
}

interface ParsedTable {
  headers: string[];
  rows: string[][];
}
```

### 4.2 Funções de Parsing

```typescript
// parseReportMarkdown.ts

export function parseReportMarkdown(content: string): ParsedReport {
  // 1. Detectar tipo de report pelo título
  const type = detectReportType(content);
  
  // 2. Extrair header (primeiras linhas até ---)
  const header = extractHeader(content);
  
  // 3. Dividir por seções (## Title)
  const sections = extractSections(content);
  
  // 4. Para cada seção, extrair tabelas, listas, code blocks
  const parsedSections = sections.map(parseSection);
  
  return { type, header, sections: parsedSections, rawContent: content };
}

function detectReportType(content: string): ReportType {
  if (content.includes("Feature Engineering Report")) return "feature-engineer";
  if (content.includes("Classic Modeler")) return "modeler-classic";
  if (content.includes("Advanced Modeler")) return "modeler-advanced";
  if (content.includes("EDA Report")) return "eda";
  if (content.includes("Audit Report")) return "audit";
  return "unknown";
}

function extractHeader(content: string): ReportHeader {
  const lines = content.split('\n');
  const header: Record<string, string> = {};
  
  for (const line of lines) {
    if (line.startsWith('---')) break;
    const match = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      header[key.toLowerCase()] = value.trim();
    }
  }
  
  return {
    agent: header['agent'] ?? '',
    runId: header['run'] ?? '',
    date: header['date'] ?? '',
    dataset: header['input dataset'] ?? header['dataset'] ?? '',
    target: header['target'] ?? '',
  };
}
```

---

## 5. Plano de Implementação

### Fase 1: Infraestrutura (1-2 dias)
1. ✅ Criar `parseReportMarkdown.ts` com parser básico
2. ✅ Criar dicionário de traduções `reportTranslations.ts`
3. ✅ Criar componentes base: `StatusBadge`, `SummaryCard`, `CollapsibleSection`

### Fase 2: Componentes Visuais (2-3 dias)
1. ✅ `ReportHeader` com metadados extraídos
2. ✅ `ReportSummaryCards` com métricas-chave
3. ✅ `FeatureTable` com barras de importância
4. ✅ `AlgorithmComparisonTable` com destaque no vencedor
5. ✅ `ReportSections` acordeão colapsável

### Fase 3: Integração (1 dia)
1. ✅ Substituir `ReportTab` atual pelo novo componente
2. ✅ Manter `ReportRawToggle` para fallback
3. ✅ Testes visuais em diferentes reports

### Fase 4: Remoção do Antigo (1 dia)
1. ✅ Remover `ComparePanel.tsx` (não será mais usado)
2. ✅ Remover referências ao botão "Compare Models"
3. ✅ Limpar imports não utilizados

---

## 6. Remoções Planejadas

### 6.1 Arquivos a Remover
```
src/dashboard/src/components/ComparePanel.tsx     # Componente inteiro
```

### 6.2 Código a Remover em Outros Arquivos

**`Leaderboard.tsx`** (ou tela que usa ComparePanel):
- Remover import de `ComparePanel`
- Remover state `selectedForCompare`
- Remover botão "Compare Models"
- Remover lógica de seleção múltipla

**`api.ts`**:
- Avaliar se `useCompareExperiments` ainda é necessário
- Se não for usado em nenhum lugar, remover

---

## 7. Critérios de Aceitação

### 7.1 Funcionalidade
- [ ] Report é parseado corretamente para todos os 5 tipos de agente
- [ ] Seções são colapsáveis e lembram estado
- [ ] Tabelas renderizam com status badges coloridos
- [ ] Métricas-chave aparecem em cards destacados
- [ ] Markdown original acessível via toggle

### 7.2 Visual
- [ ] Cores seguem paleta definida em `index.css`
- [ ] Texto traduzido para português
- [ ] Tooltips em termos técnicos (mRMR, RFECV, etc.)
- [ ] Responsivo em telas menores (mobile-first)

### 7.3 Performance
- [ ] Parsing não bloqueia UI (< 50ms para reports grandes)
- [ ] Lazy loading de seções se necessário
- [ ] Sem re-renders desnecessários

### 7.4 Acessibilidade
- [ ] Contraste mínimo 4.5:1 para texto
- [ ] Keyboard navigation funcional
- [ ] Screen reader compatibility (aria-labels)

---

## 8. Mockups ASCII

### 8.1 Report Tab — Estado Padrão

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 🔬 Relatório de Engenharia de Features                                  │
│ ─────────────────────────────────────────────────────────────────────── │
│ Agente: Feature Engineer       │  Run: 7559a1f8-4689-45d5-...          │
│ Data: 01/07/2026               │  Dataset: 10 linhas × 4 features      │
│ Target: price (regressão)      │  Modelo Base: Ridge                   │
└─────────────────────────────────────────────────────────────────────────┘

┌───────────────┐ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ 📊 CV R²      │ │ 📉 CV RMSE    │ │ ⚖️ Gap        │ │ 🎯 Features   │
│ 0.4697        │ │ 0.1460        │ │ 0.0012        │ │ 6             │
│ ± 0.1566      │ │ ± 0.0820      │ │ ✅ Baixo      │ │ selecionadas  │
└───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ ▼ 1. Hipóteses do EDA Implementadas                          [6 itens] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   ┌──────────────────────────────────────────────────────────────────┐  │
│   │ Recomendação                       │ Status      │ Notas        │  │
│   ├──────────────────────────────────────────────────────────────────┤  │
│   │ Log-transform no target            │ ✅ APLICADO │ np.log()     │  │
│   │ Standard scaling em features       │ ✅ APLICADO │ só no treino │  │
│   │ Baseline com Ridge                 │ ✅ APLICADO │ alpha=1.0    │  │
│   │ Interação sqft × age               │ ⚠️ REJEITADO │ MI < parent │  │
│   │ Age binning (new/mid/old)          │ ✅ APLICADO │ one-hot      │  │
│   │ Evitar price_per_sqft              │ ✅ SEGUIDO  │ leakage      │  │
│   └──────────────────────────────────────────────────────────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

│ ▶ 2. Estratégia de Imputação                                 [0 itens] │

│ ▶ 3. Features Criadas                                        [3 itens] │

│ ▶ 4. Seleção de Features                                    [11 itens] │

│ ▼ 5. Modelo Base                                              [detalhes] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   Modelo: Ridge(alpha=1.0)                                              │
│   Target: price_log (log-transformado)                                  │
│                                                                         │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │ Métrica        │ Treino   │ Validação │ CV (log)              │    │
│   ├────────────────────────────────────────────────────────────────┤    │
│   │ R²             │ 0.9941   │ 0.3936    │ 0.4697 ± 0.1566       │    │
│   │ RMSE           │ —        │ —         │ 0.1460 ± 0.0820       │    │
│   │ MAPE           │ 2.41%    │ —         │ —                     │    │
│   └────────────────────────────────────────────────────────────────┘    │
│                                                                         │
│   💡 Por que CV R² = 0.47 parece baixo?                                 │
│   Com apenas 6 amostras de treino e 3-fold CV, a variância é alta.      │
│   O modelo ajusta bem (R²=0.994 no treino) mas generalização é difícil. │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ [📄 Ver markdown original]                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

### 8.2 Card de Métrica — Variantes

```
Estado: BOM (gap baixo)              Estado: ALERTA (gap médio)
┌───────────────────────┐            ┌───────────────────────┐
│ ⚖️ Gap Treino/Val     │            │ ⚖️ Gap Treino/Val     │
│ 0.0012                │            │ 0.0856                │
│ ✅ Baixo (< 5%)       │            │ ⚠️ Moderado (5-10%)   │
│ ▌                     │            │ ▌▌▌▌▌▌▌▌             │
└───────────────────────┘            └───────────────────────┘
  (borda verde)                        (borda laranja)

Estado: RUIM (gap alto)
┌───────────────────────┐
│ ⚖️ Gap Treino/Val     │
│ 0.2341                │
│ ❌ Alto (> 10%)       │
│ ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌ │
└───────────────────────┘
  (borda vermelha)
```

---

## 9. Considerações Finais

### 9.1 Backward Compatibility
- O parser deve ter fallback para markdown genérico caso não reconheça o formato
- O botão "Ver markdown original" garante acesso ao conteúdo completo

### 9.2 Extensibilidade
- Novos tipos de report (ex: "Hyperparameter Tuning Report") podem ser adicionados
- Cada tipo pode ter seu próprio template de renderização

### 9.3 Internacionalização
- O dicionário de tradução pode ser expandido para outros idiomas
- Estrutura pronta para i18n se necessário no futuro

---

**Próximo passo:** Implementar Fase 1 (parser + componentes base)
