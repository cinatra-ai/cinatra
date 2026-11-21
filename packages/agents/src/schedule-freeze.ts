// ---------------------------------------------------------------------------
// THE FIRED-ONE-OFF FREEZE, IN A MODULE WITH NO DIRECTIVE (cinatra#3189).
//
// Both page hosts of the schedule step read it: the run page
// (`instance-screens.tsx`) and the review page, whose route is a SERVER
// component. A predicate exported from a "use client" module cannot be called
// on the server, so the one definition lives here, imports nothing, and is
// re-exported by `instance-screens.tsx` for its existing callers.
// ---------------------------------------------------------------------------

/**
 * Has this run's OWN schedule already fired, so that it can no longer be changed
 * here? (cinatra#2980)
 *
 * Plan (A) §7.2 item 4 (amended 2026-08-25): "You can change the schedule this
 * way for as long as it has not fired; once a one-off has fired it cannot be
 * changed, and a change to a recurring schedule applies to its future runs."
 *
 * **Run right after setup** is a one-off, and its row is `immediate`. The screen
 * used to read that word as "no schedule to speak of" and kept offering the
 * form, so a finished run's own trigger row could be replaced with a recurring
 * schedule — the thing the plan's sentence forbids. The rule is read off the
 * TRIGGER, exactly as the server reads it:
 *
 *   - `releasedAt` is the fired stamp — written when the gate opens, for an
 *     immediate fire as much as for a scheduled one. It is the schedule's own
 *     record, never the run's status, which moves for reasons of its own.
 *   - everything that is NOT recurring is a one-off. Written this way round, a
 *     one-off kind added later is frozen by default instead of slipping through
 *     unnamed, which is how `immediate` slipped through.
 *   - a RECURRING schedule is never frozen by a fire: plan (A) §7.2 keeps its
 *     scheduler editable, "and a change applies to its future runs".
 *
 * The same predicate the server enforces (`setRunTriggerForActor`'s fired-one-off
 * guard), so the screen never offers what the server would refuse.
 */
export function shouldFreezeFiredOneOffSchedule(
  trigger: { triggerType: string; releasedAt: Date | null } | null,
): boolean {
  return (
    trigger !== null &&
    trigger.triggerType !== "recurring" &&
    trigger.releasedAt !== null
  );
}
