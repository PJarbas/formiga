// ══════════════════════════════════════════════════════════════════════
// DataAnalystInsights.test.tsx — renders real eda_report artifact schema
// The component must handle the actual artifact the data-analyst persists:
// dataset_overview.class_counts (not class_balance), target_analysis with
// transform_suggestion/temporal_signal/imbalance_ratio (not distribution/
// suggested_transform). Regression for issue #132 (dead fields).
// ══════════════════════════════════════════════════════════════════════

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DataAnalystInsights } from "./DataAnalystInsights.js";

// Mirrors the real eda_report persisted by the arena for run 6757779f.
const REAL_EDA_REPORT: Parameters<typeof DataAnalystInsights>[0]["edaReport"] = {
  dataset_overview: {
    shape: [27525, 39],
    dtypes: { numeric: 31, categorical: 8 },
    target_type: "binary_classification",
    target_column: "opt_in",
    base_rate: 0.1145,
    class_counts: { "0": 24373, "1": 3152 },
    memory_mb: 8.2,
    id_column: "merchant_id",
  },
  data_quality: {
    missing_pct: { merchant_tier: 0.5435, gmv_total: 0.0779 },
    duplicate_rows: 0,
    constant_columns: [],
    high_cardinality: ["merchant_id (27525)", "city (596)"],
    sentinel_values: { gmv_total: [0], orders: [0] },
  },
  target_analysis: {
    base_rate: 0.1145,
    imbalance_ratio: "1:7.7 (positivos minoritarios) - usar AUC/PR-AUC, stratify",
    rate_by_dt: { "2026-07-22": 0.198, "2026-08-16": 0.012 },
    temporal_signal:
      "Taxa de opt-in varia 30x entre datas (0.402 em 07-29 vs 0.012 em 08-16): dt e o confundidor mais forte do dataset",
    transform_suggestion:
      "Nenhuma transformacao do target necessaria (binario). Considerar balanceamento/custo assimetrico para positivos.",
  },
  bivariate_vs_target: {
    top_20_features: [
      ["aging_food_delivery", -0.1553],
      ["merchant_subsidy_delivery", 0.1306],
    ],
  },
  leakage_alerts: [
    {
      column: "status_mtd/account_status",
      reason: "Estados de funil podem ser metadados pos-evento",
      severity: "medium",
    },
  ],
  feature_engineering_hypotheses: [
    "log1p em TODAS as features de volume/GMV/subsidio/orders (skew de +8 a +146)",
  ],
  preprocessing_recommendations: {
    imputation: { merchant_tier: "categoria DESCONHECIDO" },
    encoding: { merchant_tier: "ordinal [TIER 1, TIER 2, TIER 3]" },
    scaling: { "todas as numericas": "nenhum scaling necessario para GBDT" },
  },
};

function renderWithDefaults(overrides: Partial<Parameters<typeof DataAnalystInsights>[0]> = {}) {
  return render(
    <DataAnalystInsights
      edaReport={REAL_EDA_REPORT}
      edaConfig={null}
      hypothesis={null}
      figures={[]}
      decisions={[]}
      isLoading={false}
      {...overrides}
    />,
  );
}

describe("DataAnalystInsights", () => {
  it("renders class balance from dataset_overview.class_counts", () => {
    renderWithDefaults();
    expect(screen.getByText("Key Findings")).toBeTruthy();
    expect(screen.getByText("binary_classification")).toBeTruthy();
    expect(screen.getByText("opt_in")).toBeTruthy(); // dataset_overview.target_column
    // 3152 / 27525 = 11.5% of rows are positive.
    // Thousands separator is locale-dependent (3,152 vs 3.152) — assert on
    // the class label + the 11.5% positive share (3152 / 27525).
    expect(screen.getByText(/positive: .*\(11\.5%\)/)).toBeTruthy();
  });

  it("renders target_analysis.transform_suggestion and temporal_signal", () => {
    renderWithDefaults();
    expect(screen.getByText("Target Analysis")).toBeTruthy();
    expect(screen.getByText(/Nenhuma transformacao do target necessaria/)).toBeTruthy();
    expect(screen.getByText(/Taxa de opt-in varia 30x/)).toBeTruthy();
  });

  it("renders target_analysis base rate and imbalance ratio", () => {
    renderWithDefaults();
    expect(screen.getByText("11.45%")).toBeTruthy(); // base_rate 0.1145 * 100
    expect(screen.getByText(/1:7\.7/)).toBeTruthy();
  });

  it("renders top features and leakage alerts from the real schema", () => {
    renderWithDefaults();
    expect(screen.getByText("aging_food_delivery")).toBeTruthy(); // top_20_features
    expect(screen.getByText("status_mtd/account_status")).toBeTruthy(); // leakage column
  });

  it("shows an empty insight when no artifacts are present", () => {
    renderWithDefaults({ edaReport: null, edaConfig: null });
    expect(screen.getByText(/not available yet/i)).toBeTruthy();
  });
});
