# Formiga 🐜

<p align="center"><img src="www/assets/formiga.png" alt="Formiga logo" width="180"></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg" alt="Node.js >= 22">
</p>

**AutoResearch for Data Science Teams** — A multi-agent system that automates the ML experimentation cycle: EDA, feature engineering, model training, hyperparameter tuning, and final reporting.

---

## Why Formiga?

Data scientists spend up to 80% of their time on repetitive tasks: exploring data, engineering features, tuning hyperparameters, and comparing models.

**Formiga** automates this end-to-end. It spawns a team of autonomous AI agents that work like a collaborative data science squad — exploring, experimenting, competing in a structured Arena, and delivering production-ready models.

**Key Features:**
- **Parallel Experimentation:** Classic ML and Deep Learning agents compete simultaneously.
- **Iterative Improvement (Arena):** The modeling loop runs for multiple rounds, adapting based on prior rounds' learnings.
- **Competitive Arena:** Modelers compete across multiple rounds. An 8-gate pre-write audit system (overfit, significance, dedup, calibration, budget) ensures only statistically sound improvements survive. Tier-specific Nadeau-Bengio corrected t-test thresholds adapt significance criteria to dataset size (TINY → LARGE).
- **Live Dashboard:** Watch the execution DAG, engineered features, and leaderboard rankings in real-time.

---

## Quick Start

### 1. Install (one line)

Install Formiga directly from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/PJarbas/formiga/main/scripts/install.sh | bash
```

The installer clones the repository into `~/.formiga/repo`, builds it, links the `formiga` CLI into `~/.local/bin`, and installs the bundled workflows. If `~/.local/bin` is missing from your PATH, it adds it to your shell configuration (`~/.zshrc`, `~/.bashrc`, or `~/.profile`) automatically.

**Or let an AI agent do it** — Formiga ships a Claude Code Skill that teaches agents how to drive it:

> "Clone github.com/PJarbas/formiga to my home dir, install it and learn the skill included inside it."

### 2. Prerequisites

* **Node.js 22+** (check with `node -v`)
* **Coding-Agent Harness:** Formiga leverages an agent harness to run code. Install one of the supported harnesses:
  * **pi-coding-agent** (Highly Recommended) — Follow the installation steps on [pi](https://github.com/mariozechner/pi-coding-agent)
  * **hermes** — Excellent alternative for computer-use integrations: [hermes](https://github.com/nousresearch/hermes-agent)

### 3. Manual Install (from source)

Clone the repository and run the build-and-install script:

```bash
git clone https://github.com/PJarbas/formiga.git
cd formiga
./build-and-install
```

### 4. Run Your First AutoResearch

Run your first automated research competition by providing a dataset and a target column:

```bash
# Start the competitive ML arena
formiga autoresearch "dataset_path=data/classification.csv target_column=species"

# In another terminal window, launch the interactive dashboard
formiga dashboard start
```

Navigate to [http://localhost:3334](http://localhost:3334) to watch the agents execute in real-time.

---

## How It Works

Formiga structures agent execution in a 4-stage pipeline with a competitive Arena loop at its core:

```
[ Data Analyst ]         Exploratory Data Analysis, data quality, recommendations
       │
       ▼
[ Feature Engineer ]     Feature transformations, train/test split, baseline model,
       │                 benchmark scripts, canonical cross-validation setup
       ▼
[ ⚔️  Arena  ]            Competitive loop — modelers compete across rounds
  ┌────┴────┐            Pre-write audit gates (G1–G8) validate every experiment
  ▼         ▼            Tier-specific Nadeau-Bengio significance thresholds
  Classic   Advanced     Converges when no improvement or max rounds reached
  (+ Creative if MEDIUM+)
       │
       ▼
[ Arena Reporter ]       Consolidates leaderboard, crowns the winner, writes final report
```

### The Pipeline Stages

1. **Data Analyst:**
   * **What it does:** Performs autonomous Exploratory Data Analysis (EDA).
   * **How it works:** Reads the training dataset, detects data quality issues (missing values, duplicates, outliers), calculates correlations, infers the problem type (classification or regression), and generates actionable feature engineering recommendations.

2. **Feature Engineer:**
   * **What it does:** Implements the EDA recommendations into executable Python code.
   * **How it works:** Applies feature transformations (polynomial features, ratio creation, target encoding), sets up the cross-validation strategy (e.g., *Stratified K-Fold* for classification), trains a simple **baseline model** (like Logistic or Linear Regression) to establish the benchmark score, and produces the benchmark runner scripts consumed by the Arena.

### The Arena Competitors

The Arena step runs a competitive loop where modelers submit experiments each round. Every experiment passes through **8 pre-write audit gates** before being accepted into the leaderboard:

| Gate | Name | What it checks |
|------|------|----------------|
| G1 | Overfit | Relative train/val gap within tier-specific threshold (200% TINY → 20% MEDIUM+) |
| G2 | Stale | Dataset content hash matches session (intra-run consistency) |
| G3 | Folds | Cross-validation fold scores present (≥2 folds for Nadeau-Bengio) |
| G4 | Calibration | OOF probabilities not saturated (<50 unique probs) or suspiciously perfect ECE |
| G5 | Too Good | Warning: univariate AUC ≥ 0.99 (likely target leakage) |
| G6 | Budget | Team iteration cap not exceeded (default: 5 experiments per team) |
| G7 | Dedup | Experiment signature not already in the ledger |
| G8 | Significance | Nadeau-Bengio corrected t-test: `p < threshold` AND `Δ ≥ minimum effect` — tiers: TINY `p<0.20,Δ≥0.1pp`, SMALL `p<0.10,Δ≥0.3pp`, MEDIUM+ `p<0.05,Δ≥0.5pp` |

3. **Arena Modeler Classic:**
   * **What it does:** Competes with gradient boosting and traditional ML algorithms.
   * **How it works:** Primary toolkit is XGBoost, LightGBM, and CatBoost, backed by Random Forest, SVM, linear models (Ridge/Lasso/ElasticNet), KNN, and L1 stacking. Applies complexity-aware tier selection: TINY → Ridge/Lasso, SMALL → LightGBM with heavy regularization, MEDIUM+ → full toolkit. Explicitly does **not** use neural networks — that is the Advanced modeler's territory.

4. **Arena Modeler Advanced:**
   * **What it does:** Competes with neural networks and AutoML frameworks.
   * **How it works:** Uses MLP, TabNet, FT-Transformer, TabPFN, SAINT, KAN, AutoGluon, FLAML, H2O AutoML, multi-level stacking, and entity embeddings. Tier selection: TINY → TabPFN/KAN/light AutoML, SMALL → TabPFN/light MLP, MEDIUM+ → full neural toolkit + deep stacking. Explicitly does **not** tune standard GBM — that is the Classic modeler's territory.

5. **Arena Modeler Creative:**
   * **What it does:** Produces **decorrelated** models that the other teams would not, so the final ensemble dominates.
   * **How it works:** Success metric is diversity (target Spearman OOF correlation < 0.85 vs top-1), not just AUC. Explores Denoising Autoencoders, aggressive mRMR, target permutation, monotonic constraints, Bayesian/Dirichlet blending, and SHAP-interaction materialization. **Only activated on MEDIUM/LARGE datasets** — the engine automatically filters it out on TINY/SMALL.

6. **Arena Reporter:**
   * **What it does:** Consolidates all modeling history from the competition.
   * **How it works:** Compiles results across all rounds, identifies the winning model and algorithm, outlines the performance improvements over the baseline, and writes a comprehensive executive summary detailing what worked and what failed.

---

## Dashboard Walkthrough

Formiga's interactive dashboard allows you to monitor and audit agent activity and experimental results in real-time.

### 1. Pipeline Flow
A live graphical representation of agent execution. Clicking on any agent node reveals its insights, generated code, and diagnostic logs in the side panel.

* **Exploratory Data Analysis (EDA) Phase:**
  <p align="center"><img src="docs/screenshots/eda.png" alt="Pipeline Flow - Data Analyst Panel" width="820"></p>
  - The Data Analyst's side panel lists data dimensions, quality flags (missing/duplicate rows), feature importances against the target, and recommendations.

### 2. Leaderboard
Centralizes and ranks every model produced during the Arena rounds.

* **Task-Adaptive Metrics:** The leaderboard table layout dynamically shifts depending on the problem type.
  * **Classification:** Displays cross-validation accuracy (`Accuracy CV`), F1-Score, Precision, Recall, and ROC-AUC.
  * **Regression:** Displays CV error, RMSE, MAE, and R²-Score.
* **Actual Algorithm Classes:** The panel displays the real trained Python class names (e.g., `LogisticRegression (Poly)` or `SVC (RBF)`) along with standard deviations to help you select the most robust model.

### 3. Winner Consolidation
Once the Arena converges or reaches the round limit, the winning model is crowned and the final report is compiled.

<p align="center"><img src="docs/screenshots/image_6.png" alt="Arena Reporter Consolidation" width="820"></p>

---

## Commands

```bash
# Execute workflows
formiga autoresearch "dataset_path=... target_column=..."
formiga workflow run ml-pipeline "..."

# Run Management
formiga workflow runs              # List all runs and statuses
formiga workflow status <id>       # View live status of a run
formiga workflow pause <id>        # Pause scheduling for an active run
formiga workflow resume <id>       # Resume a paused run
formiga workflow delete <id>       # Permanently delete a run and its records

# Dashboard
formiga dashboard start            # Start the dashboard UI on port 3334
formiga dashboard stop             # Stop the dashboard server

# Monitoring & Logs
formiga logs                       # View recent global daemon logs
formiga logs-tail                  # Stream live daemon logs
formiga status                     # Perform a daemon health check

# Maintenance
formiga get-ready                  # Install default workflows and prepare directories
formiga update                     # Pull latest commits, rebuild, and restart services
```

---

## Integrating with AI Agents (Claude Code Skill)

Formiga exposes a dedicated **Claude Code Skill** allowing other AI agents to execute and manage Machine Learning experiments programmatically.

### Install the Skill

Copy the skill directory to your local Claude Code skills path:

```bash
cp -r /path/to/formiga/skills/formiga-agents ~/.claude/skills/
```

### Example: Agent-Driven Research

You can prompt Claude Code (or any agent equipped with this skill) to run an ML experiment:

```text
You have access to Formiga, a multi-agent ML platform.

Run AutoResearch on the dataset at data/classification.csv to predict "species":

formiga autoresearch "dataset_path=data/classification.csv target_column=species max_rounds=5"

Monitor the pipeline progress. Once done, inspect the best model on the leaderboard and summarize which features and algorithms yielded the highest validation score.
```

### Core Commands for Agents

```bash
# Start competitive ML Arena (runs ml-autoresearch workflow)
formiga autoresearch "dataset_path=path/to/data.csv target_column=target"

# Start with detailed constraints
formiga autoresearch "dataset_path=data.csv target_column=price max_rounds=8 metric=rmse direction=lower"

# Monitor progress
formiga workflow runs
formiga logs-tail
```

See [skills/formiga-agents/SKILL.md](skills/formiga-agents/SKILL.md) for the full agent API and parameters.

---

## Architecture

Formiga is designed to be highly lightweight, asynchronous, and resilient:

```
CLI (Commands) ──┐
                 ▼
          SQLite Database (stored at ~/.formiga/formiga.db)
                 ▲
                 ├─ Dashboard Daemon (API :3334 + Control Plane :3339 + Reconciler + Cron)
                 │     │
                 │     ▼
                 │   Agent Harness (pi or hermes)
                 │     │
                 │     ▼
                 │   AI Agents (Data Analyst, Feature Engineer, Arena Modelers, Reporter)
                 ▲     │
                 │     ▼
Dashboard API (:3334) ◄─ Publishes rich metrics and artifacts
```

For details regarding the orchestrator and daemon schemas, refer to [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Development

To build and run tests locally:

```bash
./build              # Compiles TypeScript and restarts background services
npm test             # Runs test suite
```

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
