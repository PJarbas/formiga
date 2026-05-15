import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterPiEvent } from "../../dist/installer/pi-stream-parser.js";

describe("pi-stream-parser edge cases", () => {
  it("handles malformed JSON (starts with { but invalid)", () => {
    // This covers the catch block (lines 85-86 in compiled JS)
    const result = filterPiEvent("{invalid json");
    assert.equal(typeof result, "string");
    assert.equal(result, "{invalid json");
  });

  it("handles empty trimmed line", () => {
    assert.equal(filterPiEvent("   "), null);
  });

  it("handles non-JSON text fallback", () => {
    const result = filterPiEvent("just some text");
    assert.equal(typeof result, "string");
    assert.equal(result, "just some text");
  });

  it("discards non-assistant message_end", () => {
    const result = filterPiEvent(JSON.stringify({
      type: "message_end",
      message: { role: "user" },
    }));
    assert.equal(result, null);
  });

  it("keeps assistant message_end", () => {
    const event = { type: "message_end", message: { role: "assistant", content: "hi" } };
    const result = filterPiEvent(JSON.stringify(event));
    assert.ok(result !== null && typeof result === "object");
    assert.equal((result as any).type, "message_end");
  });

  it("discards message_update events", () => {
    const result = filterPiEvent(JSON.stringify({ type: "message_update" }));
    assert.equal(result, null);
  });

  it("keeps tool_execution_start events", () => {
    const result = filterPiEvent(JSON.stringify({ type: "tool_execution_start", tool: "bash" }));
    assert.ok(result !== null && typeof result === "object");
  });

  it("handles JSON without type field as text fallback", () => {
    const result = filterPiEvent(JSON.stringify({ foo: "bar" }));
    assert.equal(typeof result, "string");
  });
});
