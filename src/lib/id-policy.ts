// Entity id policy (cinatra#1907): the app mints ONE id format — UUID — for
// every entity row, regardless of which door creates it. App bootstrap code
// always did; better-auth now does too via the `advanced.database.generateId`
// override in src/lib/auth.ts. Before that override, better-auth's default
// generator minted 32-char base62 ids ("legacy nanoids"); those rows remain
// live and valid forever — validators that gate on id shape must accept BOTH
// formats for organizations, teams, users, and members, and must still reject
// arbitrary strings.
//
// packages/* must not import src/lib (dependency direction), so
// packages/agents/src/auth-policy-types.ts duplicates LEGACY_NANOID_RE locally
// with a cross-reference comment. Keep the two in sync.

export const ENTITY_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// better-auth's pre-override default generator: exactly 32 base62 chars.
export const LEGACY_NANOID_RE = /^[a-zA-Z0-9]{32}$/;

/** The single id generator for entity rows (users, orgs, teams, members, …).
 *  Both the bootstrap call sites and the better-auth override consume this so
 *  the policy has one home. */
export function generateEntityId(): string {
  return crypto.randomUUID();
}

/** True when `value` is shaped like a live entity id — canonical UUID or a
 *  legacy better-auth nanoid. A shape check only, never an existence check. */
export function isEntityIdLike(value: string): boolean {
  return ENTITY_UUID_RE.test(value) || LEGACY_NANOID_RE.test(value);
}
