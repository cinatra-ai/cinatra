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
// The human-wait presentation discriminator, imported from the PURE leaf
// subpath (not the package index) so the builder below stays trivially
// unit-testable and pulls no agents service graph onto a cold import.
import {
  classifyRunWaitInterrupt,
  waitNotificationLandsInConversation,
  type RunWaitInterruptDescriptor,
  type RunWaitInterruptKind,
} from "@cinatra-ai/agents/run-surface-status";
import {
  RUN_AWAITING_HUMAN_CATEGORY,
  RUN_FAILED_CATEGORY,
} from "@cinatra-ai/notifications/flyout-state";
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
 * cinatra#2066 C2 — dedupeKey prefix for a LIFECYCLE AUTO-GATE's run-view
 * notification. A SUBFAMILY of the run-awaiting-human family (so a future family
 * sweep catches it), but keyed per (run, reviewTaskId) rather than per-run: a run
 * can own several auto-gates at once and each is cleared independently when ITS
 * gate resolves. Distinct from the per-run `runAwaitingHumanDedupeKey` above, so
 * an auto-gate row and a flow-authored human-wait row on the same run never
 * collapse onto each other.
 */
export const RUN_AUTO_GATE_OPEN_DEDUPE_PREFIX = `${RUN_AWAITING_HUMAN_DEDUPE_PREFIX}auto:`;

/** Stable per-user idempotency key for one auto-gate's run-view notification. */
export function autoGateOpenDedupeKey(
  runId: string,
  reviewTaskId: string,
): string {
  return `${RUN_AUTO_GATE_OPEN_DEDUPE_PREFIX}${runId}:${reviewTaskId}`;
}

/**
 * PURE: build the notification input for a run on which a lifecycle AUTO-GATE
 * opened (cinatra#2066 C2). Same actionable-`warning` shape + run-awaiting-human
 * category as `buildRunAwaitingHumanNotificationInput` — so the unified feed
 * renders and routes it identically (the "Open" action deep-links to the run
 * view via `href`) — but with the per-(run, task) auto-gate dedupeKey and a
 * `pending_approval` reason payload (an auto-gate always awaits an approval
 * decision). The copy names the review explicitly.
 */
/** Conformance handle for the design spec's `run-gate-notification` anchor
 * (design@5e5c53aff §I): a pending auto-gate raises a notification that DEEP-LINKS
 * straight to the gate inside the run (the `href` below → the run view), never to a
 * detached page. The run-embedded conformance test asserts this behavior against
 * this builder (the anchor has no DOM home — it is a notification). */
export const RUN_GATE_NOTIFICATION_CONFORMANCE_ID = "run-gate-notification";

export function buildAutoGateOpenNotificationInput(input: {
  runId: string;
  reviewTaskId: string;
  runTitle?: string | null;
  href?: string;
}): NotificationInput {
  const name = input.runTitle?.trim();
  const subject = name ? `"${name}"` : "A run";
  return {
    title: `${subject} produced an artifact awaiting review`,
    body: "Open the run to review the auto-gated step.",
    kind: "warning",
    ...(input.href ? { href: input.href } : {}),
    dedupeKey: autoGateOpenDedupeKey(input.runId, input.reviewTaskId),
    metadata: {
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: { runId: input.runId, reason: "pending_approval" },
    },
  };
}

/**
 * PURE: build the notification input for a run parked on a human gate.
 *
 * `warning` kind puts it in the Unread filter + bell badge as an actionable
 * reminder; the `href` deep-links to the run's approval surface so the unified
 * feed's row-shell "Open" action routes the viewer straight to the gate; the
 * per-run `dedupeKey` collapses repeat writes to ONE row; the
 * `metadata.runAwaitingHuman` payload tags the category + reason for the feed.
 *
 * COPY SELECTION. `reason` alone cannot pick the copy: a setup-field INPUT
 * pause and a genuine review gate BOTH enter as `pending_approval`, and telling
 * the user a run "is awaiting your approval" when it only wants the Idea field
 * filled in is the defect this builder shares with the run-card badge. So the
 * optional `interrupt` descriptor is classified by the SAME shared, semantic
 * discriminator the badge uses (`classifyRunWaitInterrupt` — the synthetic
 * `setup-<runId>` gate identity or the setup payload's `fieldName`), and BOTH
 * surfaces therefore say the same thing about the same wait.
 *
 * Presentation only. `metadata.runAwaitingHuman.reason` still carries the
 * unmodified `RunHumanWaitReason`, so no consumer's state, filter, or route
 * changes; with no `interrupt` in hand the classifier fails closed to the
 * pre-existing approval copy.
 *
 * cinatra#2835 — `waitKind` is the CALLER-SUPPLIED form of that same
 * classification, for a wait with no interrupt to derive from. The run-start
 * recommendation HOLD parks an already-`pending_input` run on a card, so
 * `deriveRunHitlContext` has nothing to answer with and the derivation would
 * fail closed to the generic continue-copy — while the hold is, by the #2729
 * ruling, exactly an INPUT wait. An explicit `"input"` therefore selects the
 * input copy for EITHER reason; anything else leaves the pre-existing
 * reason+interrupt derivation untouched. Its ONE caller is
 * `onEnterRecommendationHold` — the transition seam derives instead of stating
 * (cinatra#2838 dropped the field the transition seam never filled).
 */
export function buildRunAwaitingHumanNotificationInput(input: {
  runId: string;
  reason: RunHumanWaitReason;
  runTitle?: string | null;
  href?: string;
  interrupt?: RunWaitInterruptDescriptor | null;
  waitKind?: RunWaitInterruptKind;
  /**
   * cinatra#2835 — the continuation park this row belongs to, for a row minted by
   * a run-start recommendation HOLD. Stamped into the metadata so the hold's clear
   * can name its OWN row: the dedupeKey is per-RUN, and a clear retried by a later
   * sweep would otherwise be free to delete whatever wait happens to occupy that
   * key by then. Absent for every other writer, whose rows the hold clear
   * therefore cannot touch.
   */
  holdParkId?: string;
}): NotificationInput {
  const name = input.runTitle?.trim();
  const subject = name ? `"${name}"` : "A run";
  const awaitingInput =
    input.waitKind === "input" ||
    (input.reason === "pending_approval" &&
      classifyRunWaitInterrupt(input.interrupt) === "input");
  let title: string;
  let body: string;
  if (awaitingInput) {
    title = `${subject} needs your input`;
    // Two different destinations share this title, so they must not share a body.
    // A derived input wait (`interrupt` classified `"input"`) really does land on a
    // form with fields. The run-start recommendation HOLD (`waitKind: "input"`, whose
    // one caller is `onEnterRecommendationHold`) does NOT: it lands on the skills
    // chip row, whose own copy reads "Confirm the skills for this run … Adjust the
    // selection, then confirm — or skip". Telling that reader to "fill in the
    // requested fields" names fields the card does not have.
    //
    // INTERIM WORDING (cinatra#2838). The hold's final bell copy is the epic's ONE
    // reserved decision and is NOT settled here; this line only stops the shipped
    // row from describing a destination that does not exist. Whoever settles the
    // reserved decision replaces this string — the branch, not the words, is the
    // durable part.
    body =
      input.waitKind === "input"
        ? "Open the run to confirm or skip the recommended skills."
        : "Open the run to fill in the requested fields.";
  } else if (input.reason === "pending_approval") {
    title = `${subject} is awaiting your approval`;
    body = "Open the run to review and approve the pending step.";
  } else {
    title = `${subject} is waiting on you to continue`;
    body = "Open the run to resolve the gate so it can continue.";
  }
  return {
    title,
    body,
    kind: "warning",
    ...(input.href ? { href: input.href } : {}),
    dedupeKey: runAwaitingHumanDedupeKey(input.runId),
    metadata: {
      category: RUN_AWAITING_HUMAN_CATEGORY,
      runAwaitingHuman: {
        runId: input.runId,
        reason: input.reason,
        ...(input.holdParkId ? { holdParkId: input.holdParkId } : {}),
      },
    },
  };
}

/**
 * The app schema every table in this database lives in. Resolved at CALL time,
 * not module load: the real-database suites set `SUPABASE_SCHEMA` to a throwaway
 * schema before driving these paths, and a module-scope constant would have
 * captured whatever the env said when some unrelated importer first pulled this
 * module in. Mirrors `src/lib/postgres-config.ts` / the notifications host
 * adapter's own resolution.
 */
function appSchemaName(): string {
  return process.env.SUPABASE_SCHEMA?.trim() || "cinatra";
}

/**
 * cinatra#2413 — dedupeKey prefix for the run-failure notification that
 * supersedes the (hard-deleted) run-awaiting-human row when a run fails OUT
 * OF a human-wait state. A SEPARATE family from `RUN_AWAITING_HUMAN_DEDUPE_PREFIX`
 * (not a subfamily): the awaiting-human row for this run is being deleted in
 * the SAME dispatch, so the two keys must never collide or the delete could
 * race the insert onto the same row identity.
 */
export const RUN_FAILED_DEDUPE_PREFIX = "run-failed:";

/** Stable per-user idempotency key for one run's failure entry. */
export function runFailedDedupeKey(runId: string): string {
  return `${RUN_FAILED_DEDUPE_PREFIX}${runId}`;
}

/**
 * PURE: build the notification input for a run that failed OUT OF a
 * human-wait state (cinatra#2413). `error` kind (destructive, matches the
 * feed's `notificationTone`) so it reads as distinct from the `warning`
 * awaiting-human row it replaces. Deep-links to the run via the SAME `href`
 * shape as the awaiting-human builder, so "Open" routes the viewer straight
 * to the failed run instead of a bare feed. `metadata.runFailed.runId` lets
 * the run panel's "Review approval" CTA correlate its deep-link to this row
 * even after supersession (see `getNotificationRunReference`).
 */
export function buildRunFailedNotificationInput(input: {
  runId: string;
  runTitle?: string | null;
  href?: string;
  error?: string | null;
}): NotificationInput {
  const name = input.runTitle?.trim();
  const subject = name ? `"${name}"` : "A run";
  const detail = input.error?.trim();
  return {
    title: `${subject} failed`,
    body: detail
      ? `The run failed while awaiting your approval: ${detail}`
      : "The run failed while awaiting your approval.",
    kind: "error",
    ...(input.href ? { href: input.href } : {}),
    dedupeKey: runFailedDedupeKey(input.runId),
    metadata: {
      category: RUN_FAILED_CATEGORY,
      runFailed: { runId: input.runId },
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
      // Semantic input-vs-approval discriminator for the COPY (see the builder
      // doc). `deriveRunHitlContext` is the canonical read of "which gate is
      // this run paused on" — the same derivation the run panel polls — and it
      // reproduces the synthetic `setup-<runId>` identity for a setup-field
      // pause. Best-effort like the rest of this path: an unreadable context
      // classifies as an approval, i.e. the pre-existing copy.
      // DESTRUCTURED, like every other dynamic import on this path: a namespace
      // import of this barrel is opaque to the org-write boundary gate, which
      // then has to assume the module's writers are reachable from here.
      // `.then(...)` (not a bare call) so a synchronous throw is caught too:
      // the copy refinement must never be able to suppress the notification.
      const { deriveRunHitlContext } = await import("@cinatra-ai/agents");
      const derived =
        reason === "pending_approval"
          ? await Promise.resolve()
              .then(() => deriveRunHitlContext(run))
              .catch(() => null)
          : null;
      // THE RUN'S OWN MOMENT RIDES ALONG (cinatra#2928). The row in hand states
      // which lifecycle moment it is waiting at, so the discriminator reads
      // that instead of re-deriving it from the shape of the pause. The derived
      // context stays beneath it: a run created before the column existed, and
      // a wait whose context is the only thing readable, both still classify.
      const interrupt =
        derived === null && run.lifecycleMoment == null
          ? null
          : { ...(derived ?? {}), lifecycleMoment: run.lifecycleMoment ?? null };
      const { resolveAgentRunHref, createNotificationForRecipient } =
        await import("@cinatra-ai/notifications/server");
      // Canonical run deep-link (templateId → packageName). Undefined for an
      // unresolvable run → a still-durable but link-less notification.
      const runHref = await resolveAgentRunHref({ runId });
      // WHERE THIS NOTIFICATION LANDS (cinatra#2729).
      //
      // A run started in a conversation plays its whole lifecycle there, so
      // "needs your input" has to return the reader to that conversation and
      // its live card; the run page is a second copy of the same gate. ONLY the
      // input wait lands there — an approval gate is a review, and the run page
      // is where a review is taken.
      //
      // Best-effort, like every other refinement on this path: no resolvable
      // conversation (a run started outside chat, a turn not yet persisted, a
      // store that cannot answer) keeps the run page, the pre-existing
      // destination.
      //
      // The classification is DERIVED here and never stated by the caller: every
      // caller of this seam is `transitionRunStatus`, which knows only that a
      // status changed. The one wait that states its own flavour — the
      // recommendation hold, which carries no interrupt to derive from — enters
      // through `onEnterRecommendationHold` below instead (cinatra#2838 dropped the
      // unused caller-supplied field from this seam).
      //
      // AND THE REVIEW LANDS THERE TOO (cinatra#2930, epic #2926 W3). The plan
      // states the destination for both in one sentence — "the notification
      // links to the conversation the run was started from — for the review as
      // for a question — and to the run page otherwise" — so the predicate is
      // `waitNotificationLandsInConversation`, which asks WHERE, while
      // `classifyRunWaitInterrupt` goes on answering WHAT THE COPY IS. A review
      // is still an approval in every word the reader sees; only the link moves.
      let href = runHref;
      if (waitNotificationLandsInConversation(interrupt)) {
        const { findChatConversationPathForAgentRun } = await import(
          "@/lib/assistant-thread-store"
        );
        const conversationHref = await Promise.resolve()
          .then(() => findChatConversationPathForAgentRun(runId))
          .catch(() => null);
        if (conversationHref) href = conversationHref;
      }
      await createNotificationForRecipient(
        { kind: "user", userId },
        buildRunAwaitingHumanNotificationInput({
          runId,
          reason,
          runTitle: run.title,
          href,
          interrupt,
        }),
      );
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not emit notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },

  // cinatra#2066 C2 — a lifecycle auto-gate opened. Mirror of onEnterHumanWait
  // but WITHOUT the wait-status guard: an auto-gate's producing run is NOT parked
  // on `pending_approval` (the orchestration path creates the gate + a
  // continuation park and leaves the run's status untouched), so re-deriving
  // "still waiting?" from run status would wrongly suppress the emit. Best-effort.
  //
  // THE WRITE IS FENCED (cinatra#2864). Every other emitter in this module writes
  // on a fact that already happened and cannot un-happen (a committed status
  // transition, a created run). An auto-gate is different: the gate it announces
  // can reach a terminal decision at any instant, and that decision is the ONLY
  // event that ever clears this row. A write that lands after it is stale forever
  // — the bell keeps an entry that opens onto "This review is no longer open".
  //
  // Ordering the check before the write does not help: the check is over the
  // moment it returns, and the earlier posture here (an awaited emit, on the
  // reasoning that nobody can decide a gate born microseconds ago) was a timing
  // argument, not an ordering one. Three of the four opening paths now reaching
  // this seam are decided by MACHINERY — an auto-approving policy, a repair
  // successor, a verification reopen — which does not wait to be told.
  //
  // So the check IS the write. `buildAutoGateNotificationFence` supplies a
  // `SELECT … FOR UPDATE` of the gate matched on (run, task, status='pending');
  // the insert is driven from its rows in ONE statement on one connection. That
  // gives both directions at once:
  //
  //   ALREADY DECIDED — a gate that resolved before this emit ran (or never
  //     existed, or belongs to another run) yields no guard row and therefore no
  //     notification. Nothing upstream has to be trusted: the gate table decides.
  //   THE RACE — `FOR UPDATE` takes the gate's row lock, the same lock
  //     `commitReviewDecision` takes for its terminal CAS, and that CAS commits
  //     before its clear runs. Open and resolve therefore serialise: either we
  //     commit first and the clear finds our row, or the decision commits first
  //     and our guard, re-evaluated against the new row version under READ
  //     COMMITTED, matches nothing. There is no interleaving left in which the
  //     clear precedes the write it was meant to remove.
  //
  // Fenced HERE, in the one host handler, and not in any of the four callers:
  // every opening path reaches this through `dispatchAutoGateOpen` with the same
  // two ids, so there is no path-by-path variant to keep in step.
  async onAutoGateOpen({ runId, reviewTaskId }) {
    try {
      await import("@/lib/notifications-host");
      // No actor argument → the store's access-gate is bypassed (this runs on the
      // orchestration sweep, which has no session). Reads `runBy` (the initiator,
      // the reviewer-resolvable audience) + `title` to address + name the row.
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // No initiator (a system-/trigger-launched or synthetic orphan run) → no one
      // to notify.
      if (!userId) return;
      const { buildAutoGateNotificationFence } = await import(
        "@cinatra-ai/agents/run-wait-notifier"
      );
      const { resolveAgentRunHref, createNotificationForRecipient } =
        await import("@cinatra-ai/notifications/server");
      // The gate-side SQL comes from the package that OWNS the gate table; this
      // module is only the translator that knows both vocabularies (and is the one
      // place that can reach both tables on a single connection).
      const gateFence = buildAutoGateNotificationFence({
        schema: appSchemaName(),
        runId,
        reviewTaskId,
      });
      // Canonical run deep-link (templateId → packageName). Undefined for an
      // unresolvable run → a still-durable but link-less notification.
      const href = await resolveAgentRunHref({ runId });
      await createNotificationForRecipient(
        { kind: "user", userId },
        buildAutoGateOpenNotificationInput({
          runId,
          reviewTaskId,
          runTitle: run.title,
          href,
        }),
        {
          // Single, already-resolved recipient: the fence takes ONE gate row lock
          // for ONE insert. (A fenced write with an expanded roster would take the
          // lock once per recipient, in separate statements — correct, but not a
          // shape any caller needs today.)
          recipientUserIds: [userId],
          fence: {
            values: gateFence.values,
            precondition: gateFence.guard,
          },
        },
      );
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not emit auto-gate-open notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },

  // cinatra#2066 C2 — the auto-gate reached a terminal decision: hard-delete the
  // per-(run, task) row. Idempotent (a delete that names no row is a no-op).
  async onAutoGateResolved({ runId, reviewTaskId }) {
    try {
      await import("@/lib/notifications-host");
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      if (!userId) return;
      // cinatra#2882 — the ASYNC seam. The synchronous twin parks this thread
      // on `Atomics.wait` for the whole round trip (up to
      // POSTGRES_SYNC_TIMEOUT_MS, 30s), freezing every timer, abort listener
      // and microtask in the process; this handler is already `async`, so it
      // was paying that for nothing. Same statement, same key-scoped guard, and
      // the same settle-or-throw ceiling — the seam bounds the checkout and its
      // own wait for an answer, client-side, so the bound holds behind a
      // connection pooler too (see `@/lib/postgres-async`). A database that
      // never answers still rejects into the best-effort catch below instead of
      // leaving this handler's promise pending forever.
      const { deleteNotificationsByDedupeKeyForUserAsync } = await import(
        "@cinatra-ai/notifications/server"
      );
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId,
        dedupeKey: autoGateOpenDedupeKey(runId, reviewTaskId),
      });
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not clear auto-gate-open notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },

  // cinatra#2835 — a run-start recommendation HOLD parked a run.
  //
  // THE WRITE IS FENCED. Every other emitter in this module writes on a fact that
  // already happened and cannot un-happen (a committed status transition, a
  // created gate). A hold is different: the park it names can go terminal at any
  // instant, and because a hold moves no run status, the park's own transition is
  // the ONLY event that ever clears this row. A write that lands after it is stale
  // forever. Ordering the check before the write does not help — the check is over
  // the moment it returns.
  //
  // So the check IS the write. `buildHoldNotificationFence` supplies a
  // `SELECT … FOR UPDATE` of the park matched on (id, run, checkpoint,
  // status='parked'); the insert is driven from its rows inside one transaction on
  // one connection. That gives two properties at once:
  //
  //   FABRICATION (finding 2) — an invented park id, a park belonging to another
  //     run, an auto-gate `review` park, or an already-terminal park all yield no
  //     guard row and therefore no notification. Nothing upstream has to be
  //     trusted, and no cast can help: the park table decides.
  //   TOCTOU (finding 1) — `FOR UPDATE` takes the park's row lock, which is the
  //     same lock `sweepParks`' `status = 'parked'` CAS must take. Enter and sweep
  //     therefore serialise: either we commit first and the sweep's clear finds our
  //     row, or the sweep commits first and our guard, re-evaluated against the new
  //     row version, matches nothing. There is no interleaving left in which the
  //     clear precedes the write it was meant to remove.
  //
  // The fence's `mark` records `hold_notification = 'live'` on the same park in the
  // same statement, which is what makes the matching clear RETRYABLE (finding 3):
  // see `onClearRecommendationHold` below. It is gated on the INSERT's `RETURNING`
  // output (cinatra#2838), because a guard row does not by itself mean a row was
  // written: the insert also carries `ON CONFLICT … DO NOTHING`, and an initiator
  // who already holds a row on this run's key writes nothing. Marking `live` there
  // would have claimed a row no park id of this hold's ever reached, and the
  // park-scoped clear below would then match nothing and ack the obligation as
  // discharged — a hold announced to nobody, recorded as announced.
  //
  // `waitKind: "input"` and the conversation deep-link are the #2729 ruling for a
  // held run (it carries no HITL interrupt to derive a classification from), and
  // `reason: "pending_input"` is the run's ACTUAL status — presentation and
  // destination only, no consumer's state, filter or route sees anything new.
  async onEnterRecommendationHold({ runId, parkId }) {
    try {
      await import("@/lib/notifications-host");
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // No initiator (system-/trigger-launched run) → no one to notify, and the
      // park stays `hold_notification = 'none'`: nothing written, nothing owed.
      if (!userId) return;
      const { buildHoldNotificationFence } = await import(
        "@cinatra-ai/agents/run-wait-notifier"
      );
      const {
        resolveAgentRunHref,
        createNotificationForRecipient,
        NOTIFICATION_WRITE_CTE,
      } = await import("@cinatra-ai/notifications/server");
      // The park-side SQL comes from the package that OWNS the park table; this
      // module is only the translator that knows both vocabularies (and is the one
      // place that can reach both tables on a single connection). The insert's CTE
      // name travels the same way — the notifications package owns it, and the
      // park package's `mark` gates itself on it (cinatra#2838).
      const holdFence = buildHoldNotificationFence({
        schema: appSchemaName(),
        parkId,
        runId,
        insertedCte: NOTIFICATION_WRITE_CTE,
      });
      const runHref = await resolveAgentRunHref({ runId });
      // A held run belongs to the conversation it was started in — the same
      // destination an unanswered input field gets. Best-effort: no resolvable
      // conversation keeps the run page, the pre-existing destination.
      const { findChatConversationPathForAgentRun } = await import(
        "@/lib/assistant-thread-store"
      );
      const conversationHref = await Promise.resolve()
        .then(() => findChatConversationPathForAgentRun(runId))
        .catch(() => null);
      await createNotificationForRecipient(
        { kind: "user", userId },
        buildRunAwaitingHumanNotificationInput({
          runId,
          reason: "pending_input",
          runTitle: run.title,
          href: conversationHref ?? runHref,
          waitKind: "input",
          holdParkId: parkId,
        }),
        {
          // Single, already-resolved recipient: the fence takes ONE park row lock
          // for ONE insert. (A fenced write with an expanded roster would take the
          // lock once per recipient, in separate transactions — correct, but not a
          // shape any caller needs today.)
          recipientUserIds: [userId],
          fence: {
            values: holdFence.values,
            precondition: holdFence.guard,
            after: [holdFence.mark],
          },
        },
      );
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not emit recommendation-hold notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },

  // cinatra#2835 — the hold ended: hard-delete the row its enter wrote.
  //
  // Scoped to the park id the row carries, not just the run's per-run key: this
  // clear can be a RETRY driven by a sweep long after the fact, and by then the key
  // may legitimately belong to a different, still-live wait on the same run. A hold
  // only ever deletes its own row.
  //
  // The boolean is the sweeper's ACK, and it is only ever `true` for a delete that
  // actually committed — a throw returns `false` and the park keeps its
  // `hold_notification = 'live'` obligation for the next sweep. "Matched no row" is
  // still `true`: the obligation is discharged either way, and the delete is
  // idempotent by construction.
  async onClearRecommendationHold({ runId, parkId }) {
    try {
      await import("@/lib/notifications-host");
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // The row is addressed by (user, key, park). Without the initiator there is
      // no address — and no row either: the enter writes only for a resolvable
      // initiator, so a park marked `live` always had one. An unreadable run here
      // is a purged run, and retrying forever would never find it, so the
      // obligation is retired rather than left to spin.
      if (!userId) return true;
      // cinatra#2882 — the ASYNC seam, same as the three status-transition
      // clears above. The synchronous twin parks this thread on `Atomics.wait`
      // for the whole round trip (up to POSTGRES_SYNC_TIMEOUT_MS, 30s), freezing
      // every timer, abort listener and microtask in the process; this handler is
      // already `async`, and it runs on the park SWEEP — a loop over held parks,
      // so the freeze was once per obligation in a batch. Same statement, same
      // park-id narrowing, and the seam's own settle-or-throw ceiling, so a
      // database that never answers rejects into the catch below instead of
      // leaving the sweeper's promise pending forever.
      const { deleteHoldNotificationForUserAsync } = await import(
        "@cinatra-ai/notifications/server"
      );
      // `return await`, NOT a bare `return` of the promise. Returning it
      // unawaited would settle this async function WITH that promise, and a
      // rejection would then bypass the `catch` below entirely — the sweeper
      // would get a rejected promise where the contract says it gets `false`,
      // and the obligation this park is owed would surface as a throw out of a
      // best-effort notifier. Awaiting keeps the failure inside the handler that
      // is supposed to absorb it and turn it into "not acked, sweep again".
      return await deleteHoldNotificationForUserAsync({
        userId,
        dedupeKey: runAwaitingHumanDedupeKey(runId),
        holdParkId: parkId,
      });
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not clear recommendation-hold notification:",
        err instanceof Error ? err.message : err,
      );
      return false;
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
      // cinatra#2882 — async seam; see onAutoGateResolved above.
      const { deleteNotificationsByDedupeKeyForUserAsync } = await import(
        "@cinatra-ai/notifications/server"
      );
      await deleteNotificationsByDedupeKeyForUserAsync({
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

  // cinatra#2413 — the run left a human-wait state because it FAILED (never a
  // human decision). Supersedes the plain delete-only `onLeaveHumanWait`
  // above: still clears the now-stale run-awaiting-human row, but ALSO mints
  // a durable run-failure notification in its place — so the feed is never
  // silent about a run that died while a human was told to review it. Both
  // writes are best-effort, mirroring every other emitter in this module; a
  // notification failure can never fail the underlying status transition.
  async onHumanWaitFailed({ runId }) {
    try {
      await import("@/lib/notifications-host");
      // No actor argument -> the store's access-gate block is bypassed (this
      // runs on the worker / status seam, which has no session). Reads
      // `runBy` (the initiator) + `title` + `error` to address, name, and
      // detail the notification.
      const { readAgentRunById } = await import("@cinatra-ai/agents");
      const run = await readAgentRunById(runId);
      const userId = run?.runBy;
      // No initiator (system-/trigger-launched run) -> no one to notify. The
      // stale awaiting-human row (if any) was written to the SAME initiator
      // check in onEnterHumanWait, so there is nothing to clear either.
      if (!userId) return;
      const {
        resolveAgentRunHref,
        createNotificationForRecipient,
        // cinatra#2882 — async seam; see onAutoGateResolved above.
        deleteNotificationsByDedupeKeyForUserAsync,
      } = await import("@cinatra-ai/notifications/server");
      // Clear the resolved (now-stale) awaiting-human row FIRST — same
      // idempotent delete-by-key primitive as onLeaveHumanWait — so a reader
      // can never observe both rows at once. Best-effort like the rest of
      // this module: an insert-then-swallowed-delete-error still leaves the
      // durable failure row behind (the awaiting-human row is a delete-only
      // key that a future onEnterHumanWait call would collide on anyway).
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId,
        dedupeKey: runAwaitingHumanDedupeKey(runId),
      });
      const href = await resolveAgentRunHref({ runId });
      await createNotificationForRecipient(
        { kind: "user", userId },
        buildRunFailedNotificationInput({
          runId,
          runTitle: run.title,
          href,
          error: run.error,
        }),
      );
    } catch (err) {
      console.warn(
        "[run-awaiting-human] could not emit run-failure notification:",
        err instanceof Error ? err.message : err,
      );
    }
  },
};
