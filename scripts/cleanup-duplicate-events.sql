-- ═══════════════════════════════════════════════════════════════════════════
-- cleanup-duplicate-events.sql — Remove duplicate agent_events from run 6599978a
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Before the activity-recorder fix, toolcall_delta events were creating
-- duplicate "running" events. This script cleans them up.
--
-- Usage:
--   sqlite3 ~/.formiga/formiga.db < scripts/cleanup-duplicate-events.sql
--
-- Safe to run multiple times — all operations are idempotent.
-- ═══════════════════════════════════════════════════════════════════════════

-- Step 1: Delete all "running" tool_call events that have no matching "completed"/"failed"
-- These are orphaned start events that were never matched with a result.
DELETE FROM agent_events
WHERE event_type = 'tool_call'
  AND tool_status = 'running'
  AND id NOT IN (
    SELECT MIN(e2.id)
    FROM agent_events e2
    WHERE e2.event_type = 'tool_call'
      AND e2.tool_status = 'running'
    GROUP BY e2.run_id, e2.step_id, e2.agent_id, e2.tool_name, e2.created_at
  );

-- Step 2: Delete duplicate "running" events that share the same
-- (run_id, step_id, agent_id, tool_name, created_at) — keep only the first.
DELETE FROM agent_events
WHERE id NOT IN (
  SELECT MIN(id)
  FROM agent_events
  WHERE event_type = 'tool_call' AND tool_status = 'running'
  GROUP BY run_id, step_id, agent_id, tool_name, created_at
  HAVING COUNT(*) > 0
)
AND event_type = 'tool_call'
AND tool_status = 'running';

-- Step 3: Delete stale thinking events that are too short (pre-fix threshold was 20 chars).
DELETE FROM agent_events
WHERE event_type = 'thinking'
  AND LENGTH(thinking) < 100;

-- Step 4: Vacuum to reclaim disk space.
-- Note: VACUUM requires exclusive access to the DB.
-- Uncomment if no other process is using the DB:
-- VACUUM;