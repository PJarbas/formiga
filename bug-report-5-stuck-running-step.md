# Bug Report 5 — Step is permanently stuck in `'running'` after pi SIGKILL'd by per-call timeout

**Severity:** High (an entire workflow run wedges silently — no events, no escalation, no retry — until the user manually intervenes)
**Status:** Present in current `main` (`src/`).
**Discovered:** 2026-05-06, while monitoring run `6844b60b` during a `feature-dev-merge` exercise that I started to author the `bug-fix-merge` workflow.

## Symptom

A workflow run goes idle, indefinitely, with one step stuck in `status='running'`. No events fire, no retries happen, no human escalation event is emitted, the dashboard / `tamandua workflow status` keeps showing `[running]`, and only `ps` reveals the actual cause: the pi process that owned the step is gone.

Concretely (run `6844b60b`, `feature-dev-merge` planner step):

```
02:46:56  Run started
02:46:56  pipeline.advanced (plan -> pending)
02:49:08  step.running (plan claimed by feature-dev-merge_planner)
02:51:48  run.tokens.updated (tokenDelta: 26866 — input prompt loaded into the LLM)
            ... 32+ minutes of total silence ...
03:23:05  state still: plan=running, run=running. No pi process for the run.
```

Polling cron continues to fire every 2 min — visible as transient pi processes spawned for *other* agents — but none of them advance the plan step.

## Why the polling cron cannot recover

`runPi` in `src/installer/agent-scheduler.ts:205` uses the role-policy timeout (analysis = 1200s = 20 min) and SIGKILLs pi at the deadline (per memory `project_runtime_bugs.md` bug #2 + #5). When the SIGKILL fires:

1. The killed pi child never got to call `tamandua step complete <stepId>` or `step fail`.
2. `runPi`'s `finally` block clears `inFlightJobs.delete(job.id)` and the polling timeout — but does **not** reset the orphaned step in the DB.
3. On the next polling tick (2 min later), `executePollingRound` calls `peekStep(agentId)`. `peekStep` in `src/installer/step-ops.ts` matches only `('pending', 'waiting')` (memory bug #1, plus the later "downstream agents wake on `'waiting'`" note). The orphaned step is `'running'`, so `peekStep` returns `NO_WORK` for the planner cron.
4. Result: the step sits in `'running'` forever. No retry, no `step.failed`, no `run.failed`, no `escalate_to: human`.

The other agents' crons keep firing on the downstream `'waiting'` steps, briefly spawn pi (which I observed: PIDs 15907 / 15914 living for ~10s before peek/claim returns NO_WORK and they exit), so from the outside it looks like the workflow is "still polling" — but no useful work happens.

## Why this is a NEW class of bug, not a duplicate of the prior fixes

`project_runtime_bugs.md` documents earlier related bugs:
- Bug #1: first step never kicked off → fixed by `advancePipeline` at run start.
- Bug #2/#5: pi got SIGKILL'd at the wrong (workflow-polling) timeout → fixed by switching to role timeouts.
- Bug #4: pi processes accumulated unbounded → fixed by `inFlightJobs` guard.
- Bug #14: workflow CLI never exited → fixed by idle-cron teardown.

None of those fix the *post-kill* recovery. After bug #2 was fixed, pi gets a longer timeout — but if the LLM call still hangs past the role timeout (which I just observed for an unusually long planner prompt), the same orphan-step condition applies. The fix simply made the orphan rarer.

## Likely trigger in my run

The task prompt I gave the planner was 39 lines and included absolute paths, `gh pr create` references, acceptance criteria, etc. The planner emitted token usage at 02:51 (input loaded — 26866 tokens) and then did not respond for 18 more minutes, hitting the 20-min analysis-role timeout at ~03:09. Whether the LLM was thinking, retrying internally, or stalled is opaque — pi outputs nothing until completion.

This is a regular operating condition: long planner prompts on cold context are exactly the slow path the role-timeout is sized for. Hitting the timeout is supposed to be recoverable.

## Suggested fix (NOT applied — report only)

Two complementary changes:

1. **In `runPi`'s finally block (or the wrapper that calls it from the cron), on a non-zero exit / SIGKILL, set the step's status back to `pending`.** Add an `attempt_count` increment so retries don't loop forever — when `attempt_count >= max_retries`, mark the step `failed`, emit `step.failed`, and let the workflow's `on_fail` machinery (`escalate_to: human` etc.) kick in. The current code seems to assume pi always cooperates by calling `step complete` or `step fail`; SIGKILL violates that assumption.

2. **Add a "stale claim" sweeper.** A periodic check (e.g. inside `executePollingRound`) that examines steps with `status='running'` whose `updated_at` is older than `roleTimeoutSeconds * 1.5`, and rolls them back to `pending` (with attempt-count bookkeeping). This is a belt-and-suspenders for cases where the runPi finally block didn't run (e.g. the polling node itself was killed mid-flight). Without it, any uncatchable failure leaves a permanent orphan.

A third smaller hardening: emit a `step.kill` or `step.timed_out` event in `runPi`'s timeout handler before the SIGKILL, so the dashboard / log stream can surface the failure mode to a human watcher even when the recovery loop isn't yet implemented.

## How I'm working around this run

Because I can't fix the bug myself for this exercise, I am:
1. Calling `tamandua workflow stop 6844b60b`.
2. Starting a fresh `feature-dev-merge` run with a much tighter task description, hoping the smaller prompt finishes within the 20-min planner budget.

Both are operational nudges, not code changes.
