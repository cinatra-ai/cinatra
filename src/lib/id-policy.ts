// Entity id policy (cinatra#1907, owner-ratified spec on the issue): the app
// mints ONE id format — UUID — for every auth entity row (user, organization,
// team, member, teamMember), regardless of which door creates it. `entityId()`
// below is the single mint helper: the better-auth `advanced.database.generateId`
// override in src/lib/auth.ts and all five direct production mint paths consume
// it (a grep gate pins this — src/lib/__tests__/entity-id-mint-gate.test.ts).
//
// Live id shapes that must KEEP validating forever (no re-key migration):
//   - canonical UUIDs (this policy, and app bootstrap since day one),
//   - legacy 32-char base62 better-auth ids (the pre-override default
//     generator; LEGACY_NANOID_RE below),
//   - the supported seed namespace (`org-*` / `team-*` / `proj-*` from
//     scripts/seed.mjs; `usr-*`/`mem-*`/`tm-*` exist too but never flow into
//     scope tokens).
// Consequently, scope-token id VALIDATION is format-agnostic (one bounded
// URL-safe grammar in packages/agents/src/auth-policy-types.ts — duplicated
// there because packages/* must not import src/lib); authorization and SQL
// parameterization are the security boundary, not id shape.

export const ENTITY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// better-auth's pre-override default generator: exactly 32 base62 chars
// (no `-`/`_`). Consumed by the breadcrumb id floor (cinatra#1737 rule).
export const LEGACY_NANOID_RE = /^[A-Za-z0-9]{32}$/;

/** The single id mint for auth entity rows (users, orgs, teams, members,
 *  teamMembers). Every new entity row gets a UUID through this helper —
 *  never call crypto.randomUUID() directly for an auth entity id. */
export function entityId(): string {
  return crypto.randomUUID();
}
