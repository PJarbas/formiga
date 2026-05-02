import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MCP_PORT,
  createTamanduaMcpServer,
  startTamanduaMcpServer,
  stopTamanduaMcpServer,
  type TamanduaMcpServer,
} from "./mcp-server.js";

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

function initializeRequest(id: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "tamandua-test-client",
        version: "0.0.0",
      },
    },
  };
}

function parseJsonRpcBody(text: string): JsonRpcResponse | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as JsonRpcResponse;
  } catch {
    const sseDataLine = trimmed
      .split(/\r?\n/)
      .find((line) => line.startsWith("data:"));

    if (!sseDataLine) {
      throw new Error(`Unexpected response payload: ${trimmed}`);
    }

    return JSON.parse(sseDataLine.slice("data:".length).trim()) as JsonRpcResponse;
  }
}

async function postJsonRpc(
  port: number,
  payload: Record<string, unknown>,
  sessionId?: string,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });

  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
  }

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const body = parseJsonRpcBody(text);

  return { status: response.status, headers: response.headers, body };
}

async function initializeSession(port: number): Promise<string> {
  const initialize = await postJsonRpc(port, initializeRequest(1));
  assert.equal(initialize.status, 200);
  assert.ok(initialize.body?.result, "initialize should return a result");
  assert.equal(initialize.body?.error, undefined);

  const sessionId = initialize.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize response should include mcp-session-id");

  const initialized = await postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    sessionId ?? undefined,
  );

  assert.ok(
    [200, 202, 204].includes(initialized.status),
    `unexpected initialized status ${initialized.status}`,
  );

  return sessionId as string;
}

async function callTool(
  port: number,
  sessionId: string,
  id: number,
  toolName: string,
  toolArguments?: unknown,
): Promise<{ status: number; headers: Headers; body: JsonRpcResponse | undefined }> {
  const params: Record<string, unknown> = { name: toolName };
  if (toolArguments !== undefined) {
    params.arguments = toolArguments;
  }

  return postJsonRpc(
    port,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params,
    },
    sessionId,
  );
}

describe("mcp-server bootstrap", () => {
  it("exports the fixed default MCP port", () => {
    assert.equal(DEFAULT_MCP_PORT, 3338);
  });

  it("supports initialize, tools/list, and tools/call over HTTP", async () => {
    const runListCalls: number[] = [];
    const runStatusCalls: string[] = [];
    const eventCalls: number[] = [];

    const expectedRuns = [
      {
        id: "run-abc",
        workflowId: "feature-dev",
        task: "Implement MCP tools",
        status: "running",
        createdAt: "2026-05-02T15:00:00.000Z",
        updatedAt: "2026-05-02T15:05:00.000Z",
        stepSummary: "running:1",
        tokensSpent: 0,
      },
    ];

    const expectedRunDetail = {
      ...expectedRuns[0],
      steps: [
        {
          stepId: "story",
          agentId: "feature-dev_developer",
          status: "running",
          type: "single",
          retryCount: 0,
        },
      ],
    };

    const expectedEvents = [
      {
        ts: "2026-05-02T15:05:01.000Z",
        event: "step.started",
        runId: "run-abc",
      },
    ];

    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: (limit = 50) => {
          runListCalls.push(limit);
          return expectedRuns;
        },
        getWorkflowStatus: (query) => {
          runStatusCalls.push(query);
          return expectedRunDetail;
        },
        getRecentEvents: (limit = 50) => {
          eventCalls.push(limit);
          return expectedEvents;
        },
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const toolsList = await postJsonRpc(
        server.port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        sessionId,
      );

      assert.equal(toolsList.status, 200);
      assert.equal(toolsList.body?.error, undefined);

      const tools = (toolsList.body?.result?.tools ?? []) as Array<Record<string, unknown>>;
      assert.deepEqual(
        tools.map((tool) => tool.name),
        ["tamandua.runs.list", "tamandua.run.status", "tamandua.events.recent"],
      );
      assert.deepEqual((tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties?.limit, {
        type: "integer",
        minimum: 1,
        maximum: 200,
        description: "Maximum number of runs to return (default 50).",
      });
      assert.deepEqual((tools[1]?.inputSchema as { required?: string[] }).required, ["query"]);

      const runsList = await callTool(server.port, sessionId, 3, "tamandua.runs.list", { limit: 10 });
      assert.equal(runsList.status, 200);
      assert.equal(runsList.body?.error, undefined);
      assert.deepEqual(runsList.body?.result?.structuredContent, { runs: expectedRuns });
      assert.deepEqual(runListCalls, [10]);

      const runStatus = await callTool(server.port, sessionId, 4, "tamandua.run.status", { query: "run-ab" });
      assert.equal(runStatus.status, 200);
      assert.equal(runStatus.body?.error, undefined);
      assert.deepEqual(runStatus.body?.result?.structuredContent, { run: expectedRunDetail });
      assert.deepEqual(runStatusCalls, ["run-ab"]);

      const eventsRecent = await callTool(server.port, sessionId, 5, "tamandua.events.recent", { limit: 7 });
      assert.equal(eventsRecent.status, 200);
      assert.equal(eventsRecent.body?.error, undefined);
      assert.deepEqual(eventsRecent.body?.result?.structuredContent, { events: expectedEvents });
      assert.deepEqual(eventCalls, [7]);
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("returns MCP invalid-params errors for bad tool arguments without crashing the session", async () => {
    const server = await startTamanduaMcpServer(0, {
      services: {
        listRuns: () => [],
        getWorkflowStatus: () => {
          throw new Error("should not be called for invalid args");
        },
        getRecentEvents: () => [],
      },
    });

    try {
      const sessionId = await initializeSession(server.port);

      const missingQuery = await callTool(server.port, sessionId, 10, "tamandua.run.status", {});
      assert.equal(missingQuery.status, 200);
      assert.equal(missingQuery.body?.result, undefined);
      assert.equal(missingQuery.body?.error?.code, -32602);
      assert.match(missingQuery.body?.error?.message ?? "", /query/);

      const badLimitType = await callTool(server.port, sessionId, 11, "tamandua.runs.list", { limit: "25" });
      assert.equal(badLimitType.status, 200);
      assert.equal(badLimitType.body?.result, undefined);
      assert.equal(badLimitType.body?.error?.code, -32602);
      assert.match(badLimitType.body?.error?.message ?? "", /limit/);

      const validAfterErrors = await callTool(server.port, sessionId, 12, "tamandua.events.recent", { limit: 3 });
      assert.equal(validAfterErrors.status, 200);
      assert.equal(validAfterErrors.body?.error, undefined);
      assert.deepEqual(validAfterErrors.body?.result?.structuredContent, { events: [] });
    } finally {
      await stopTamanduaMcpServer(server);
    }
  });

  it("factory creates start/stop capable server handles", async () => {
    const server: TamanduaMcpServer = createTamanduaMcpServer(0);
    await server.start();
    assert.equal(server.server.listening, true);

    await server.stop();
    assert.equal(server.server.listening, false);
  });
});
