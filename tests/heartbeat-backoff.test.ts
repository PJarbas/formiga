/**
 * Unit tests for heartbeat backoff (RF-5, issue #77, spec §1.3).
 *
 * Backoff kicks in at MAX_CONSECUTIVE_HEARTBEATS (3) and grows
 * exponentially: skip 1 round at 3, 2 at 4, 4 at 5, 8 at 6+, capped at 8.
 * Distinct from the failure circuit (RF-4, threshold 5): backoff saves
 * tokens by aborting rounds; failure signals a structural error.
 *
 * These tests pin the getHeartbeatBackoff formula so the "never applied"
 * regression (run 367d0f4e — rounds fired every cron interval with no
 * exponential spacing) cannot silently return.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordHeartbeat,
  resetHeartbeatBackoff,
  getHeartbeatBackoff,
  MAX_CONSECUTIVE_HEARTBEATS,
} from "../dist/installer/scheduler/shared.js";

const JOB = "test-heartbeat-backoff-job";

afterEach(() => {
  resetHeartbeatBackoff(JOB);
});

describe("getHeartbeatBackoff exponential schedule", () => {
  it("no skip below the backoff threshold", () => {
    resetHeartbeatBackoff(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 0);
    recordHeartbeat(JOB); // 1
    assert.equal(getHeartbeatBackoff(JOB), 0);
    recordHeartbeat(JOB); // 2
    assert.equal(getHeartbeatBackoff(JOB), 0);
  });

  it("skips 1 round at the threshold (3)", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < MAX_CONSECUTIVE_HEARTBEATS; i++) recordHeartbeat(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 1);
  });

  it("skips 2 rounds at 4 consecutive heartbeats", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 4; i++) recordHeartbeat(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 2);
  });

  it("skips 4 rounds at 5 consecutive heartbeats", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 5; i++) recordHeartbeat(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 4);
  });

  it("caps at 8 rounds from 6+ consecutive heartbeats", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 6; i++) recordHeartbeat(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 8);
    recordHeartbeat(JOB); // 7
    assert.equal(getHeartbeatBackoff(JOB), 8, "should remain capped at 8");
    recordHeartbeat(JOB); // 8
    assert.equal(getHeartbeatBackoff(JOB), 8, "should remain capped at 8");
  });

  it("follows the full 1→2→4→8 progression", () => {
    resetHeartbeatBackoff(JOB);
    // count = number of recordHeartbeat calls; backoff starts at threshold (3).
    //   count: 0  1  2  3  4  5  6  7
    //   skip: 0  0  0  1  2  4  8  8
    const expected = [0, 0, 0, 1, 2, 4, 8, 8];
    for (let count = 0; count < expected.length; count++) {
      if (count > 0) recordHeartbeat(JOB);
      assert.equal(
        getHeartbeatBackoff(JOB),
        expected[count],
        `count=${count} should skip ${expected[count]}`,
      );
    }
  });
});

describe("resetHeartbeatBackoff clears the schedule", () => {
  it("returns to 0 skip after a non-heartbeat outcome", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 6; i++) recordHeartbeat(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 8);
    resetHeartbeatBackoff(JOB);
    assert.equal(getHeartbeatBackoff(JOB), 0, "reset should clear backoff");
  });

  it("starts accumulating again from scratch after reset", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 6; i++) recordHeartbeat(JOB);
    resetHeartbeatBackoff(JOB);
    recordHeartbeat(JOB); // 1 after reset
    assert.equal(getHeartbeatBackoff(JOB), 0);
    recordHeartbeat(JOB); // 2
    assert.equal(getHeartbeatBackoff(JOB), 0);
    recordHeartbeat(JOB); // 3 → threshold
    assert.equal(getHeartbeatBackoff(JOB), 1);
  });
});
