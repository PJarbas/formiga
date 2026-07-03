// ══════════════════════════════════════════════════════════════════════
// streaming-metadata-extractor.test.ts
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StreamingMetadataExtractor } from "./streaming-metadata-extractor.js";

describe("StreamingMetadataExtractor", () => {
  it("extracts STATUS: done marker", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("Some preamble");
    ext.processLine("STATUS: done");
    ext.processLine("Some trailing text");
    const meta = ext.getMetadata();
    assert.equal(meta.statusMarker, "done");
    assert.equal(meta.totalLines, 3);
  });

  it("extracts STATUS: failed marker", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("STATUS: failed");
    assert.equal(ext.getMetadata().statusMarker, "failed");
  });

  it("extracts STATUS: error marker", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("STATUS: error");
    assert.equal(ext.getMetadata().statusMarker, "error");
  });

  it("STATUS is case-insensitive", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("STATUS: DONE");
    assert.equal(ext.getMetadata().statusMarker, "done");
  });

  it("last STATUS wins when multiple appear", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("STATUS: done");
    ext.processLine("STATUS: failed");
    assert.equal(ext.getMetadata().statusMarker, "failed");
  });

  it("returns null statusMarker when no STATUS line", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("Just some text");
    assert.equal(ext.getMetadata().statusMarker, null);
  });

  it("extracts token usage from message_end JSON event", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":"hello","usage":{"input_tokens":100,"output_tokens":200,"total_tokens":300}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.tokenUsage, 300);
    assert.equal(meta.jsonMetadataDetected, true);
  });

  it("extracts assistant text from message_end content string", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":"I analyzed the data.","usage":{"total_tokens":50}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.assistantTextTail, "I analyzed the data.");
  });

  it("extracts assistant text from message_end content array", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}],"usage":{"total_tokens":75}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.assistantTextTail, "Part 1\nPart 2");
  });

  it("extracts run_id and step_id from JSON metadata", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":"ok","usage":{"total_tokens":10},"run_id":"3b637688-99bf-491f-8999-6ab86427fbb9","step_id":"a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"}}');
    const meta = ext.getMetadata();
    assert.equal(meta.runId, "3b637688-99bf-491f-8999-6ab86427fbb9");
    assert.equal(meta.stepId, "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
  });

  it("ignores malformed JSON lines", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("{broken json");
    ext.processLine("not json at all");
    const meta = ext.getMetadata();
    assert.equal(meta.jsonMetadataDetected, false);
    assert.equal(meta.tokenUsage, null);
  });

  it("ignores non-assistant message_end events", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"user","content":"prompt","usage":{"total_tokens":50}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.tokenUsage, null); // Not from assistant
  });

  it("tracks totalBytesIngested and totalLines", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("line 1");
    ext.processLine("line 2 is longer");
    const meta = ext.getMetadata();
    assert.equal(meta.totalLines, 2);
    assert.ok(meta.totalBytesIngested > 0);
  });

  it("evicts old lines when assistant buffer exceeds maxAssistantBytes", () => {
    const ext = new StreamingMetadataExtractor(50); // Very small buffer
    ext.processLine("This is a line that is definitely longer than fifty bytes altogether");
    ext.processLine("Short line");
    ext.processLine("Another short");
    const meta = ext.getMetadata();
    assert.ok(meta.assistantTextTruncated);
    assert.ok(meta.linesDropped > 0);
  });

  it("replaces assistant buffer on message_end (authoritative)", () => {
    const ext = new StreamingMetadataExtractor(50);
    ext.processLine("old preamble line that should be replaced");
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":"Authoritative text","usage":{"total_tokens":5}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.assistantTextTail, "Authoritative text");
  });

  it("returns empty assistantTextTail for empty input", () => {
    const ext = new StreamingMetadataExtractor();
    const meta = ext.getMetadata();
    assert.equal(meta.assistantTextTail, "");
    assert.equal(meta.totalLines, 0);
    assert.equal(meta.totalBytesIngested, 0);
  });

  it("handles HEARTBEAT_OK in output", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine("HEARTBEAT_OK");
    ext.processLine("STATUS: done");
    const meta = ext.getMetadata();
    assert.equal(meta.statusMarker, "done");
    assert.ok(meta.assistantTextTail.includes("HEARTBEAT_OK"));
  });

  it("tokenUsage uses extractTokenUsage normalization (sum of parts)", () => {
    const ext = new StreamingMetadataExtractor();
    ext.processLine('{"type":"message_end","message":{"role":"assistant","content":"ok","usage":{"input_tokens":100,"output_tokens":200}}}');
    const meta = ext.getMetadata();
    assert.equal(meta.tokenUsage, 300); // 100 + 200
  });

  it("does not crash on very large single line", () => {
    const ext = new StreamingMetadataExtractor(1024);
    const hugeLine = "x".repeat(50000);
    ext.processLine(hugeLine);
    ext.processLine("normal line");
    const meta = ext.getMetadata();
    assert.ok(meta.assistantTextTail.length > 0);
    assert.ok(meta.linesDropped >= 0); // May or may not drop depending on buffer
  });
});