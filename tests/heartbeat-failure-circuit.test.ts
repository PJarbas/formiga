/**
 * Unit tests for the heartbeat-failure circuit (RF-4, issue #76, spec §3).
 *
 * After N consecutive heartbeats with no work_done, a step is failed
 * terminally (heartbeat_loop_exhausted) so on_fail/escalate_to can fire.
 * Distinct from backoff (MAX_CONSECUTIVE_HEARTBEATS=3, which skips rounds
 * to save tokens); the failure circuit (default 5) treats a persistent
 * loop as a structural error.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordHeartbeat,
  resetHeartbeatBackoff,
  getHeartbeatFailureThreshold,
  shouldFailForHeartbeatLoop,
} from "../dist/installer/scheduler/shared.js";

const JOB = "test-heartbeat-circuit-job";

afterEach(() => {
  resetHeartbeatBackoff(JOB);
  delete process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD;
});

describe("getHeartbeatFailureThreshold", () => {
  it("defaults to 5", () => {
    delete process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD;
    assert.equal(getHeartbeatFailureThreshold(), 5);
  });

  it("honors FORMIGA_HEARTBEAT_FAILURE_THRESHOLD", () => {
    process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD = "8";
    assert.equal(getHeartbeatFailureThreshold(), 8);
  });

  it("falls back to 5 on invalid value", () => {
    process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD = "not-a-number";
    assert.equal(getHeartbeatFailureThreshold(), 5);
  });

  it("falls back to 5 on non-positive value", () => {
    process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD = "0";
    assert.equal(getHeartbeatFailureThreshold(), 5);
  });
});

describe("shouldFailForHeartbeatLoop (default threshold 5)", () => {
  it("does not fire below the threshold", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 4; i++) recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), false);
  });

  it("fires at exactly the threshold", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 5; i++) recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), true);
  });

  it("fires above the threshold", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 7; i++) recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), true);
  });

  it("resets after a non-heartbeat outcome", () => {
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 5; i++) recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), true);
    resetHeartbeatBackoff(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), false);
  });
});

describe("shouldFailForHeartbeatLoop (custom threshold)", () => {
  it("honors a higher custom threshold", () => {
    process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD = "8";
    resetHeartbeatBackoff(JOB);
    for (let i = 0; i < 7; i++) recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), false, "7 < 8 should not fire");
    recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), true, "8 should fire");
  });

  it("honors a lower custom threshold", () => {
    process.env.FORMIGA_HEARTBEAT_FAILURE_THRESHOLD = "2";
    resetHeartbeatBackoff(JOB);
    recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), false, "1 < 2 should not fire");
    recordHeartbeat(JOB);
    assert.equal(shouldFailForHeartbeatLoop(JOB), true, "2 should fire");
  });
});
