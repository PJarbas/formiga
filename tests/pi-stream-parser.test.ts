import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  filterPiEvent,
  parsePiOutputStream,
  MAX_TEXT_FALLBACK_BYTES,
} from "../dist/installer/pi-stream-parser.js";

// ── Helpers ─────────────────────────────────────────────────────────

function cannedMessageEnd(role: string, text: string, totalTokens?: number) {
  return {
    type: "message_end",
    message: {
      role,
      content: [{ type: "text", text }],
      usage: totalTokens !== undefined
        ? { input: 10, output: 5, totalTokens }
        : undefined,
    },
  };
}

function cannedMessageUpdate(text: string) {
  return {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      content: [{ type: "text", text }],
    },
  };
}

function cannedToolExecutionStart(name: string) {
  return {
    type: "tool_execution_start",
    toolName: name,
    toolCallId: "call_abc",
  };
}

function cannedToolExecutionEnd(name: string) {
  return {
    type: "tool_execution_end",
    toolName: name,
    result: { content: [{ type: "text", text: "ok" }] },
  };
}

// ── filterPiEvent tests ─────────────────────────────────────────────

describe("filterPiEvent", () => {
  // AC 1: keeps message_end with assistant role
  it("returns kept event for message_end with assistant role", () => {
    const event = cannedMessageEnd("assistant", "Hello");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    assert.equal(typeof result, "object");
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "message_end");
    }
  });

  // AC 2: returns null for message_update text_delta events
  it("returns null for message_update text_delta events", () => {
    const event = cannedMessageUpdate("some accumulating text...");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  // AC 3: returns kept event for tool_execution_start, _update, _end
  it("returns kept event for tool_execution_start", () => {
    const event = cannedToolExecutionStart("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_start");
    }
  });

  it("returns kept event for tool_execution_end", () => {
    const event = cannedToolExecutionEnd("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_end");
    }
  });

  it("returns kept event for tool_execution_update", () => {
    const event = {
      type: "tool_execution_update",
      toolName: "bash",
      partial: "some output",
    };
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_update");
    }
  });

  // AC 4: returns null for message_end with non-assistant role
  it("returns null for message_end with non-assistant role (user)", () => {
    const event = cannedMessageEnd("user", "hello");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  it("returns null for message_end with non-assistant role (system)", () => {
    const event = cannedMessageEnd("system", "system prompt");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  // AC 5: returns null for message_start, turn_start, turn_end, agent_start, agent_end
  it("returns null for message_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "message_start" })), null);
  });

  it("returns null for turn_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "turn_start" })), null);
  });

  it("returns null for turn_end", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "turn_end" })), null);
  });

  it("returns null for agent_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "agent_start" })), null);
  });

  it("returns null for agent_end", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "agent_end" })), null);
  });

  // AC 6: returns null for malformed JSON lines
  it("returns the original line (text fallback) for malformed JSON lines", () => {
    const line = "{ broken json: oops";
    const result = filterPiEvent(line);
    assert.equal(typeof result, "string");
    assert.equal(result, "{ broken json: oops");
  });

  it("returns null for empty lines", () => {
    assert.equal(filterPiEvent(""), null);
    assert.equal(filterPiEvent("  \t  "), null);
  });

  it("returns the original line (text fallback) for plain non-JSON text", () => {
    const line = "HEARTBEAT_OK";
    const result = filterPiEvent(line);
    assert.equal(result, "HEARTBEAT_OK");
  });

  it("returns text fallback for JSON objects without a type field", () => {
    const line = JSON.stringify({ foo: "bar" });
    const result = filterPiEvent(line);
    assert.equal(typeof result, "string");
  });
});

// ── parsePiOutputStream tests ───────────────────────────────────────

describe("parsePiOutputStream", () => {
  // AC 7: extracts assistant text from kept message_end events
  it("extracts assistant text from kept message_end events", async () => {
    const lines = [
      JSON.stringify(cannedMessageUpdate("accumulating text...")),
      JSON.stringify(cannedMessageUpdate("more text...")),
      JSON.stringify(cannedMessageEnd("assistant", "Hello, world!", 42)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "Hello, world!");
    assert.equal(result.events.length, 1); // only message_end kept
    assert.equal(result.textFallback, null);
  });

  it("uses the last assistant message_end text when multiple are present", async () => {
    const lines = [
      JSON.stringify(cannedMessageEnd("assistant", "first reply", 10)),
      JSON.stringify(cannedMessageEnd("assistant", "second reply", 20)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "second reply");
    assert.equal(result.events.length, 2);
  });

  it("keeps tool_execution events alongside message_end", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionStart("read")),
      JSON.stringify(cannedMessageUpdate("thought...")),
      JSON.stringify(cannedToolExecutionEnd("read")),
      JSON.stringify(cannedMessageEnd("assistant", "Done", 30)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 3);
    assert.equal(result.assistantText, "Done");
    assert.ok(
      result.events.some((e) => e.type === "tool_execution_start"),
    );
    assert.ok(
      result.events.some((e) => e.type === "tool_execution_end"),
    );
    assert.ok(
      result.events.some((e) => e.type === "message_end"),
    );
  });

  // AC 8: handles text-mode output by returning bounded full text
  it("handles text-mode output by returning full text", async () => {
    const lines = [
      "HEARTBEAT_OK",
      "NO_WORK",
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "");
    assert.equal(result.events.length, 0);
    assert.notEqual(result.textFallback, null);
    assert.ok(result.textFallback!.includes("HEARTBEAT_OK"));
    assert.ok(result.textFallback!.includes("NO_WORK"));
    assert.equal(result.textFallbackTruncated, false);
  });

  it("handles mixed JSON and text-mode lines", async () => {
    const lines = [
      "some preamble",
      JSON.stringify(cannedMessageEnd("assistant", "Mixed mode", 50)),
      "trailing text",
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "Mixed mode");
    assert.equal(result.events.length, 1);
    assert.notEqual(result.textFallback, null);
    assert.ok(result.textFallback!.includes("some preamble"));
    assert.ok(result.textFallback!.includes("trailing text"));
  });

  // AC 9: keeps memory bounded regardless of discarded event volume
  it("keeps event array small when processing large volume of discarded events", async () => {
    // Simulate 10000 message_update lines (text_delta) plus one real message_end
    const lines: string[] = [];
    const largeString = "x".repeat(1000);
    for (let i = 0; i < 10000; i++) {
      lines.push(JSON.stringify(cannedMessageUpdate(`delta ${i}: ${largeString}`)));
    }
    lines.push(JSON.stringify(cannedMessageEnd("assistant", "Final answer", 100)));

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 1); // only message_end kept
    assert.equal(result.assistantText, "Final answer");
    assert.equal(result.textFallback, null);
  });

  it("caps text-mode fallback at MAX_TEXT_FALLBACK_BYTES", async () => {
    // Create lines that will exceed the text cap
    const bigLine = "x".repeat(2 * 1024 * 1024); // 2MB per line
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`${bigLine}-${i}`);
    }

    const result = await parsePiOutputStream(lines);
    assert.equal(result.textFallbackTruncated, true);
    assert.notEqual(result.textFallback, null);
    // Should be at or under the cap
    const fallbackBytes = Buffer.byteLength(result.textFallback!, "utf-8");
    assert.ok(
      fallbackBytes <= MAX_TEXT_FALLBACK_BYTES,
      `text fallback was ${fallbackBytes} bytes, expected <= ${MAX_TEXT_FALLBACK_BYTES}`,
    );
  });

  it("handles empty input", async () => {
    const result = await parsePiOutputStream([]);
    assert.equal(result.events.length, 0);
    assert.equal(result.assistantText, "");
    assert.equal(result.textFallback, null);
    assert.equal(result.textFallbackTruncated, false);
  });

  it("discards user and system message_end events but keeps assistant ones", async () => {
    const lines = [
      JSON.stringify(cannedMessageEnd("user", "user msg")),
      JSON.stringify(cannedMessageEnd("system", "system msg")),
      JSON.stringify(cannedMessageEnd("assistant", "actual response", 25)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 1);
    assert.equal(result.assistantText, "actual response");
  });
});
