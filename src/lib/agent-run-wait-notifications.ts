import "server-only";

// Run "awaiting human" durable notification (cinatra #1559 / notifications epic
// E9).
//
// The HOST half of the run human-wait lifecycle. `packages/agents`
// `transitionRunStatus` classifies every status change and drives the injected
// `RunWaitNotifier` seam on each human-gate enter/leave (see
// `packages/agents/src/run-wait-notifier.ts`); this module is the write path it
// calls, wired at boot by `src/lib/register-run-wait-notifier.ts`.
//
// It applies the #1057 `agent_configuration_needs` lifecycle to runs: a run
// that parks on a GENUINE human gate mints ONE durable, actionable notification
// to its initiator, and the row is HARD-DELETED the moment the wait resolves
// (resume / terminal). Keyed on a stable per-run `dedupeKey`, so a repeated
// enter collapses to one row (ON CONFLICT DO NOTHING) and the clear is an
// idempotent delete-by-key.
//
// Which-status-is-a-human-wait is decided by the SEAM CLASSIFIER, not here: the
// emit only fires for a real gate (every `pending_approval`, plus the ONE
// human-actionable `pending_input` — stop-run-hitl — flagged at its call site),
// and the clear fires on every departure from a wait state. So the OVERLOADED
// `pending_input` reasons (setup / trigger editing / failed-run reset /
// enqueue-compensation) never mint a row, and every genuine wait's row is
// removed on its leave. Deliberately NOT status-conditioned at clear time — the
// status column alone cannot tell a human `pending_input` from an overloaded
// one, so re-deriving "still waiting?" from status would mis-handle the overload;
// the classifier already owns that decision, and an unconditional clear-by-key on
// leave is the same primitive #1057 uses.
//
// Best-effort, like every notification emitter in this codebase: a write failure
// never blocks a run. Concurrency posture also matches #1057 (idempotent, not
// linearized against the run row): in the rare event a resume/stop commits its
// clear inside the sub-millisecond window of an emit's DB write, a benign stale
// row can linger pointing at the now-resolved run (the pre-insert status guard
// closes the common "already resolved" case). Fully linearizing would require a
// durable human-wait discriminator on `agent_runs` written atomically with the
// status CAS (a schema change out of E9's scope) or coupling the notification
// write into the transition transaction (the exact `packages/agents` →
// notifications cycle this host seam exists to avoid).
//
// Route-through-the-host-seam keeps `packages/agents` off the notifications
// service graph — it already reaches back here via `readAgentRunById` for
// run-href resolution, and a bidirectional static edge would deepen that cycle.
//
// The pure builder + dedupeKey below have NO I/O and trigger no host side effect
// at import (the notifications host-adapter registration happens LAZILY inside
// the notifier methods), so they are trivially unit-testable.

import type {
  RunHumanWaitReason,
  RunWaitNotifier,
} from "@cinatra-ai/agents";
import { RUN_AWAITING_HUMAN_CATEGORY } from "@cinatra-ai/notifications/flyout-state";
import type { NotificationInput } from "@cinatra-ai/notifications/types";

/**
 * dedupeKey prefix shared by EVERY run-awaiting-human entry. The clear reads by
 * the full per-run key; the prefix documents the family (and lets a future
 * sweep read the whole family uncapped, as config-needs does).
 */
export const RUN_AWAITING_HUMAN_DEDUPE_PREFIX = "run-awaiting-human:";

/** Stable per-user idempotency key for one run's awaiting-human entry. */
export function runAwaitingHumanDedupeKey(runId: string): string {
  return `${RUN_AWAITING_HUMAN_DEDUPE_PREFIX}${runId}`;
}

/**
 * PURE: build the notification input for a run parked on a human gate.
 *
 * `warning` kind puts it in the Unread filter + bell badge as an actionable
 * reminder; the `href` deep-links to the run's approval surface so the unified
 * feed's row-shell "Open" action routes the viewer straight to the gate; the
 * per-run `dedupeKey` collapses repeat writes to ONE row; the
 * `metadata.runAwaitingHuman` payload tags the category + reason for the feed.
 */
export function buildRunAwaitingHumanNotificationInput(input: {
  runId: string;
  reason: RunHumanWaitReason;
  runTitle?: string | null;
  href?: string;
}): NotificationInput {
  const name = input.runTitle?.trim();
  const subject = name ? `"${name}"` : "A run";
  const title =
    input.reason === "pending_approval"
      ? `${subject} is awaiting your approval`
      : `${subject} is waiting on you to continue`;
  const body =
    input.reason === "pending_approval"
      ? "Open the run to review and approve the pending step."
      : "Open the run to resolve the gate so it can continue.";
  return {
    title,
    body,
    kind: "warning",
    ...(input.href ? { href: input.href } : {}),
    dedupeKey: runAwaitingHumanDedupeKey(input.runId),
    metadata: {
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: { runId: input.runId, reason: input.reason },
    },
  };
}

/** True while a run is parked on a human gate (either wait status). Used only by
 *  the pre-insert fast-path guard below. */
function isRunWaitStatus(status: string | undefined): boolean {
  return status === "pending_approval" || status === "pending_input";
}

/**
 * The host `RunWaitNotifier` implementation injected at boot. Emit-on-enter /
 * clear-on-leave, both best-effort.
 *
 * The notifications host adapters (postgres concerns) are registered LAZILY via
 * `@/lib/notifications-host` before the first `@cinatra-ai/notifications/server`
 * use on this path — the same side-effect wiring the `@/lib/notifications`
 * facade carries — so importing THIS module (e.g. for the pure builder) does not
 * pull the notifications service graph onto a cold import graph.
 */
export const runWaitNotifier: RunWaitNotifier = {
  async onEnterHumanWait({ runId, reason }) {
    try {
      await import("@/lib/notifications-host");
      // No actor argument → the store's access-gate block is bypassed (this
      // runs on the worker / status seam, which has no session). It only reads
      // `runBy` (the initiator) + `title` to address + name the notification.
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // No initiator (system-/trigger-launched run) → no one to notify.
      if (!userId) return;
      // Pre-insert fast-path guard: `transitionRunStatus` awaits this enter
      // dispatch AFTER committing the status CAS, so a concurrent resume/stop
      // may have already committed its leave. If the run is no longer parked on
      // a gate by the time we resolve it, skip the insert entirely — this closes
      // the common "already resolved before we emitted" case.
      if (!isRunWaitStatus(run.status)) return;
      const { resolveAgentRunHref, createNotificationForRecipient } =
        await import("@cinatra-ai/notifications/server");
      // Canonical run deep-link (templateId → packageName). Undefined for an
      // unresolvable run → a still-durable but link-less notification.
      const href = await resolveAgentRunHref({ runId });
      await createNotificationForRecipient(
        { kind: "user", userId },
        buildRunAwaitingHumanNotificationInput({
          runId,
          reason,
          runTitle: run.title,
          href,
        }),
      );
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not emit notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },

  async onLeaveHumanWait({ runId }) {
    try {
      await import("@/lib/notifications-host");
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // The row was written to the initiator; a null initiator means none was
      // ever written, so there is nothing to clear.
      if (!userId) return;
      // Unconditional clear-by-key: the run left a wait state, so its
      // run-awaiting-human row (if any) is resolved and must go. Idempotent — a
      // no-op when no row exists (an unflagged `pending_input` reason never
      // minted one). NOT status-conditioned: the status column cannot tell a
      // human `pending_input` from an overloaded one, so re-deriving "still
      // waiting?" here would mishandle the overload; the seam classifier already
      // owns that decision. Same primitive as the #1057 config-needs clear.
      const { deleteNotificationsByDedupeKeyForUser } = await import(
        "@cinatra-ai/notifications/server"
      );
      deleteNotificationsByDedupeKeyForUser({
        userId,
        dedupeKey: runAwaitingHumanDedupeKey(runId),
      });
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not clear notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },
};
