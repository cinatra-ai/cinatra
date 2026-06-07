---
name: trigger
description: Configure when an agent run should be released (immediate, scheduled, or recurring) via the trigger_config_* primitives.
---

# Trigger configuration

Use this skill when a user asks you to schedule or re-arm an agent run trigger. Three trigger types are supported:

- **immediate** — release the run as soon as the trigger row is committed. No `scheduledAt` or `cronExpression` required.
- **scheduled** — release the run once at a specific instant. Supply `scheduledAt` as an ISO 8601 string in UTC (e.g. `"2026-06-15T14:30:00Z"`); leave `cronExpression` unset.
- **recurring** — release the run on a repeating schedule. Supply `cronExpression` as a 5-field cron string (`minute hour day-of-month month day-of-week`, e.g. `"0 9 * * MON"` for "every Monday at 09:00"); leave `scheduledAt` unset.

Always set `timezone` to a valid IANA zone (e.g. `"Europe/Vienna"`, `"America/Los_Angeles"`) so cron and scheduled triggers fire at the user's wall-clock time. If the user does not specify a zone, default to `"UTC"`.

When the user describes a schedule in natural language (e.g. "every Monday at 9am", "tomorrow at noon"), translate it into the appropriate `triggerType` + `scheduledAt`/`cronExpression` pair before calling `trigger_config_set`. Only call `trigger_config_set` once per confirmed configuration — the user will explicitly approve via the HITL confirm gate before the write is committed.

Use `trigger_config_get` to read the current configuration for a run, and `trigger_config_delete` to clear it (for example, when the user wants to stop a recurring trigger).
