---
name: tamandua-agents
description: Guide agents to run Tamandua workflow and step lifecycle commands consistently. Use when an agent must poll for work, claim a step, execute task input, and report completion or failure.
---

# Tamandua Agents

## Instructions

Use this skill when operating as a Tamandua workflow agent.

### 1) Confirm CLI access

Use the `tamandua` CLI if available on PATH.

```bash
tamandua version
```

If the binary is not on PATH, use the Node entrypoint directly:

```bash
node /path/to/tamandua/dist/cli/cli.js <command>
```

### 2) Know the workflow-level commands

Use these when managing workflow runs (outside individual step execution):

```bash
tamandua workflow list
tamandua workflow run <workflow-id> "<task>" [--working-directory-for-harness <dir>]
tamandua workflow status <run-id-or-query>
tamandua workflow runs
tamandua workflow resume <run-id>
tamandua workflow stop <run-id>
```

Harness working directory guidance:

- CLI run: `--working-directory-for-harness` is optional; if omitted it defaults to the shell's current working directory.
- Prefer passing an explicit absolute path when the task depends on a specific repo checkout.

### 3) Follow the step lifecycle exactly

Always execute step commands in this order:

1. `tamandua step peek <agent-id>`
2. If result is `HAS_WORK`, run `tamandua step claim <agent-id>`
3. Parse claim JSON: `{"stepId":"...","runId":"...","input":"..."}`
4. **SAVE `stepId` immediately** and execute the `input` task
5. Report with the saved step id:
   - Success: `tamandua step complete <stepId>` (send status output through stdin)
   - Failure: `tamandua step fail <stepId> "<reason>"`

Never call `step complete` or `step fail` with an agent ID. They require the claimed step UUID.

### 4) Completion contract

On success, provide structured output that includes:

- `STATUS: done`
- `CHANGES: ...`
- `TESTS: ...`

Then pipe that output into `tamandua step complete <stepId>`.

On failure, call `tamandua step fail <stepId> "<clear reason>"` with actionable detail.

### 2.1) MCP run start (remote)

When using MCP, `tamandua.run.start` requires a harness working directory.
Always provide `workingDirectoryForHarness`.

Required MCP args:

- `workflowId`
- `taskTitle`
- `workingDirectoryForHarness` (mandatory)

Recovery pattern for tool-calling models:

- If MCP returns: `Argument "workingDirectoryForHarness" must be a non-empty string`
- Retry the same tool call with an explicit absolute path (for example `/home/user/repo`).

## Examples

### Polling loop example

```bash
# Phase 1: Peek
tamandua step peek feature-dev_developer
# -> NO_WORK (stop) OR HAS_WORK (continue)

# Phase 2: Claim
tamandua step claim feature-dev_developer
# -> {"stepId":"87409f73-...","runId":"7aeb4da9-...","input":"Implement ..."}
# Save stepId=87409f73-...

# Execute the input task...

# Success report (uses saved stepId)
echo 'STATUS: done
CHANGES: Added skill docs and tests
TESTS: node --test tests/*.test.ts' | tamandua step complete 87409f73-4ba6-492a-be44-30b2b6ffbadb

# Failure alternative
# tamandua step fail 87409f73-4ba6-492a-be44-30b2b6ffbadb "Missing repository path"
```

### Manual step inspection

```bash
tamandua step stories <run-id>
```

Use `step stories` to inspect current story status for a run when diagnosing blocked pipelines.
