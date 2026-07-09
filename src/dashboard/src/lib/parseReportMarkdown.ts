/**
 * Parser de markdown estruturado para reports de ML
 *
 * Extrai seções, tabelas e metadados do markdown gerado pelos agentes
 * para renderização customizada no dashboard.
 */

export type ReportType =
  | "feature-engineer"
  | "modeler-classic"
  | "modeler-advanced"
  | "eda"
  | "audit"
  | "unknown";

export interface ReportHeader {
  title: string;
  agent: string;
  runId: string;
  date: string;
  dataset: string;
  target: string;
  taskType: "regression" | "classification" | "unknown";
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

export interface ParsedSection {
  id: string;
  level: 1 | 2 | 3;
  title: string;
  titlePt: string;
  content: string;
  tables: ParsedTable[];
  codeBlocks: string[];
  itemCount: number;
}

export interface BaselineMetrics {
  model: string;
  cvMean: number | null;
  cvStd: number | null;
  trainMean: number | null;
  trainR2: number | null;
  valR2: number | null;
  testR2: number | null;
  metric: string;
}

export interface ParsedReport {
  type: ReportType;
  header: ReportHeader;
  sections: ParsedSection[];
  baseline: BaselineMetrics | null;
  featureCount: number | null;
  rawContent: string;
}

// ── Traduções de títulos de seção ──────────────────────────────────────

const SECTION_TRANSLATIONS: Record<string, string> = {
  // Feature Engineer
  "Feature Engineering Report": "Relatório de Engenharia de Features",
  "EDA Hypotheses Implemented": "Hipóteses do EDA Implementadas",
  "Imputation Strategy": "Estratégia de Imputação",
  "Encoding Strategy": "Estratégia de Encoding",
  "Features Created": "Features Criadas",
  "Feature Selection Applied": "Seleção de Features Aplicada",
  "Numeric Pre-processing": "Pré-processamento Numérico",
  "Validation Strategy": "Estratégia de Validação",
  "Baseline": "Modelo Base",
  "Artifacts Generated": "Artefatos Gerados",
  "Notes for Modelers": "Notas para Modeladores",

  // Modeler Classic
  "Classic Modeler": "Modelador Clássico",
  "Training Plan": "Plano de Treinamento",
  "Constraints": "Restrições",
  "Planned Trials": "Experimentos Planejados",
  "Advanced Techniques Applied/Rejected": "Técnicas Avançadas Aplicadas/Rejeitadas",
  "Success Criteria": "Critérios de Sucesso",

  // EDA
  "EDA Report": "Relatório de Análise Exploratória",
  "Exploratory Data Analysis": "Análise Exploratória de Dados",
  "Data Overview": "Visão Geral dos Dados",
  "Missing Values": "Valores Faltantes",
  "Feature Distributions": "Distribuições de Features",
  "Correlations": "Correlações",
  "Target Analysis": "Análise do Target",
  "Recommendations": "Recomendações",

  // Audit
  "Audit Report": "Relatório de Auditoria",
  "Model Validation": "Validação do Modelo",
  "Overfitting Check": "Verificação de Overfitting",
  "Feature Leakage": "Vazamento de Features",

  // Subsections
  "mRMR": "mRMR (Mín. Redundância Máx. Relevância)",
  "Permutation Feature Importance": "Importância por Permutação",
  "L1-based Embedded Selection": "Seleção Embarcada L1",
  "RFECV": "RFECV (Eliminação Recursiva)",
  "Automated Binning": "Binning Automático",
  "Yeo-Johnson Power Transform": "Transformação Yeo-Johnson",
  "Iterative Imputation": "Imputação Iterativa (MICE)",
  "Bayesian Target Encoding": "Encoding Bayesiano",
  "Automated Interaction Detection": "Detecção de Interações",
  "Dependent Feature Deduplication": "Deduplicação de Features",
  "Feature Stability Validation": "Validação de Estabilidade",
  "Merge Decision": "Decisão de Merge",
  "Why CV R² seems low": "Por que o CV R² parece baixo",
};

function translateTitle(title: string): string {
  // Exact match
  if (SECTION_TRANSLATIONS[title]) {
    return SECTION_TRANSLATIONS[title];
  }

  // Partial match
  for (const [en, pt] of Object.entries(SECTION_TRANSLATIONS)) {
    if (title.includes(en)) {
      return title.replace(en, pt);
    }
  }

  return title;
}

// ── Detection ──────────────────────────────────────────────────────────

function detectReportType(content: string): ReportType {
  const lower = content.toLowerCase();

  if (lower.includes("feature engineering report")) return "feature-engineer";
  if (lower.includes("classic modeler")) return "modeler-classic";
  if (lower.includes("advanced modeler")) return "modeler-advanced";
  if (lower.includes("eda report") || lower.includes("exploratory data analysis")) return "eda";
  if (lower.includes("audit report") || lower.includes("model validation")) return "audit";

  return "unknown";
}

function detectTaskType(content: string): "regression" | "classification" | "unknown" {
  const lower = content.toLowerCase();

  if (lower.includes("(regression)") || lower.includes("regress")) return "regression";
  if (lower.includes("(classification)") || lower.includes("classif")) return "classification";

  return "unknown";
}

// ── Header Extraction ──────────────────────────────────────────────────

function extractHeader(content: string): ReportHeader {
  const lines = content.split('\n');
  const header: Record<string, string> = {};
  let title = "";

  for (const line of lines) {
    // First # header is the title
    if (line.startsWith('# ') && !title) {
      title = line.slice(2).trim();
      continue;
    }

    // Stop at first --- separator
    if (line.trim() === '---') break;

    // Match **Key:** Value pattern
    const match = line.match(/^\*\*(.+?):\*\*\s*(.+)$/);
    if (match) {
      const [, key, value] = match;
      header[key.toLowerCase().trim()] = value.trim();
    }
  }

  // Extract dataset info
  let dataset = header['input dataset'] ?? header['dataset'] ?? header['data'] ?? '';
  // Clean backticks
  dataset = dataset.replace(/`/g, '');

  return {
    title: translateTitle(title),
    agent: header['agent'] ?? '',
    runId: header['run'] ?? '',
    date: header['date'] ?? '',
    dataset,
    target: (header['target'] ?? '').replace(/`/g, ''),
    taskType: detectTaskType(content),
  };
}

// ── Section Extraction ─────────────────────────────────────────────────

function extractSections(content: string): ParsedSection[] {
  const sections: ParsedSection[] = [];
  const lines = content.split('\n');

  let currentSection: ParsedSection | null = null;
  let contentLines: string[] = [];
  let sectionIndex = 0;

  // Skip header until first ---
  let inHeader = true;

  for (const line of lines) {
    if (inHeader) {
      if (line.trim() === '---') {
        inHeader = false;
      }
      continue;
    }

    // Check for section headers
    const h2Match = line.match(/^## (\d+\.)?\s*(.+)$/);
    const h3Match = line.match(/^### (\d+\.\d+)?\s*(.+)$/);

    if (h2Match || h3Match) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim();
        currentSection.tables = extractTables(currentSection.content);
        currentSection.codeBlocks = extractCodeBlocks(currentSection.content);
        currentSection.itemCount = countItems(currentSection);
        sections.push(currentSection);
      }

      const match = h2Match ?? h3Match;
      const level = h2Match ? 2 : 3;
      const title = match![2].trim();

      currentSection = {
        id: `section-${sectionIndex++}`,
        level: level as 2 | 3,
        title,
        titlePt: translateTitle(title),
        content: '',
        tables: [],
        codeBlocks: [],
        itemCount: 0,
      };
      contentLines = [];
    } else if (currentSection) {
      contentLines.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim();
    currentSection.tables = extractTables(currentSection.content);
    currentSection.codeBlocks = extractCodeBlocks(currentSection.content);
    currentSection.itemCount = countItems(currentSection);
    sections.push(currentSection);
  }

  return sections;
}

// ── Table Extraction ───────────────────────────────────────────────────

function extractTables(content: string): ParsedTable[] {
  const tables: ParsedTable[] = [];
  const lines = content.split('\n');

  let inTable = false;
  let currentTable: ParsedTable | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Table row starts with |
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      // Skip separator rows (|---|---|)
      if (trimmed.match(/^\|[\s-:|]+\|$/)) {
        continue;
      }

      const cells = trimmed
        .split('|')
        .slice(1, -1) // Remove first and last empty strings
        .map(cell => cell.trim());

      if (!inTable) {
        // First row is headers
        inTable = true;
        currentTable = { headers: cells, rows: [] };
      } else if (currentTable) {
        currentTable.rows.push(cells);
      }
    } else if (inTable && currentTable) {
      // End of table
      tables.push(currentTable);
      inTable = false;
      currentTable = null;
    }
  }

  // Don't forget last table
  if (currentTable) {
    tables.push(currentTable);
  }

  return tables;
}

// ── Code Block Extraction ──────────────────────────────────────────────

function extractCodeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```[\w]*\n([\s\S]*?)```/g;

  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1].trim());
  }

  return blocks;
}

// ── Item Counting ──────────────────────────────────────────────────────

function countItems(section: ParsedSection): number {
  // Count table rows
  const tableRows = section.tables.reduce((sum, t) => sum + t.rows.length, 0);

  // Count bullet points
  const bullets = (section.content.match(/^[-*]\s/gm) ?? []).length;

  // Count numbered items
  const numbered = (section.content.match(/^\d+\.\s/gm) ?? []).length;

  return Math.max(tableRows, bullets + numbered);
}

// ── Baseline Extraction ────────────────────────────────────────────────

function extractBaseline(content: string): BaselineMetrics | null {
  // Look for baseline section
  const baselineMatch = content.match(/## \d*\.?\s*Baseline[\s\S]*?(?=##|$)/i);
  if (!baselineMatch) return null;

  const section = baselineMatch[0];

  // Extract model type
  const modelMatch = section.match(/\*\*Model type\*\*[:\s]*`?([^`\n]+)`?/i)
    ?? section.match(/Model[:\s]*`?([^`\n(]+)/i);

  // Extract CV metrics
  const cvR2Match = section.match(/CV R²[^:]*?[:\s]*\*?\*?(\d+\.?\d*)\s*±\s*(\d+\.?\d*)/i)
    ?? section.match(/CV.*?(\d+\.?\d*)\s*±\s*(\d+\.?\d*)/i);

  const trainR2Match = section.match(/Train R²[^:]*?[:\s]*(\d+\.?\d*)/i);
  const valR2Match = section.match(/Val R²[^:]*?[:\s]*(\d+\.?\d*)/i);
  const testR2Match = section.match(/Test R²[^:]*?[:\s]*(\d+\.?\d*)/i);

  return {
    model: modelMatch?.[1]?.trim() ?? "Unknown",
    cvMean: cvR2Match ? parseFloat(cvR2Match[1]) : null,
    cvStd: cvR2Match ? parseFloat(cvR2Match[2]) : null,
    trainMean: trainR2Match ? parseFloat(trainR2Match[1]) : null,
    trainR2: trainR2Match ? parseFloat(trainR2Match[1]) : null,
    valR2: valR2Match ? parseFloat(valR2Match[1]) : null,
    testR2: testR2Match ? parseFloat(testR2Match[1]) : null,
    metric: "R²",
  };
}

// ── Feature Count Extraction ───────────────────────────────────────────

function extractFeatureCount(content: string): number | null {
  // Look for patterns like "6 features" or "× 4 features"
  const match = content.match(/(\d+)\s*features?/i)
    ?? content.match(/×\s*(\d+)\s*(?:cols?|features?)/i);

  return match ? parseInt(match[1], 10) : null;
}

// ── Main Parser ────────────────────────────────────────────────────────

export function parseReportMarkdown(content: string): ParsedReport {
  if (!content || typeof content !== 'string') {
    return {
      type: "unknown",
      header: {
        title: "Relatório",
        agent: "",
        runId: "",
        date: "",
        dataset: "",
        target: "",
        taskType: "unknown",
      },
      sections: [],
      baseline: null,
      featureCount: null,
      rawContent: content ?? "",
    };
  }

  const type = detectReportType(content);
  const header = extractHeader(content);
  const sections = extractSections(content);
  const baseline = extractBaseline(content);
  const featureCount = extractFeatureCount(content);

  return {
    type,
    header,
    sections,
    baseline,
    featureCount,
    rawContent: content,
  };
}

// ── Status Detection ───────────────────────────────────────────────────

export type StatusType =
  | "APPLIED"
  | "REJECTED"
  | "FAILED"
  | "NA"
  | "KEPT"
  | "DROPPED"
  | "OBEYED"
  | "SKIPPED"
  | "PENDING"
  | "UNKNOWN";

export function detectStatus(text: string): StatusType {
  const upper = text.toUpperCase();

  if (upper.includes("✅") || upper.includes("APPLIED") || upper.includes("YES")) return "APPLIED";
  if (upper.includes("⚠️") || upper.includes("REJECTED") || upper.includes("WARN")) return "REJECTED";
  if (upper.includes("❌") || upper.includes("FAILED") || upper.includes("NO")) return "FAILED";
  if (upper.includes("N/A") || upper.includes("—")) return "NA";
  if (upper.includes("KEPT") || upper.includes("✓")) return "KEPT";
  if (upper.includes("DROPPED") || upper.includes("REMOVED")) return "DROPPED";
  if (upper.includes("OBEYED") || upper.includes("FOLLOWED")) return "OBEYED";
  if (upper.includes("SKIPPED") || upper.includes("SKIP")) return "SKIPPED";
  if (upper.includes("PENDING") || upper.includes("TODO")) return "PENDING";

  return "UNKNOWN";
}
