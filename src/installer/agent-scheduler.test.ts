import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import {
  setupAgentCrons,
  _getJobIntervalsForRun,
  removeRunCrons,
  shutdownAllCrons,
} from "../../dist/installer/agent-scheduler.js";

function makeWorkflow(overrides: {
  pollingTimeoutSeconds?: number;
} = {}) {
  return {
    id: "test-workflow",
    agents: [
      {
        id: "test-agent",
        model: "fake",
        workspace: { baseDir: "." },
      },
    ],
    steps: [
      {
        id: "step-1",
        agent: "test-agent",
        input: "do something",
        expects: "STATUS",
      },
    ],
    ...(overrides.pollingTimeoutSeconds !== undefined
      ? { polling: { timeoutSeconds: overrides.pollingTimeoutSeconds } }
      : {}),
  };
}

describe("setupAgentCrons interval calculation", () => {
  afterEach(() => {
    shutdownAllCrons();
  });

  it("uses default interval 5 when no polling.timeoutSeconds is set", async () => {
    const workflow = makeWorkflow();
    const runId = "run-default-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 5);

    await removeRunCrons(runId);
  });

  it("uses Math.max(1, ...) floor when polling.timeoutSeconds is set (33s → ceil(33/60)=1)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 33 });
    const runId = "run-floor-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 1);

    await removeRunCrons(runId);
  });

  it("ceil works for fractional minutes (120s → ceil(2)=2)", async () => {
    const workflow = makeWorkflow({ pollingTimeoutSeconds: 120 });
    const runId = "run-ceil-test";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].intervalMinutes, 2);

    await removeRunCrons(runId);
  });

  it("works with multiple agents", async () => {
    const workflow = {
      ...makeWorkflow({ pollingTimeoutSeconds: 90 }),
      agents: [
        { id: "agent-a", model: "fake", workspace: { baseDir: "." } },
        { id: "agent-b", model: "fake", workspace: { baseDir: "." } },
      ],
    };
    const runId = "run-multi";

    await setupAgentCrons(workflow, runId);

    const intervals = _getJobIntervalsForRun(runId);
    assert.equal(intervals.length, 2);
    // 90s / 60 = 1.5, ceil → 2
    for (const job of intervals) {
      assert.equal(job.intervalMinutes, 2);
    }

    await removeRunCrons(runId);
  });
});
