import "server-only";

import type { TaskState } from "@a2a-js/sdk";

// ---------------------------------------------------------------------------
// @cinatra-ai/a2a — shared types
//
// Configuration and status-mapping types shared between the in-process
// transport and the Cinatra-virtual-agent `AgentExecutor` bridge.
//
// The `CinatraTaskStatusMap` maps Cinatra `agent_runs.status` values to
// A2A `TaskState` values. Cinatra's actual run statuses (verified in
// `packages/agent-builder/src/store.ts`, `execution.ts`) are:
//   - "queued"             — row created, BullMQ job enqueued, not yet started
//   - "running"             — worker picked up the job
//   - "completed"           — terminal success
//   - "failed"              — terminal failure
//   - "stopped"             — terminal cancel (user-requested)
//   - "pending_approval"    — paused on a HITL review gate
//   - "pending_input"       — paused awaiting user input
// ---------------------------------------------------------------------------

/**
 * Configuration for wiring a Cinatra virtual agent to an A2A endpoint.
 *
 * `templateId` — the `agent_templates.id` of the published virtual agent.
 * `packageName` — the npm package name; surfaced as the A2A `AgentCard.name`.
 * `pollIntervalMs` — poll period for `agent_runs` (default 1000ms).
 * `pollTimeoutMs` — OBSERVER-side timeout (default 300000ms / 5min). See
 *   lifecycle semantics in `agent-executor.ts`: expiring does NOT cancel the
 *   underlying BullMQ job — the job keeps running.
 */
export type CinatraA2AConfig = {
  templateId: string;
  packageName: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

/**
 * Maps Cinatra `agent_runs.status` → A2A `TaskState`.
 *
 * The A2A `TaskState` union (from @a2a-js/sdk) includes:
 *   "submitted" | "working" | "input-required" | "completed"
 *   | "canceled" | "failed" | "rejected" | "auth-required" | "unknown"
 *
 * Mapping rules:
 *   queued            → submitted  (row created, not yet started)
 *   running           → working    (worker picked up the job)
 *   completed         → completed  (terminal success)
 *   failed            → failed     (terminal failure)
 *   stopped           → canceled   (terminal cancel)
 *   pending_approval  → input-required (HITL gate — client needs to act)
 *   pending_input     → input-required (awaiting user input)
 */
export const CinatraTaskStatusMap: Readonly<Record<string, TaskState>> = {
  queued: "submitted",
  running: "working",
  completed: "completed",
  failed: "failed",
  stopped: "canceled",
  pending_approval: "input-required",
  pending_input: "input-required",
};

/**
 * The set of A2A `TaskState` values that are terminal from the executor's
 * perspective. Once a run maps to one of these, the executor publishes the
 * final status-update with `final: true` and returns.
 */
export const TERMINAL_A2A_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
