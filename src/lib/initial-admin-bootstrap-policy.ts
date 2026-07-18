// Pure decision core for the ONE-SHOT initial-admin bootstrap (cinatra#1135).
//
// The documented first-run flow is "the first user to register becomes the
// platform admin". That one-shot must be reserved for a REAL PERSON: machine
// accounts a boot seed creates first (the built-in assistant, the dev UAT
// fixture) must neither BE promotable nor COUNT toward "how many users exist".
//
// cinatra#1135 is exactly this failure: the dev-boot UAT fixture
// (`cinatra-uat@example.com`, seeded by `ensureDevConnectActor`) registered as
// a regular `userType='human'` row and was routed through
// `ensureInitialAdminBootstrap`, so on every fresh dev install it was the
// "exactly 1 user" and consumed the slot — the first real registrant landed
// with role=user and every admin-gated setup-wizard save redirected to
// /not-authorized.
//
// Humanness contract: a user row is HUMAN when its "userType" is 'human' or
// NULL (rows predating the column). EVERY other value is a machine account —
// 'assistant' (minted by assistant-agent registration) and the dev UAT fixture type
// below. This module is dependency-free on purpose so the decision is unit-
// testable without the server-only auth graph (same pattern as
// `closed-registration-gate.ts`).

export const HUMAN_USER_TYPE = "human";

/**
 * Dev-only machine userType for the UAT fixture user seeded by
 * `dev-auto-setup.ts` (`ensureDevConnectActor`). Declared here (not in the
 * dev module) so the bootstrap policy and its tests share the single literal.
 */
export const DEV_UAT_FIXTURE_USER_TYPE = "uat-fixture";

/**
 * True when a user row's `userType` marks a real person. NULL/undefined is
 * human (legacy rows predating the column default).
 */
export function isHumanUserRowType(userType: string | null | undefined): boolean {
  return (userType ?? HUMAN_USER_TYPE) === HUMAN_USER_TYPE;
}

/**
 * The one-shot decision: promote exactly when the candidate is HUMAN and the
 * HUMAN user count (machine rows excluded) is exactly 1 — i.e. the candidate
 * is the first real person on the instance. Both arms matter:
 *   - a machine account must never be promoted, even when it is the only
 *     user-shaped row (or when it signs in role-less via getAuthSession while
 *     exactly one human exists);
 *   - a human whose count includes seeded machine rows would never see
 *     count===1 — the caller must supply a HUMANS-ONLY count.
 */
export function isInitialAdminBootstrapEligible(input: {
  /** `userType` of the user being considered for promotion. */
  targetUserType: string | null | undefined;
  /** Count of HUMAN users only (userType 'human' or NULL). */
  humanUserCount: number;
}): boolean {
  return isHumanUserRowType(input.targetUserType) && input.humanUserCount === 1;
}
