// ══════════════════════════════════════════════════════════════════════
// http-client.test.mjs — Unit tests for HTTP client
// ══════════════════════════════════════════════════════════════════════

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  readContext,
  saveArtifact,
  queryLeaderboard,
} from "../extensions/formiga-agent-tools/http-client.ts";

// ── readContext ──────────────────────────────────────────────────────

describe("readContext", () => {
  test("returns env vars when present", () => {
    const ctx = readContext({
      FORMIGA_API_URL: "http://test:1234",
      FORMIGA_RUN_ID: "run-abc",
      FORMIGA_STEP_ID: "step-x",
      FORMIGA_AGENT_ID: "agent-1",
    });
    assert.equal(ctx.apiUrl, "http://test:1234");
    assert.equal(ctx.runId, "run-abc");
    assert.equal(ctx.stepId, "step-x");
    assert.equal(ctx.agentId, "agent-1");
  });

  test("falls back to defaults when env is empty", () => {
    const ctx = readContext({});
    assert.equal(ctx.apiUrl, "http://localhost:3737");
    assert.equal(ctx.runId, "unknown");
    assert.equal(ctx.stepId, "unknown");
    assert.equal(ctx.agentId, "unknown");
  });
});

// ── saveArtifact ─────────────────────────────────────────────────────

describe("saveArtifact", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("POSTs to the correct URL with correct body", async () => {
    let capturedUrl;
    let capturedInit;
    globalThis.fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: 42, artifactKey: "eda_report" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const ctx = {
      apiUrl: "http://test:1234",
      runId: "run-1",
      stepId: "step-1",
      agentId: "agent-1",
    };

    const result = await saveArtifact(ctx, "eda_report", { hello: "world" });

    assert.equal(
      capturedUrl,
      "http://test:1234/api/runs/run-1/agent-artifacts/eda_report",
    );
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers["Content-Type"], "application/json");
    const body = JSON.parse(capturedInit.body);
    assert.equal(body.stepId, "step-1");
    assert.equal(body.agentId, "agent-1");
    assert.deepEqual(body.content, { hello: "world" });

    assert.equal(result.id, 42);
    assert.equal(result.artifactKey, "eda_report");
  });

  test("URL-encodes runId and artifactKey", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ id: 1, artifactKey: "x" }), { status: 200 });
    };

    await saveArtifact(
      { apiUrl: "http://x", runId: "run/with/slash", stepId: "s", agentId: "a" },
      "with space",
      {},
    );

    assert.match(capturedUrl, /run%2Fwith%2Fslash/);
    assert.match(capturedUrl, /with%20space/);
  });

  test("throws with status text on non-ok response", async () => {
    globalThis.fetch = async () =>
      new Response("Bad Request", { status: 400 });

    await assert.rejects(
      () => saveArtifact(
        { apiUrl: "http://x", runId: "r", stepId: "s", agentId: "a" },
        "key",
        {},
      ),
      /HTTP 400/,
    );
  });

  test("respects an AbortSignal supplied by caller", async () => {
    globalThis.fetch = async (_url, init) => {
      // Simulate a slow request that observes the abort.
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("The user aborted a request.", "AbortError")),
        );
      });
    };

    const controller = new AbortController();
    const promise = saveArtifact(
      { apiUrl: "http://x", runId: "r", stepId: "s", agentId: "a" },
      "k",
      {},
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    controller.abort();
    await assert.rejects(promise, /AbortError|aborted/);
  });
});

// ── queryLeaderboard ─────────────────────────────────────────────────

describe("queryLeaderboard", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("GETs the leaderboard URL and returns entries", async () => {
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          entries: [
            { modelType: "ridge", agentName: "baseline", cvMean: 1, trainMean: 1, roundNumber: 0 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const entries = await queryLeaderboard(
      { apiUrl: "http://x", runId: "r1", stepId: "s", agentId: "a" },
      5,
    );

    assert.match(capturedUrl, /^http:\/\/x\/api\/leaderboard\?/);
    assert.match(capturedUrl, /runId=r1/);
    assert.match(capturedUrl, /sortBy=cvMean/);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].modelType, "ridge");
  });

  test("truncates to the requested limit client-side", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          entries: new Array(10).fill(0).map((_, i) => ({
            modelType: `m${i}`,
            agentName: "a",
            cvMean: 1 - i * 0.01,
            trainMean: 1,
            roundNumber: i,
          })),
        }),
        { status: 200 },
      );

    const entries = await queryLeaderboard(
      { apiUrl: "http://x", runId: "r1", stepId: "s", agentId: "a" },
      3,
    );

    assert.equal(entries.length, 3);
    assert.equal(entries[0].modelType, "m0");
    assert.equal(entries[2].modelType, "m2");
  });

  test("accepts a plain array response shape", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify([
          { modelType: "xgb", agentName: "a", cvMean: 0.5, trainMean: 0.6, roundNumber: 1 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const entries = await queryLeaderboard(
      { apiUrl: "http://x", runId: "r1", stepId: "s", agentId: "a" },
      1,
    );

    assert.equal(entries.length, 1);
    assert.equal(entries[0].modelType, "xgb");
  });

  test("returns empty array when response has no entries", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({}), { status: 200 });

    const entries = await queryLeaderboard(
      { apiUrl: "http://x", runId: "r1", stepId: "s", agentId: "a" },
      5,
    );

    assert.deepEqual(entries, []);
  });
});
