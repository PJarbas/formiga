/**
 * Dicionário de traduções para reports de ML
 *
 * Traduz termos técnicos em inglês para português brasileiro,
 * mantendo termos como mRMR, RFECV, etc. em inglês com tooltips explicativos.
 */

// ── Termos que devem permanecer em inglês (com tooltip) ────────────────

export const TECHNICAL_TERMS: Record<string, string> = {
  mRMR: "Minimum Redundancy Maximum Relevance - algoritmo de seleção de features",
  RFECV: "Recursive Feature Elimination with Cross-Validation",
  Lasso: "Least Absolute Shrinkage and Selection Operator - regularização L1",
  Ridge: "Regressão com regularização L2",
  ElasticNet: "Combinação de regularização L1 e L2",
  StandardScaler: "Normalização z-score (média 0, desvio 1)",
  MinMaxScaler: "Normalização para intervalo [0, 1]",
  XGBoost: "Extreme Gradient Boosting",
  LightGBM: "Light Gradient Boosting Machine",
  CatBoost: "Categorical Boosting",
  RandomForest: "Floresta Aleatória",
  "Yeo-Johnson": "Transformação de potência para normalizar distribuições",
  MICE: "Multiple Imputation by Chained Equations",
  MI: "Mutual Information - informação mútua entre variáveis",
  MAD: "Median Absolute Deviation - desvio absoluto mediano",
  OOF: "Out-of-Fold - predições fora da dobra de treino",
  CV: "Cross-Validation - validação cruzada",
  RMSE: "Root Mean Square Error - raiz do erro quadrático médio",
  MAE: "Mean Absolute Error - erro absoluto médio",
  MAPE: "Mean Absolute Percentage Error - erro percentual médio",
  "R²": "Coeficiente de determinação",
  F1: "Média harmônica de precisão e recall",
  AUC: "Area Under the ROC Curve",
  ROC: "Receiver Operating Characteristic",
};

// ── Status ─────────────────────────────────────────────────────────────

export const STATUS_TRANSLATIONS: Record<string, string> = {
  APPLIED: "APLICADO",
  REJECTED: "REJEITADO",
  FAILED: "FALHA",
  "N/A": "N/A",
  KEPT: "MANTIDO",
  DROPPED: "REMOVIDO",
  OBEYED: "SEGUIDO",
  SKIPPED: "PULADO",
  PENDING: "PENDENTE",
  SUCCESS: "SUCESSO",
  AUDITED: "AUDITADO",
  OVERFITTED: "OVERFITTING",
};

// ── Métricas ───────────────────────────────────────────────────────────

export const METRIC_TRANSLATIONS: Record<string, string> = {
  "CV Mean": "Média CV",
  "CV Std": "Desvio CV",
  "Train Mean": "Média Treino",
  "Train/Val Gap": "Gap Treino/Val",
  "Train time": "Tempo de treino",
  "Inference time": "Tempo de inferência",
  "Feature Importance": "Importância da Feature",
  Stability: "Estabilidade",
  Threshold: "Limiar",
};

// ── Labels de interface ────────────────────────────────────────────────

export const UI_LABELS = {
  // Tabs
  overview: "Visão Geral",
  report: "Relatório",
  reproductionScript: "Script de Reprodução",

  // Actions
  copyToClipboard: "Copiar",
  download: "Baixar",
  viewRawMarkdown: "Ver markdown original",
  hideRawMarkdown: "Ocultar markdown",
  expand: "Expandir",
  collapse: "Recolher",

  // Empty states
  noReport: "Nenhum relatório disponível para este experimento.",
  noScript: "Não foi possível gerar o script de reprodução.",
  loading: "Carregando...",
  loadingReport: "Carregando relatório...",
  generatingScript: "Gerando script...",

  // Sections
  metrics: "Métricas",
  hyperparameters: "Hiperparâmetros",
  topFeatures: "Top Features",
  arenaInsights: "Insights da Arena",
  hypothesis: "Hipótese",
  learned: "Aprendizado",
  artifact: "Artefato",

  // Status
  lowGap: "Baixo",
  moderateGap: "Moderado",
  highGap: "Alto",
  stable: "Estável",
  unstable: "Instável",

  // Summary cards
  cvScore: "Score CV",
  trainValGap: "Gap Treino/Val",
  featuresSelected: "Features Selecionadas",
  baselineModel: "Modelo Base",
};

// ── Interpretações contextuais ─────────────────────────────────────────

export const INTERPRETATIONS = {
  lowGap: (gap: number) =>
    `Gap de ${(gap * 100).toFixed(1)}% indica baixo risco de overfitting.`,
  moderateGap: (gap: number) =>
    `Gap de ${(gap * 100).toFixed(1)}% indica risco moderado de overfitting. Considere mais regularização.`,
  highGap: (gap: number) =>
    `Gap de ${(gap * 100).toFixed(1)}% indica alto risco de overfitting. O modelo memoriza os dados de treino.`,

  smallDataset: (n: number) =>
    `Dataset pequeno (n=${n}). Resultados de CV terão alta variância.`,
  tinyDataset: (n: number) =>
    `Dataset muito pequeno (n=${n}). Métricas são indicativas, não definitivas.`,

  highCvStd: (std: number, mean: number) =>
    `Desvio CV alto (${(std / mean * 100).toFixed(0)}% da média). Modelo sensível à divisão dos dados.`,

  stableFeature: (stability: number) =>
    `Estabilidade de ${stability}% em bootstrap. Feature confiável.`,
  unstableFeature: (stability: number) =>
    `Estabilidade de apenas ${stability}% em bootstrap. Feature pode ser ruído.`,
};

// ── Função helper para traduzir ────────────────────────────────────────

export function t(key: string, fallback?: string): string {
  return (
    STATUS_TRANSLATIONS[key] ??
    METRIC_TRANSLATIONS[key] ??
    UI_LABELS[key as keyof typeof UI_LABELS] ??
    fallback ??
    key
  );
}

export function getTooltip(term: string): string | undefined {
  return TECHNICAL_TERMS[term];
}

// ── Formatação de números ──────────────────────────────────────────────

export function formatMetric(value: number, decimals = 4): string {
  return value.toLocaleString("pt-BR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatPercent(value: number, decimals = 1): string {
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatDuration(seconds: number): string {
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

export function formatDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return isoDate;
  }
}
