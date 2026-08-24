// ══════════════════════════════════════════════════════════════════════
// repro-zip.ts — stream a downloadable ZIP bundling a leaderboard entry's
// trained model artifact (.pkl) with its reproduction script and results.
//
// The zip is assembled on demand from the run's workspace (no agent
// involvement, works retroactively for every run) and streamed so large
// pickles never sit fully in memory. All entries use relative, sanitized
// names under a per-experiment base dir — never host-absolute paths — so
// extraction on the client cannot escape the target folder (zip-slip).
// ══════════════════════════════════════════════════════════════════════

import { ZipFile } from "yazl";

/** A file bundled from disk. */
export interface ReproZipFileEntry {
  /** Relative path inside the zip (forward slashes, no leading slash). */
  zipPath: string;
  /** Absolute path of the source file on disk. */
  sourcePath: string;
}

/** A file whose content is generated at build time (README). */
export interface ReproZipBufferEntry {
  zipPath: string;
  content: string;
}

export interface ReproZipInput {
  /** Zip-internal root folder, e.g. `repro-{slug}-{experimentId}`. */
  baseDir: string;
  /** Trained model artifact (.pkl) — included only when present on disk. */
  model: ReproZipFileEntry | null;
  /** Reproduction script content — always included. */
  script: ReproZipBufferEntry;
  /** Agent `_results.json` — included only when present on disk. */
  results: ReproZipFileEntry | null;
  /** Generated manifest (README.md) — always included. */
  readme: ReproZipBufferEntry;
}

export interface ReproManifestInput {
  experimentId: number;
  agentName: string | null;
  modelType: string;
  roundNumber: number | null;
  metricName: string | null;
  cvMean: number;
  trainMean: number;
  artifactPath: string | null;
  modelIncluded: boolean;
  resultsIncluded: boolean;
  scriptFilename: string;
}

/** Build the README.md that ships inside the zip. */
export function buildReproManifest(input: ReproManifestInput): string {
  const lines = [
    `# Reprodução — ${input.modelType} (Experiment #${input.experimentId})`,
    "",
    `- **Agente:** ${input.agentName ?? "desconhecido"}`,
    input.roundNumber != null ? `- **Rodada:** ${input.roundNumber}` : "",
    input.metricName != null ? `- **Métrica:** ${input.metricName}` : "",
    `- **CV Mean:** ${input.cvMean.toFixed(6)}`,
    `- **Train Mean:** ${input.trainMean.toFixed(6)}`,
    "",
    "## Conteúdo",
    `- \`${input.scriptFilename}\` — script de reprodução (carrega o modelo ou treina do zero)`,
    input.modelIncluded
      ? `- \`model.pkl\` — modelo treinado (${input.artifactPath ?? "artefato"})`
      : `- modelo treinado **não incluído**: ${input.artifactPath ?? "artefato"} não encontrado em disco — o script retreina do zero`,
    input.resultsIncluded ? "- `results.json` — métricas ricas de validação cruzada" : "",
    "",
    "## Como usar",
    "1. Descompacte e rode: `python reproduce.py` (o script localiza o workspace por `benchmark_config.json`, ou use `FORMIGA_WORKSPACE`).",
    "2. Com `model.pkl` presente o modelo é carregado; caso contrário, é retreinado com os hiperparâmetros registrados.",
    "",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

/**
 * Stream a zip of the given entries into `dest`. File entries stream straight
 * from disk (never fully buffered); buffer entries are inlined. Resolves when
 * the zip has been fully written; rejects on any source/dest error.
 */
export async function buildReproZip(
  input: ReproZipInput,
  dest: NodeJS.WritableStream,
): Promise<void> {
  const zip = new ZipFile();
  zip.outputStream.pipe(dest);

  const fileEntries: ReproZipFileEntry[] = [];
  if (input.model) fileEntries.push(input.model);
  if (input.results) fileEntries.push(input.results);
  const bufferEntries: ReproZipBufferEntry[] = [input.script, input.readme];

  for (const entry of fileEntries) {
    zip.addFile(entry.sourcePath, entry.zipPath);
  }
  for (const entry of bufferEntries) {
    zip.addBuffer(Buffer.from(entry.content, "utf-8"), entry.zipPath);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      // Stop feeding the destination once a source file fails (e.g. it was
      // removed between the existence check and the read). Without an 'error'
      // listener yazl would crash the process with an uncaught exception.
      zip.outputStream.unpipe(dest);
      reject(err);
    };
    zip.once("error", onError);
    zip.outputStream.once("error", onError);
    zip.outputStream.once("end", () => {
      zip.removeListener("error", onError);
      zip.outputStream.removeListener("error", onError);
      resolve();
    });
    zip.end();
  });
}
