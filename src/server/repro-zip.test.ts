// ══════════════════════════════════════════════════════════════════════
// repro-zip.test.ts — tests for the on-demand reproduction ZIP builder.
// Uses yauzl (read side of yazl) to open the produced zip and assert on
// actual entries/content, not just bytes.
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { Writable } from "node:stream";
import * as yauzl from "yauzl";
import {
  buildReproZip,
  buildReproManifest,
  type ReproZipInput,
} from "./repro-zip.js";

/** Collect the zip bytes written by buildReproZip into a single Buffer. */
async function buildZipToBuffer(input: ReproZipInput): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const done = new Promise<void>((resolve, reject) => {
    sink.on("finish", resolve);
    sink.on("error", reject);
  });
  await buildReproZip(input, sink);
  sink.end();
  await done;
  return Buffer.concat(chunks);
}

/** Read every entry of a zip buffer as { name, content }. */
async function readZipEntries(buf: Buffer): Promise<Array<{ name: string; content: Buffer }>> {
  const out: Array<{ name: string; content: Buffer }> = [];
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) =>
      err ? reject(err) : resolve(zip),
    );
  });
  zip.on("entry", (entry: yauzl.Entry) => {
    if (/\/$/.test(entry.fileName)) return;
    zip.openReadStream(entry, (err, rs) => {
      if (err) throw err;
      const chunks: Buffer[] = [];
      rs.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
      rs.on("end", () => {
        out.push({ name: entry.fileName, content: Buffer.concat(chunks) });
        zip.readEntry();
      });
    });
  });
  const finished = once(zip, "end").then(() => out);
  zip.readEntry();
  return finished;
}

describe("buildReproManifest", () => {
  it("flags the model as included when present", () => {
    const md = buildReproManifest({
      experimentId: 42,
      agentName: "modeler-classic",
      modelType: "LightGBM",
      roundNumber: 1,
      metricName: "f1",
      cvMean: 0.82,
      trainMean: 0.85,
      artifactPath: "artifacts/models/modeler-classic_round1.pkl",
      modelIncluded: true,
      resultsIncluded: true,
      scriptFilename: "reproduce_modeler_classic_42.py",
    });
    assert.ok(md.includes("Experiment #42"));
    assert.ok(md.includes("`model.pkl` — modelo treinado"));
    assert.ok(md.includes("`results.json` — métricas ricas"));
  });

  it("explains the missing model fallback instead of pretending", () => {
    const md = buildReproManifest({
      experimentId: 7,
      agentName: null,
      modelType: "XGBoost",
      roundNumber: null,
      metricName: null,
      cvMean: 0.9,
      trainMean: 0.95,
      artifactPath: "artifacts/models/x.pkl",
      modelIncluded: false,
      resultsIncluded: false,
      scriptFilename: "reproduce_x_7.py",
    });
    assert.ok(md.includes("não incluído"));
    assert.ok(md.includes("retreina do zero"));
    assert.ok(!md.includes("`model.pkl` — modelo treinado"));
  });
});

describe("buildReproZip", () => {
  it("bundles model + script + results + README under the base dir", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repro-zip-"));
    try {
      const modelPath = path.join(tmp, "model.pkl");
      const resultsPath = path.join(tmp, "results.json");
      fs.writeFileSync(modelPath, Buffer.from([0x80, 0x7f, 0x01, 0x02])); // binary-ish pickle bytes
      fs.writeFileSync(resultsPath, JSON.stringify({ f1_score: 0.82 }));

      const buf = await buildZipToBuffer({
        baseDir: "repro-modeler_classic-42",
        model: { zipPath: "repro-modeler_classic-42/model.pkl", sourcePath: modelPath },
        script: { zipPath: "repro-modeler_classic-42/reproduce.py", content: 'print("hello")' },
        results: { zipPath: "repro-modeler_classic-42/results.json", sourcePath: resultsPath },
        readme: { zipPath: "repro-modeler_classic-42/README.md", content: "# README" },
      });

      const entries = await readZipEntries(buf);
      const byName = new Map(entries.map((e) => [e.name, e.content]));
      assert.deepEqual(
        [...byName.keys()].sort(),
        [
          "repro-modeler_classic-42/README.md",
          "repro-modeler_classic-42/model.pkl",
          "repro-modeler_classic-42/reproduce.py",
          "repro-modeler_classic-42/results.json",
        ].sort(),
      );
      // binary pickle bytes must round-trip untouched
      assert.deepEqual(byName.get("repro-modeler_classic-42/model.pkl"), Buffer.from([0x80, 0x7f, 0x01, 0x02]));
      assert.equal(byName.get("repro-modeler_classic-42/reproduce.py").toString("utf-8"), 'print("hello")');
      assert.equal(byName.get("repro-modeler_classic-42/results.json").toString("utf-8"), JSON.stringify({ f1_score: 0.82 }));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips null model/results entries", async () => {
    const buf = await buildZipToBuffer({
      baseDir: "repro-x-1",
      model: null,
      script: { zipPath: "repro-x-1/reproduce.py", content: "print(1)" },
      results: null,
      readme: { zipPath: "repro-x-1/README.md", content: "# R" },
    });
    const entries = await readZipEntries(buf);
    assert.deepEqual(
      entries.map((e) => e.name).sort(),
      ["repro-x-1/README.md", "repro-x-1/reproduce.py"].sort(),
    );
  });

  it("rejects when a bundled source file does not exist", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repro-zip-"));
    try {
      await assert.rejects(
        buildZipToBuffer({
          baseDir: "repro-x-1",
          model: { zipPath: "repro-x-1/model.pkl", sourcePath: path.join(tmp, "missing.pkl") },
          script: { zipPath: "repro-x-1/reproduce.py", content: "print(1)" },
          results: null,
          readme: { zipPath: "repro-x-1/README.md", content: "# R" },
        }),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
