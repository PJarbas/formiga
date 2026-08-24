// ══════════════════════════════════════════════════════════════════════
// activity-timeout.test.ts — Activity-rearmed hard timeout
// ══════════════════════════════════════════════════════════════════════

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createActivityTimeout } from "./activity-timeout.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createActivityTimeout", () => {
  it("expires on the hard cap when the child stays silent", async () => {
    let expired = false;
    const t = createActivityTimeout({ hardMs: 40 }, () => { expired = true; });
    await sleep(90);
    assert.equal(expired, true);
    t.clear();
  });

  it("expires on the stale threshold when activity stops before the hard cap", async () => {
    let expired = false;
    const t = createActivityTimeout({ hardMs: 400, staleMs: 40 }, () => { expired = true; });
    t.notifyActivity(); // t≈0 → stale would fire at ~40
    await sleep(25);
    t.notifyActivity(); // re-arms stale at ~25 → fires at ~65
    await sleep(25);
    // silence from ~50; stale (40ms) fires ~90, well before hard (400)
    await sleep(100);
    assert.equal(expired, true);
    t.clear();
  });

  it("keeps a working child alive up to the hard cap", async () => {
    let expired = false;
    const t = createActivityTimeout({ hardMs: 200, staleMs: 50 }, () => { expired = true; });
    for (let i = 0; i < 8; i++) {
      await sleep(20);
      t.notifyActivity();
    }
    // ~160ms elapsed with steady activity — stale re-armed past the hard cap
    assert.equal(expired, false, "an active child must not be killed early");
    await sleep(80); // ~240ms > hard 200
    assert.equal(expired, true, "the hard cap must still bound a chatty runaway");
    t.clear();
  });

  it("clear() disarms both timers", async () => {
    let expired = false;
    const t = createActivityTimeout({ hardMs: 40, staleMs: 20 }, () => { expired = true; });
    t.clear();
    await sleep(90);
    assert.equal(expired, false);
  });
});
