📊 Plano Ampliado — com Visualização de Figuras
Estado atual das figuras (auditoria real)
Analisei runs antigos e descobri:

✅ Os agentes já geram PNGs (matplotlib) — comportamento emergente, sem estar nos AGENTS.md
❌ Sem padronização — cada run usa um caminho diferente: figures/, reports/, reports/figures/
❌ Sem nomenclatura consistente — corr_heatmap.png, fig_02_correlation.png, correlation_matrix.png
❌ Sem metadata — não há título, descrição, seção que a figura ilustra
✅ Handler HTTP quase pronto — handleRunArtifact em dashboard.ts:1809 serve arquivos do workspace, com validação de path traversal. Só falta:
Adicionar .png/.jpg/.svg/.webp como MIME inline (não attachment)
Criar endpoint que lista as figuras de um agente/run
Estratégia arquitetural (AI eng)
Duas opções para expor figuras — vou combinar as duas:

Opção A: Padronizar via extension (fonte da verdade)
Adicionar nova tool save_figure(path, title, section?) na extension formiga-agent-tools. Ela registra o caminho no banco (agent_figures table nova, ou como artefato tipo figure_manifest) com metadata.

Prós: metadata rica (título, seção), consistência total, permite testes.
Contras: exige mudança na extension + AGENTS.md + rebuild.


Alterações finais (plano completo)
🔧 Backend
1. Ampliar handleRunArtifact (dashboard.ts:1809)


// Adicionar suporte inline a imagens:
const IMAGE_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
// Sem Content-Disposition = renderiza inline no <img src>
2. Novo endpoint GET /api/runs/:id/agents/:name/figures

Faz glob recursivo no workspace do run
Filtra **/*.{png,jpg,jpeg,svg,webp}
Retorna: { figures: [{ title, url, path, section? }] }
Inferência de metadata via convenção:
figures/correlation_heatmap.png → title="Correlation Heatmap", section="bivariate"
reports/fig_02_correlation.png → title="Correlation" (strip prefix)
3. Fix log_decision append-only (já no plano anterior)

4. Novos endpoints (já no plano anterior)

GET /api/runs/:id/agents/:name/decisions
GET /api/runs/:id/agents/:name/metrics
GET /api/runs/:id/agents/:name/legacy-files
🎨 Frontend
5. AgentSidePanel.tsx

Reduzir tabs: ["insights", "reports"]
Remover ActivityContent e HistoryContent
6. DataAnalystInsights.tsx — nova seção Figures


{figures.length > 0 && (
  <Section title="Visualizations" icon="📈" badge={figures.length}>
    <FigureGallery figures={figures} />
  </Section>
)}
7. Novo componente FigureGallery.tsx

Grid 2×N de thumbnails (max-height 120px)
Click → modal fullscreen com zoom
Título abaixo do thumbnail
Suporte a agrupamento por section
8. FeatureEngineerInsights.tsx — mesma seção Figures (mostrar plots que o FE gerar)

9. Novo ReportsView.tsx (substitui a aba Reports atual)
Seções colapsáveis:

📁 Artifacts (JSON viewer — já existe)
📈 Figures (galeria completa)
🧭 Decisions (timeline append-only)
📊 Metrics (lista de métricas com sparkline se houver histórico)
📜 Legacy Files (.md, .json do disco)
📝 Agentes (AGENTS.md)
10. Data Analyst — adicionar seção CRITICAL: Figures:


## Figures Obrigatórias

Salve estas figuras em `{{workspace}}/figures/` (crie o diretório se não existir):

1. `figures/target_distribution.png` — histograma + KDE do target
2. `figures/correlation_heatmap.png` — heatmap de correlações (numéricas)
3. `figures/feature_distributions.png` — grid de histogramas por feature numérica
4. `figures/scatter_vs_target.png` — scatter de top-3 features vs target
5. `figures/missing_pattern.png` — apenas se houver missing (matriz de missing)
6. `figures/outliers_boxplot.png` — apenas se houver outliers

Cada figura DEVE:
- Ter título descritivo (plt.title)
- Ter labels nos eixos
- Salvar com `dpi=100, bbox_inches='tight'`
- Fechar a figura após salvar (plt.close())

Não use plt.show() — você está em modo headless.
11. Feature Engineer — figuras similares:

figures/feature_importance_baseline.png
figures/baseline_residuals.png
figures/split_distribution.png (train/val/test balance)
🔒 Segurança
Path traversal já bloqueado pelo isPathSafe existente
Serving inline sem Content-Disposition → sem risco de execução
MIME types explícitos (não confiar em extensão só)
Rate limiting não é problema — servidor local
📊 Métricas de sucesso
Após implementação, verifico via Playwright:

Data Analyst tab Insights → seção "Visualizations" mostra 4+ figuras
Click abre modal com imagem em alta resolução
Reports tab mostra galeria completa + Decisions timeline + Metrics
Zero placeholders "no data yet" para runs completos
Ordem de execução (revisada)
Backend: fix log_decision append-only, ampliar handleRunArtifact (imagens inline), criar 4 endpoints novos (figures, decisions, metrics, legacy-files)
Frontend: reduzir tabs (insights/reports), criar FigureGallery, criar ReportsView
Componentes Insights: adicionar seção Figures em Data Analyst + Feature Engineer
AGENTS.md: instrução explícita para figuras obrigatórias
Testes E2E: reinstalar workflows, rodar ml-autoresearch, capturar screenshots do painel populado com figuras
PR só após validação visual completa
Você aprova? Alguma coisa a ajustar antes de eu começar a implementar?