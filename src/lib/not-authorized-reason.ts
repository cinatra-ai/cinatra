/**
 * What `/not-authorized` says, and why (cinatra#3787).
 *
 * The refusal page carried ONE description for every refusal: the platform-admin
 * sentence the first gated areas needed. A team surface then redirected there
 * and told the reader something false twice over: the reader was the platform
 * admin, and the thing they lacked was a role on the team.
 *
 * So a refusal may name its reason, and the page reads it from an optional
 * `reason` search parameter over a CLOSED set. Anything outside the set (absent,
 * repeated, misspelled, invented by a caller) draws the default sentence
 * unchanged, so a stray link can never put unexpected words on the page.
 *
 * Pure and dependency-free: the page reads it, and any surface that redirects
 * with a reason names its value from here rather than spelling the literal.
 */

/** The reasons a refusal may name. One per redirecting surface that has a
 *  truthful sentence to offer; every other refusal keeps the default. */
export const NOT_AUTHORIZED_REASONS = ["scope-membership"] as const;

export type NotAuthorizedReason = (typeof NOT_AUTHORIZED_REASONS)[number];

/** Today's sentence, word for word. Every refusal that names no reason, and
 *  every reason outside the set, reads exactly this. */
export const DEFAULT_NOT_AUTHORIZED_DESCRIPTION =
  "This area is limited to platform admins. Sign in with the admin account or ask an admin to grant your user the admin role.";

/** The refusal a team surface gives: the reader holds no role on the team. It
 *  names what is missing and who can give it, and it claims nothing about
 *  platform admin, which the reader may well be. */
export const SCOPE_MEMBERSHIP_DESCRIPTION =
  "You are not a member of this team, and you hold no role that manages it. Ask a team admin or an organization admin to give you access.";

const DESCRIPTION_FOR: Record<NotAuthorizedReason, string> = {
  "scope-membership": SCOPE_MEMBERSHIP_DESCRIPTION,
};

/** Is `value` one of the reasons this page knows? */
export function isNotAuthorizedReason(value: unknown): value is NotAuthorizedReason {
  return (
    typeof value === "string" &&
    (NOT_AUTHORIZED_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The description for a raw `reason` search-parameter value. Total: a repeated
 * parameter (an array), an absent one, and an unknown value all read the
 * default.
 */
export function resolveNotAuthorizedDescription(value: unknown): string {
  return isNotAuthorizedReason(value)
    ? DESCRIPTION_FOR[value]
    : DEFAULT_NOT_AUTHORIZED_DESCRIPTION;
}
