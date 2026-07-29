/**
 * The lifecycle-interceptions ACTIVATION switches (cinatra#2039 / #2067, epic
 * #2037), flipped to their ruled END STATE by the owner decision of 2026-07-27
 * recorded on cinatra#2047: BOTH switches are now DEFAULT-ON with an explicit
 * opt-out.
 *
 * S0 (#2038) landed the policy lattice, the produced-event outbox, the gate
 * store, and every continuation/repair/batch contract fenced — with NO
 * production consumers. S1 wired those consumers (emitters at the local write
 * choke points, a policy-matched auto-gate outbox consumer, and the delivery /
 * expiry / disposition / dead-letter workers) behind a switch that defaulted
 * OFF while the slice was being built out. That build-out is complete, so the
 * switch now carries the epic's intended posture: the machinery RUNS unless a
 * deployment deliberately turns it off.
 *
 * ACTIVATION GRAMMAR (both switches, identical): the value is trimmed and
 * lower-cased; the single literal `off` DEACTIVATES; every other value —
 * including unset, empty, `on`, `true`, `0` — leaves the switch ACTIVE. This
 * is the exact mirror of the pre-flip grammar (where only the literal `on`
 * activated), so a deployment that already sets `on` keeps working unchanged
 * and the only way to get the old inert posture is to say `off` out loud.
 *
 * The review-orchestration switch is read at exactly three seams:
 *   - the local write EMITTERS (createSemanticArtifact / dashboard twin) skip
 *     the same-tx produced-event INSERT when it is off;
 *   - the BOOT seed skips seeding the orchestration maintenance loop when off;
 *   - the orchestration CONSUMER short-circuits when off (defence in depth — a
 *     manually-enqueued tick is a no-op).
 *
 * PURE (no DB / server-only) so both the src/lib emitters and the
 * packages/agents store can import it without a package boundary cost, and so
 * a test can force it on/off deterministically via the env.
 */

/** The single literal that DEACTIVATES a lifecycle activation switch
 * (case-insensitive, surrounding whitespace trimmed). */
export const LIFECYCLE_ACTIVATION_OPT_OUT_VALUE = "off";

/**
 * The shared default-ON reader. Unset / empty / anything that is not the
 * literal opt-out ⇒ ACTIVE. Reads `process.env` on every call (never memoised)
 * so a boot-time change and a test override both take effect without a module
 * reload.
 */
function isActiveUnlessOptedOut(envName: string): boolean {
  return (
    (process.env[envName] ?? "").trim().toLowerCase() !== LIFECYCLE_ACTIVATION_OPT_OUT_VALUE
  );
}

/** The env var that controls the S1 review-orchestration slice. DEFAULT-ON:
 * `"off"` (case-insensitive, trimmed) deactivates; anything else — including
 * unset — leaves it ACTIVE. A single global switch, not a per-org one: org
 * scoping is expressed through the S0 policy lattice (an org bound / silence),
 * which the consumer already honours; this switch only decides whether the
 * machinery RUNS at all. */
export const LIFECYCLE_REVIEW_ORCHESTRATION_ENV = "CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION";

/**
 * Whether S1 review orchestration is active. DEFAULT ON — a deployment that
 * wants the pre-flip inert posture must set
 * `CINATRA_LIFECYCLE_REVIEW_ORCHESTRATION=off` explicitly.
 */
export function isLifecycleReviewOrchestrationActive(): boolean {
  return isActiveUnlessOptedOut(LIFECYCLE_REVIEW_ORCHESTRATION_ENV);
}

/**
 * The env var that controls the run-start RECOMMENDATION CHIP-ROW hold
 * (cinatra#2067, epic #2037 C3). The S3 recommendation ENGINE (headless
 * auto-apply) has always been live — inert for a silent org because the lattice
 * default is `humanPresent:false ⇒ skip`. The C3 human surface PARKS every
 * human-present run whose recommendation checkpoint fires (the lattice default
 * for humanPresent). DEFAULT-ON per the #2047 ruling: `"off"` (case-insensitive,
 * trimmed) deactivates and restores the pre-flip behaviour, where
 * `maybeHoldRunForRecommendation` returns `held:false` and every run dispatches
 * unheld (headless auto-apply byte-identical); anything else — including unset —
 * leaves it ACTIVE. Read each call (never memoised) so a boot change / a test
 * override take effect without a module reload.
 */
export const LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV = "CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW";

/**
 * Whether the run-start recommendation chip-row hold is active. DEFAULT ON — a
 * deployment that wants no run-start hold must set
 * `CINATRA_LIFECYCLE_RECOMMENDATION_CHIP_ROW=off` explicitly.
 */
export function isRecommendationChipRowHoldActive(): boolean {
  return isActiveUnlessOptedOut(LIFECYCLE_RECOMMENDATION_CHIP_ROW_ENV);
}
