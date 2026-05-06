# Bug Report 2 — `tamandua logs` and `tamandua logs-tail` reject short run-id prefixes

**Severity:** Low (UX paper-cut on a debugging command — does not affect run correctness)
**Status:** Present in current `main` (`src/`).
**Discovered:** 2026-05-06, while monitoring run `6e7fbf12` during the bug-fix workflow exercising bug-report.md.

## Symptom

```
$ tamandua logs 6e7fbf12
No events for run "6e7fbf12".
```

…even though the run exists and is actively producing events. The actual event file on disk is named with the full UUID, e.g. `~/.tamandua/events/6e7fbf12-3400-4e3f-9ea7-817b5517cdad.jsonl`. The command reads `~/.tamandua/events/6e7fbf12.jsonl` (literal short prefix), gets ENOENT, and reports "No events".

`tamandua logs-tail <prefix>` has the same problem: it streams from the literal prefix, never finds events, and the user is left watching an empty tail.

Workaround: pass the full UUID, or use `#<run-number>` (which routes through `lookupRunIdByNumber` and works), or `tamandua logs <N>` for the global recent log.

## Locations

- `src/cli/cli.ts:275` — `tamandua logs <run-id>` branch:

  ```ts
  const events = getRunEvents(selector.runId);
  events.length === 0 ? console.log(`No events for run "${selector.runId}".`) : printEvents(events);
  ```

  `selector.runId` is the raw user arg from `parseLogsSelector` (`src/cli/logs-selector.ts:19`); it's never expanded.

- `src/cli/cli.ts:298` — `tamandua logs-tail <run-id>` branch:

  ```ts
  await streamEventSource({ kind: "run", runId: selector.runId }, 50);
  ```

  Same: short prefix flows straight through to `readEventsFromCursor`, which opens `~/.tamandua/events/<runId>.jsonl` and gets `ENOENT`.

- The receiving end is `getRunEvents` in `src/installer/events.ts:186-204` and `readEventsFromCursor` in `:111`. Both compute the file path from `runId` directly with no prefix expansion or wildcard search, and silently return an empty array on `ENOENT`.

## Why this is the same shape as the already-fixed prefix bugs

Per memory `project_runtime_bugs.md`, two prior CLI commands were fixed by routing through `getWorkflowStatus(target).id` for prefix expansion:

> 8. `tamandua step stories <prefix>` rejected short run-ids. … Fix: route through `getWorkflowStatus(target).id` to expand the prefix first (cli.ts).
> 13. `tamandua workflow stop|resume <prefix>` rejected short run-ids. Same pattern as the `step stories` bug. Fix: route through `getWorkflowStatus(target).id`. (cli.ts)

`tamandua logs` and `tamandua logs-tail` were missed in that sweep. The bytes between them and the already-fixed callers are nearly identical.

## Suggested fix (not applied — report only)

In both `cli.ts` `logs` and `logs-tail` branches, when `selector.kind === "run-id"`, expand the prefix the same way the other commands do:

```ts
let runId = selector.runId;
try {
  runId = getWorkflowStatus(selector.runId).id;
} catch {
  // fall through with the literal — let the empty-events branch report it
}
```

Then pass `runId` (not `selector.runId`) to `getRunEvents` / `streamEventSource`. The error path (`getWorkflowStatus` throws on no/multiple matches) should be preserved as a clearer error message — "No run found matching '6e7fbf12'" beats "No events for run '6e7fbf12'", because the latter implies the run exists but is silent.

A second, smaller hardening: when `getWorkflowStatus` finds *multiple* runs matching a prefix, it throws with a useful disambiguation message — `logs` / `logs-tail` should let that message reach the user instead of returning a misleading "no events".
