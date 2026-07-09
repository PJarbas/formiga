# Plano: Comunicação entre Agentes via Banco de Dados

## Contexto Atual

Os agentes do ml-pipeline comunicam via **arquivos no filesystem**:

```
data-analyst → reports/01_eda.md, artifacts/eda_config.json
     ↓
feature-engineer → reports/02_features.md, artifacts/features.parquet, split.pkl, baseline.json
     ↓
modeler-classic/advanced → artifacts/*_submission.json, reports/03_classic.md
     ↓
ml-critic → reports/05_audit.md (lê leaderboard via API)
```

### Problemas:
1. **Arquivos não estruturados** - Reports em Markdown são difíceis de parsear
2. **Sem versionamento** - Sobrescrever um arquivo perde histórico
3. **Sem validação** - Qualquer formato é aceito
4. **Difícil de visualizar** - Dashboard não consegue mostrar conteúdo estruturado

## Arquitetura Proposta

### 1. Nova Tabela: `agent_artifacts` (já criada)

```prisma
model AgentArtifact {
  id            Int       @id @default(autoincrement())
  run_id        String
  step_id       String
  agent_id      String
  artifact_key  String    // "eda_report", "eda_config", "features_metadata", etc.
  artifact_path String?   // Caminho opcional para arquivo grande (parquet, pkl)
  content       String    // JSON estruturado
  content_type  String    @default("json")
  size_bytes    Int?
  checksum      String?
  created_at    DateTime  @default(now())
  updated_at    DateTime  @updatedAt
  
  @@unique([run_id, artifact_key])
}
```

### 2. Artifact Keys Padronizados

| Agent | Artifact Key | Content Type | Descrição |
|-------|-------------|--------------|-----------|
| data-analyst | `eda_report` | json | Report estruturado com seções |
| data-analyst | `eda_config` | json | Configurações para downstream |
| feature-engineer | `features_metadata` | json | Shape, columns, types |
| feature-engineer | `split_config` | json | Seed, strategy, indices |
| feature-engineer | `baseline_submission` | json | CV_MEAN, MODEL_TYPE, etc. |
| modeler-* | `*_submission` | json | Submissão para leaderboard |
| modeler-* | `*_report` | json | Report estruturado |
| ml-critic | `audit_report` | json | Resultados dos 8 checks |

### 3. API para Artifacts

```
GET  /api/runs/:runId/agent-artifacts
GET  /api/runs/:runId/agent-artifacts/:key
POST /api/runs/:runId/agent-artifacts/:key  (upsert)
```

**Já implementado em `src/server/routes/agent-activity.ts`**

### 4. Skill Formiga para Agentes

Criar uma skill que os agentes usam para ler/escrever artifacts:

```python
# skill: formiga-artifacts

def read_artifact(run_id: str, key: str) -> dict:
    """Lê um artifact do banco de dados."""
    resp = requests.get(f"http://localhost:3334/api/runs/{run_id}/agent-artifacts/{key}")
    return resp.json()["content"]

def write_artifact(run_id: str, key: str, content: dict, path: str = None) -> bool:
    """Escreve um artifact no banco de dados."""
    requests.post(f"http://localhost:3334/api/runs/{run_id}/agent-artifacts/{key}", 
                  json={"content": content, "artifact_path": path})
    return True
```

### 5. Modificações nos Prompts dos Agentes

#### Data Analyst

**Antes:**
```markdown
Produce the EDA report at {{workspace}}/reports/01_eda.md and a machine-readable
config at {{workspace}}/artifacts/eda_config.json.
```

**Depois:**
```markdown
Produce the EDA report as structured JSON and save it using:

```bash
curl -X POST "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/eda_report" \
  -H "Content-Type: application/json" \
  -d '{
    "content": {
      "dataset_overview": { ... },
      "data_quality": { ... },
      "univariate_analysis": { ... },
      "target_analysis": { ... },
      "bivariate_vs_target": { ... },
      "leakage_alerts": [ ... ],
      "feature_engineering_hypotheses": [ ... ],
      "preprocessing_recommendations": { ... }
    }
  }'
```

Also save the config for the Feature Engineer:

```bash
curl -X POST "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/eda_config" \
  -H "Content-Type: application/json" \
  -d '{"content": {"imputation": {...}, "encoding": {...}, "scaling": {...}}}'
```
```

#### Feature Engineer

**Antes:**
```markdown
Read the EDA report at {{report_path}} and the EDA config at
{{workspace}}/artifacts/eda_config.json.
```

**Depois:**
```markdown
Read the EDA artifacts from the database:

```bash
# Get EDA report
curl -s "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/eda_report" | jq '.content'

# Get EDA config
curl -s "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/eda_config" | jq '.content'
```

Save your artifacts to the database:

```bash
# Save features metadata
curl -X POST "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/features_metadata" \
  -H "Content-Type: application/json" \
  -d '{"content": {"shape": [10000, 50], "columns": [...], "dtypes": {...}}}'

# Save baseline submission
curl -X POST "http://localhost:3334/api/runs/{{run_id}}/agent-artifacts/baseline_submission" \
  -H "Content-Type: application/json" \
  -d '{"content": {"MODEL_TYPE": "baseline-ridge", "CV_MEAN": 0.7234, ...}}'
```
```

### 6. Schema JSON para Artifacts

Definir schemas validados para cada artifact:

```typescript
// src/shared/artifact-schemas.ts

export const EDA_REPORT_SCHEMA = {
  type: "object",
  required: ["dataset_overview", "data_quality", "target_analysis"],
  properties: {
    dataset_overview: {
      type: "object",
      properties: {
        shape: { type: "array", items: { type: "number" } },
        dtypes: { type: "object" },
        target_type: { enum: ["classification", "regression"] },
        class_balance: { type: "object" },
        memory_mb: { type: "number" }
      }
    },
    data_quality: {
      type: "object",
      properties: {
        missing_pct: { type: "object" },
        duplicate_rows: { type: "number" },
        constant_columns: { type: "array" },
        high_cardinality: { type: "array" }
      }
    },
    // ...
  }
};

export const SUBMISSION_SCHEMA = {
  type: "object",
  required: ["MODEL_TYPE", "CV_MEAN", "TRAIN_MEAN", "ARTIFACT_PATH"],
  properties: {
    MODEL_TYPE: { type: "string" },
    CV_MEAN: { type: "number" },
    CV_STD: { type: "number" },
    TRAIN_MEAN: { type: "number" },
    HYPERPARAMETERS: { type: "object" },
    ARTIFACT_PATH: { type: "string" },
    METRIC_NAME: { type: "string" }
  }
};
```

### 7. Benefícios

1. **Visualização no Dashboard** - Artifacts aparecem no AgentDetailPanel
2. **Histórico** - Cada update cria versão com timestamp
3. **Validação** - Schema garante formato correto
4. **Inter-agent** - Agentes leem do banco, não do filesystem
5. **Debug** - Fácil inspecionar o que cada agente produziu
6. **Replay** - Pode re-executar um agente com os mesmos inputs

### 8. Migração Gradual

**Fase 1 (Atual):** Activity events (tool calls) no banco ✅
**Fase 2:** Artifacts estruturados no banco (este plano)
**Fase 3:** Remover dependência de arquivos para comunicação inter-agente

### 9. Implementação

#### Tarefas:

1. [ ] Criar schemas JSON para cada artifact type
2. [ ] Atualizar AGENTS.md do data-analyst com instruções de API
3. [ ] Atualizar AGENTS.md do feature-engineer
4. [ ] Atualizar AGENTS.md dos modelers
5. [ ] Atualizar AGENTS.md do ml-critic
6. [ ] Atualizar workflow.yml com novos inputs
7. [ ] Criar componente ArtifactViewer no dashboard
8. [ ] Adicionar validação de schema no POST de artifacts

#### Estimativa: ~8h de trabalho

### 10. Backwards Compatibility

Durante a migração, os agentes podem:
1. Escrever em **ambos** (arquivo + banco)
2. Ler preferencialmente do banco, fallback para arquivo

Isso permite testar gradualmente sem quebrar pipelines existentes.
