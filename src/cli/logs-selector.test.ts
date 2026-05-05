import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLogsSelector, lookupRunIdByNumber } from "../../dist/cli/logs-selector.js";

describe("parseLogsSelector", () => {
  it("returns default global recent selector when no arg is provided", () => {
    assert.deepEqual(parseLogsSelector(), { kind: "global-recent", limit: 50 });
  });

  it("parses a numeric arg as global limit", () => {
    assert.deepEqual(parseLogsSelector("25"), { kind: "global-limit", limit: 25 });
  });

  it("parses #<run-number> as run-number selector", () => {
    assert.deepEqual(parseLogsSelector("#42"), { kind: "run-number", runNumber: 42, raw: "#42" });
  });

  it("parses non-numeric values as run-id selectors", () => {
    assert.deepEqual(parseLogsSelector("run-abc"), { kind: "run-id", runId: "run-abc" });
  });
});

describe("lookupRunIdByNumber", () => {
  it("queries runs by run_number", () => {
    const calls: Array<{ sql: string; runNumber: number }> = [];
    const db = {
      prepare(sql: string) {
        return {
          get(runNumber: number) {
            calls.push({ sql, runNumber });
            return { id: "run-id-123" };
          },
        };
      },
    };

    const runId = lookupRunIdByNumber(7, db);

    assert.equal(runId, "run-id-123");
    assert.deepEqual(calls, [{ sql: "SELECT id FROM runs WHERE run_number = ?", runNumber: 7 }]);
  });

  it("returns undefined when no matching run_number exists", () => {
    const db = {
      prepare() {
        return {
          get() {
            return undefined;
          },
        };
      },
    };

    assert.equal(lookupRunIdByNumber(999, db), undefined);
  });
});
