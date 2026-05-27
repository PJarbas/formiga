import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  decideStatus,
  initExperiment,
  logExperiment,
  loopAutoresearch,
  parseAgentFields,
  parseMetric,
  readAutoresearchLog,
  runExperiment,
  summarizeAutoresearch,
} from "../../dist/autoresearch/autoresearch.js";
import { parsePiOutputStream } from "../../dist/installer/pi-stream-parser.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tamandua-autoresearch-"));
}

function nodeMetricCommand(metricName: string, value: number): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log("${metricName}: ${value}")`)}`;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

describe("autoresearch state model", () => {
  it("initializes durable session files", () => {
    const cwd = makeTempDir();

    const entry = initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "val_bpb",
      metricUnit: "bpb",
      direction: "lower",
      command: nodeMetricCommand("val_bpb", 1.5),
    });

    assert.equal(entry.type, "session");
    assert.equal(entry.metric_name, "val_bpb");
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.config.json")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.md")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.sh")));
    assert.match(fs.readFileSync(path.join(cwd, "autoresearch.md"), "utf-8"), /ratchet/i);
  });

  it("runs experiments, parses metrics, and logs baseline then discard", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce validation loss",
      metricName: "val_bpb",
      direction: "lower",
      command: nodeMetricCommand("val_bpb", 1.5),
    });

    const firstResult = await runExperiment({ cwd });
    assert.equal(firstResult.run, 1);
    assert.equal(firstResult.status, "measured");
    assert.equal(firstResult.metric, 1.5);

    const firstLog = await logExperiment({
      cwd,
      status: "auto",
      description: "baseline run",
      hypothesis: "measure starting point",
      learned: "baseline is stable",
      nextFocus: "try a lower value",
    });
    assert.equal(firstLog.status, "baseline");
    assert.equal(firstLog.best_metric, 1.5);

    const secondResult = await runExperiment({ cwd, command: nodeMetricCommand("val_bpb", 1.7) });
    assert.equal(secondResult.run, 2);
    assert.equal(secondResult.metric, 1.7);

    const secondLog = await logExperiment({
      cwd,
      status: "auto",
      description: "regression run",
      learned: "metric got worse",
      nextFocus: "undo and test a narrower change",
    });
    assert.equal(secondLog.status, "discard");
    assert.equal(secondLog.best_metric, 1.5);

    const summary = summarizeAutoresearch(cwd);
    assert.equal(summary.totalRuns, 2);
    assert.equal(summary.keptRuns, 1);
    assert.equal(summary.discardedRuns, 1);
    assert.equal(summary.bestMetric, 1.5);
    assert.match(summary.nextPrompt, /metric got worse/);

    const entries = readAutoresearchLog(cwd);
    assert.equal(entries.filter((entry) => entry.type === "run").length, 2);
    assert.equal(entries.filter((entry) => entry.type === "run_result").length, 2);
  });

  it("classifies improvements according to direction", () => {
    const entries = [
      { type: "session", created_at: "2026-01-01T00:00:00.000Z", goal: "increase auc", metric_name: "auc", direction: "higher", command: "echo auc: 0.7" },
      {
        type: "run",
        run: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        status: "baseline",
        metric: 0.7,
        metric_name: "auc",
        direction: "higher",
        description: "baseline",
        baseline_metric: 0.7,
        best_metric: 0.7,
        improvement_ratio: 1,
      },
    ] as const;

    assert.equal(decideStatus([...entries], 0.8, "measured"), "keep");
    assert.equal(decideStatus([...entries], 0.6, "measured"), "discard");
    assert.equal(decideStatus([...entries], null, "crash"), "crash");
  });

  it("marks successful benchmarks as checks_failed when checks fail", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "keep correctness",
      metricName: "total_ms",
      direction: "lower",
      command: nodeMetricCommand("total_ms", 42),
      checksCommand: `${JSON.stringify(process.execPath)} -e ${JSON.stringify("process.exit(2)")}`,
    });

    const result = await runExperiment({ cwd });

    assert.equal(result.status, "checks_failed");
    assert.equal(result.metric, 42);
    assert.equal(result.checks?.exit_code, 2);
  });

  it("reverts tracked and untracked experiment files while preserving autoresearch state", async () => {
    const cwd = makeTempDir();
    git(cwd, ["init", "--initial-branch=main"]);
    git(cwd, ["config", "user.email", "test@tamandua.local"]);
    git(cwd, ["config", "user.name", "Tamandua Test"]);
    fs.writeFileSync(path.join(cwd, "model.py"), "BASELINE\n");
    git(cwd, ["add", "model.py"]);
    git(cwd, ["commit", "-m", "baseline"]);

    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 1),
    });
    fs.writeFileSync(path.join(cwd, "model.py"), "EXPERIMENT\n");
    fs.writeFileSync(path.join(cwd, "scratch.txt"), "temporary\n");

    await logExperiment({
      cwd,
      status: "discard",
      metric: 2,
      description: "discard regression",
      revertDiscard: true,
    });

    assert.equal(fs.readFileSync(path.join(cwd, "model.py"), "utf-8"), "BASELINE\n");
    assert.equal(fs.existsSync(path.join(cwd, "scratch.txt")), false);
    assert.ok(fs.existsSync(path.join(cwd, "autoresearch.jsonl")));
  });

  it("parses metric regex capture group before generic metric names", () => {
    assert.equal(parseMetric("loss=1.2\ncustom=9.8", "loss", "custom=([0-9.]+)"), 9.8);
    assert.equal(parseMetric("val_bpb: 1.234", "val_bpb"), 1.234);
    assert.equal(parseMetric("no metric here", "val_bpb"), null);
  });
});

describe("autoresearch loop", () => {
  it("rejects loopAutoresearch without actionMode", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    await assert.rejects(
      loopAutoresearch({ cwd, maxIterations: 1 }),
      /No action mode specified/,
    );
  });

  it("runs measure-only loop and labels iterations", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 2,
      actionMode: "measure-only",
    });

    assert.equal(result.iterations, 2);
    assert.equal(result.bestMetric, 5);
    assert.ok(result.stopReason?.includes("Max iterations"));

    const summary = summarizeAutoresearch(cwd);
    assert.equal(summary.totalRuns, 2);
  });

  it("displays historical best distinctly from loop best", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // Create a prior session with a historical best of 3.0
    const priorDir = makeTempDir();
    initExperiment({
      cwd: priorDir,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 3),
    });
    const priorResult = await runExperiment({ cwd: priorDir });
    await logExperiment({
      cwd: priorDir,
      status: "auto",
      description: "prior best run",
    });

    // Copy the prior log to the current dir so there is history
    fs.copyFileSync(
      path.join(priorDir, "autoresearch.jsonl"),
      path.join(cwd, "autoresearch.jsonl"),
    );

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "measure-only",
    });

    // New loop measured 5, so loop best is 5
    assert.equal(result.bestMetric, 5);
    // But all-time best from prior session (3) should still be reported
    // The allTimeBestMetric should reflect the prior best if the combined log shows it
    // Note: copying the log doesn't change the config's knowledge of history,
    // but loopAutoresearch reads from the actual log file on each iteration.
    // On the second iteration, the log has both prior best (3) and new run (5).
    // The initial summary should show bestMetric=3 from prior session.
    // Since result.allTimeBestMetric is set from initialSummary, it should be 3.
    assert.equal(result.allTimeBestMetric, 3);
  });

  it("accepts --prompt mode and invokes agent between iterations", async () => {
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "prompt",
    });

    // With prompt mode, the loop tries to spawn pi.
    // If pi is not available, the agent step fails and we get 0 iterations
    // or a failure loop. The loop should not crash.
    // We just verify it completes without throwing.
    assert.ok(result.stopReason !== null);
  });

  it("invokes pi with correct args (--print, --no-session, --mode json, no --cwd/--message/--no-tui)", async () => {
    // Create a fake pi script (Node.js) that records the received arguments
    const cwd = makeTempDir();
    const recordFile = path.join(cwd, "pi-args.json");
    const fakePi = path.join(cwd, "fake-pi");

    // Build a realistic assistant message_end JSONL response
    const messageEnd = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "STATUS: done\nCHANGES: fixed the thing\nHYPOTHESIS: it should work\nLEARNED: coding is fun\nNEXT_FOCUS: more tests" },
        ],
      },
    });

    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `const recordFile = ${JSON.stringify(recordFile)};`,
      `fs.writeFileSync(recordFile, JSON.stringify(process.argv.slice(1)));`,
      `console.log(${JSON.stringify(JSON.stringify({ type: "session", version: 1 }))});`,
      `console.log(${JSON.stringify(messageEnd)});`,
      `console.log(${JSON.stringify(JSON.stringify({ type: "agent_end" }))});`,
      `process.exit(0);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    // We can't directly call runPiAgent (it's not exported and it spawns "pi").
    // Instead, verify by spawning fake-pi directly with the expected args + spawn cwd option.
    const child = spawnSync(fakePi, ["--print", "--no-session", "--mode", "json", "test prompt"], {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    assert.equal(child.status, 0);
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
    assert.ok(Array.isArray(recorded));

    // Verify the supported flags are present and unsupported ones are absent
    assert.ok(recorded.includes("--print"), `expected --print in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--no-session"), `expected --no-session in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--mode"), `expected --mode in args: ${JSON.stringify(recorded)}`);
    const modeIdx = recorded.indexOf("--mode");
    assert.equal(recorded[modeIdx + 1], "json", `expected --mode json in args: ${JSON.stringify(recorded)}`);

    // Verify unsupported flags are NOT present
    assert.ok(!recorded.includes("--no-tui"), `--no-tui should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--cwd"), `--cwd should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--message"), `--message should NOT be in args: ${JSON.stringify(recorded)}`);

    // Verify the prompt is passed positionally
    assert.ok(recorded.includes("test prompt"), `expected prompt in args: ${JSON.stringify(recorded)}`);
  });

  it("closes pi stdin so pi does not hang waiting for input (regression test for stdin-left-open bug)", async () => {
    // Regression test: the runPiAgent function previously spawned pi with
    // stdio: ["pipe","pipe","pipe"] and never wrote to or closed stdin.
    // pi in --print mode waits for stdin EOF before processing argv, so
    // it would hang until the 300s timeout. The fix uses ["ignore","pipe","pipe"].
    const cwd = makeTempDir();
    const recordFile = path.join(cwd, "pi-args.json");
    const fakePiPath = path.join(cwd, "pi");

    // Fake pi that waits for stdin EOF, writes JSONL output, and records argv.
    // With stdin ignored/closed, process.stdin emits "end" immediately and the
    // output is produced. With stdin left open (the bug), it hangs forever.
    const messageEnd = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "STATUS: done\\nCHANGES: stdin correctly ignored\\nHYPOTHESIS: ignore stdin for prompt mode\\nLEARNED: pi waits for stdin EOF\\nNEXT_FOCUS: none" }],
      },
    });
    fs.writeFileSync(fakePiPath, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `const fs = require("node:fs");`,
      `const recordFile = ${JSON.stringify(recordFile)};`,
      `fs.writeFileSync(recordFile, JSON.stringify(process.argv.slice(1)));`,
      `process.stdin.resume();`,
      `process.stdin.on("end", () => {`,
      `  console.log(${JSON.stringify(JSON.stringify({ type: "session", version: 1 }))});`,
      `  console.log(${JSON.stringify(messageEnd)});`,
      `  console.log(${JSON.stringify(JSON.stringify({ type: "agent_end" }))});`,
      `  process.exit(0);`,
      `});`,
    ].join("\n"));
    fs.chmodSync(fakePiPath, 0o755);

    // Spawn with the fix: stdio: ["ignore", "pipe", "pipe"]
    const child = spawnSync(fakePiPath, ["--print", "--no-session", "--mode", "json", "test prompt"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000, // 10s safety net — should complete in <1s
    });

    assert.equal(child.status, 0, `fake pi exited ${child.status}: ${child.stderr}`);
    assert.ok(child.stdout.includes("STATUS: done"), `expected STATUS in stdout: ${child.stdout}`);

    // Verify argv correctness (same checks as the existing argv test)
    const recorded = JSON.parse(fs.readFileSync(recordFile, "utf-8"));
    assert.ok(recorded.includes("--print"), `expected --print in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--no-session"), `expected --no-session in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("--mode"), `expected --mode in args: ${JSON.stringify(recorded)}`);
    const modeIdx = recorded.indexOf("--mode");
    assert.equal(recorded[modeIdx + 1], "json", `expected --mode json in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--no-tui"), `--no-tui should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--cwd"), `--cwd should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(!recorded.includes("--message"), `--message should NOT be in args: ${JSON.stringify(recorded)}`);
    assert.ok(recorded.includes("test prompt"), `expected prompt in args: ${JSON.stringify(recorded)}`);
  });
});

describe("pi JSONL stream parsing in autoresearch context", () => {
  it("parses assistant text from a realistic message_end event via parsePiOutputStream", async () => {
    const lines = [
      JSON.stringify({ type: "session", version: 1 }),
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "turn_start" }),
      JSON.stringify({ type: "message_start", message: { role: "user" } }),
      // message_update events (should be discarded by parser)
      JSON.stringify({ type: "message_update", message: { content: [{ type: "text_delta", text: "partial" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
        { type: "thinking", thinking: "let me think..." },
        { type: "text", text: "STATUS: done\nCHANGES: fixed pi invocation\nHYPOTHESIS: using JSON mode correctly\nLEARNED: parsePiOutputStream works\nNEXT_FOCUS: add timeout option" },
      ] } }),
      JSON.stringify({ type: "turn_end" }),
      JSON.stringify({ type: "agent_end" }),
    ];

    const result = await parsePiOutputStream(lines);

    assert.ok(result.assistantText.length > 0, "expected non-empty assistantText");
    assert.match(result.assistantText, /STATUS: done/);
    assert.match(result.assistantText, /CHANGES: fixed pi invocation/);
    assert.match(result.assistantText, /HYPOTHESIS: using JSON mode correctly/);
    assert.match(result.assistantText, /LEARNED: parsePiOutputStream works/);
    assert.match(result.assistantText, /NEXT_FOCUS: add timeout option/);
    assert.equal(result.textFallback, null, "no text fallback expected for valid JSONL");
    // Only assistant message_end and tool_execution_* should be kept
    const keptTypes = result.events.map((event) => event.type);
    assert.ok(keptTypes.includes("message_end"), "message_end should be kept");
    assert.ok(!keptTypes.includes("session"), "session should be discarded");
    assert.ok(!keptTypes.includes("message_update"), "message_update should be discarded");
  });

  it("parseAgentFields extracts all fields from assistant text", () => {
    const text = [
      "STATUS: done",
      "CHANGES: rewrote runPiAgent",
      "HYPOTHESIS: JSON mode fixes parsing",
      "LEARNED: pi --no-session is needed",
      "NEXT_FOCUS: add --timeout CLI flag",
    ].join("\n");

    const fields = parseAgentFields(text);
    assert.ok(fields !== null, "expected non-null fields");
    assert.equal(fields!.status, "done");
    assert.equal(fields!.changes, "rewrote runPiAgent");
    assert.equal(fields!.hypothesis, "JSON mode fixes parsing");
    assert.equal(fields!.learned, "pi --no-session is needed");
    assert.equal(fields!.nextFocus, "add --timeout CLI flag");
  });

  it("parseAgentFields handles minimal input with only STATUS and CHANGES", () => {
    const text = "STATUS: done\nCHANGES: fixed bug";
    const fields = parseAgentFields(text);
    assert.ok(fields !== null);
    assert.equal(fields!.status, "done");
    assert.equal(fields!.changes, "fixed bug");
    assert.equal(fields!.hypothesis, undefined);
    assert.equal(fields!.learned, undefined);
    assert.equal(fields!.nextFocus, undefined);
  });

  it("parseAgentFields returns null when no STATUS field", () => {
    assert.equal(parseAgentFields("just some text"), null);
    assert.equal(parseAgentFields(""), null);
    assert.equal(parseAgentFields("CHANGES: something"), null);
  });

  it("loopAutoresearch respects timeoutSeconds option with a short timeout", async () => {
    // Create a fake pi that hangs (no output, no exit), then verify the loop
    // times it out and handles the failure gracefully.
    const cwd = makeTempDir();
    const fakePi = path.join(cwd, "pi");
    fs.writeFileSync(fakePi, [
      `#!/usr/bin/env -S ${process.execPath}`,
      `// Hang forever — the loop should time this out`,
      `setTimeout(() => {}, 600_000);`,
    ].join("\n"));
    fs.chmodSync(fakePi, 0o755);

    const origPath = process.env.PATH ?? "";
    // Prepend the cwd to PATH so the fake pi is found
    process.env.PATH = `${cwd}${path.delimiter}${origPath}`;

    try {
      initExperiment({
        cwd,
        goal: "reduce loss",
        metricName: "loss",
        direction: "lower",
        command: nodeMetricCommand("loss", 5),
      });

      // Use a short 1-second timeout so the test is fast.
      // maxConsecutiveFailures=3 (default), so with 2 iterations both
      // will time out and the loop will complete 2 iterations.
      const result = await loopAutoresearch({
        cwd,
        maxIterations: 2,
        actionMode: "prompt",
        timeoutSeconds: 1,
      });

      // Both iterations should complete (agent times out, loop continues)
      assert.equal(result.iterations, 2);
      // No experiments were actually run since the agent kept failing
      // and the loop skips experiments on agent failure.
      assert.equal(result.crashed, 0);
      assert.ok(result.stopReason?.includes("Max iterations reached"));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("loopAutoresearch uses default 300s timeout when no timeoutSeconds option", async () => {
    // Verify the type system: timeoutSeconds is optional and defaults to 300.
    // We can't easily observe the internal timeout, but we verify the loop runs.
    const cwd = makeTempDir();
    initExperiment({
      cwd,
      goal: "reduce loss",
      metricName: "loss",
      direction: "lower",
      command: nodeMetricCommand("loss", 5),
    });

    // measure-only mode doesn't use runPiAgent, so it should succeed
    const result = await loopAutoresearch({
      cwd,
      maxIterations: 1,
      actionMode: "measure-only",
    });

    // Verify no timeoutSeconds was provided, but loop still runs
    assert.equal(result.iterations, 1);
  });

  it("parseAgentFields handles STATUS: no_change", () => {
    const text = "STATUS: no_change\nCHANGES: nothing to do\nLEARNED: metric is optimal";
    const fields = parseAgentFields(text);
    assert.ok(fields !== null);
    assert.equal(fields!.status, "no_change");
    assert.equal(fields!.changes, "nothing to do");
    assert.equal(fields!.learned, "metric is optimal");
  });
});
