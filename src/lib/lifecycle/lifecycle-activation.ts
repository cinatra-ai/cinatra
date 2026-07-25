/**
 * The lifecycle-interceptions REVIEW-ORCHESTRATION activation fence
 * (cinatra#2039, epic #2037 S1).
 *
 * S0 (#2038) landed the policy lattice, the produced-event outbox, the gate
 * store, and every continuation/repair/batch contract FENCED — with NO
 * production consumers. S1 wires those consumers (emitters at the local write
 * choke points, a policy-matched auto-gate outbox consumer, and the delivery /
 * expiry / disposition / dead-letter workers). Turning them all on for every
 * producing agent is the epic's intended END state, but it is a real behaviour
 * change on hot write paths, so S1 ships it behind a SINGLE global activation
 * fence that DEFAULTS OFF: on `origin/main` the emitters add no outbox row and
 * the boot phase seeds no orchestration loop, so the slice is INERT until an
 * operator flips it on (matching the epic's "fenced default-off" posture).
 *
 * The fence is read at exactly three seams:
 *   - the local write EMITTERS (createSemanticArtifact / dashboard twin) skip
 *     the same-tx produced-event INSERT when the fence is off;
 *   - the BOOT seed skips seeding the orchestration maintenance loop when off;
 *   - the orchestration CONSUMER short-circuits when off (defence in depth — a
 *     manually-enqueued tick is a no-op).
 *
 * PURE (no DB / server-only) so both the src/lib emitters and the
 * packages/agents store can import it without a package boundary cost, and so
 * a test can force it on/off deterministically via the env.
 */

/** The env var that activates S1 review orchestration. `"on"` (case-insensitive,
 * trimmed) activates; anything else — including unset — leaves it OFF. A single
 * global switch, not a per-org one: org scoping is expressed through the S0
 * policy lattice (an org bound / silence), which the consumer already honours;
 * this fence only decides whether the machinery RUNS at all. */
export const LIFECYCLE_REVIEW_ORCHESTRATION_ENV = "CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION";

/**
 * Whether S1 review orchestration is active. Reads the env each call (never
 * memoised) so a boot-time flip and a test override both take effect without a
 * module reload. Default OFF: the fence must be EXPLICITLY set to `on`.
 */
export function isLifecycleReviewOrchestrationActive(): boolean {
  return (process.env[LIFECYCLE_REVIEW_ORCHESTRATION_ENV] ?? "").trim().toLowerCase() === "on";
}
