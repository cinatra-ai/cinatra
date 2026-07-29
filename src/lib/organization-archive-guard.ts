import "server-only";

/**
 * App-native archived-organization write guard (cinatra#1942 archive V2 —
 * Decision 5's "bypass audit" deliverable).
 *
 * Better Auth's dispatch-hook endpoint policy (`src/lib/auth.ts`,
 * `hooks.before` — see `@/lib/organization-dispatch-policy`) can only see
 * writes that flow through a Better Auth endpoint. Every APP-NATIVE writer of
 * Better-Auth-owned membership state — `member`, `invitation`, `teamMember`,
 * `session.activeOrganizationId`, `session.activeTeamId` — sits entirely
 * outside that hook and must call this guard directly before it mutates. The
 * team-member actions (`src/app/teams/[teamId]/settings/member-actions.ts`)
 * are the concrete V2 case; the app-native bypass audit (V2 PR body)
 * enumerates every other app-native writer found and either confirms it
 * already calls this guard or documents why it is unreachable / already
 * lifecycle-gated / out of scope by migration doctrine.
 *
 * FAIL-CLOSED ON READ ERROR — unlike the dispatch-hook's per-endpoint SPLIT
 * polarity (Decision 5 / codex r0 finding #6), these are raw app-native
 * writes with NO kernel/DB backstop at all (they bypass org-write-kernel
 * entirely), so "can't verify archived state" must mean REFUSE, not proceed.
 * This mirrors the fail-closed posture the other org-lifecycle guards use
 * (see `readSingleOrgModeStrict` in `@/lib/authz/instance-mode`).
 */

export class OrganizationArchivedError extends Error {
  readonly reason = "org_archived" as const;

  constructor(organizationId: string) {
    super(
      `Organization ${organizationId} is archived — this action is unavailable while archived.`,
    );
    this.name = "OrganizationArchivedError";
  }
}

/**
 * Injectable read seam — the default reads the real `organization` row via
 * drizzle; unit tests supply a fake (same dependency-composition pattern as
 * `@/lib/better-auth-org-hooks`'s `BeforeCreateTeamSlugDeps`). Lazy dynamic
 * import keeps the drizzle/pg module graph out of this module's import-time
 * graph for callers that only need the pure decision shape.
 */
export type ReadOrganizationArchivedAt = (
  organizationId: string,
) => Promise<Date | string | null>;

export async function readOrganizationArchivedAt(
  organizationId: string,
): Promise<Date | string | null> {
  const [{ betterAuthDb, betterAuthOrganizations }, { eq }] = await Promise.all([
    import("@/lib/better-auth-db"),
    import("drizzle-orm"),
  ]);
  const rows = await betterAuthDb
    .select({ archivedAt: betterAuthOrganizations.archivedAt })
    .from(betterAuthOrganizations)
    .where(eq(betterAuthOrganizations.id, organizationId))
    .limit(1);
  // A row this guard cannot find is NOT this guard's concern — every known
  // call site already resolved the organization/team/invitation row itself
  // (its own existence check ran first), so a genuinely missing org here
  // would be a caller bug, not an archived state. Reading "not found" as
  // "not archived" lets the caller's own not-found handling surface instead
  // of a confusing org_archived error.
  return rows[0]?.archivedAt ?? null;
}

/**
 * Throws `OrganizationArchivedError` when the target organization is
 * archived, and — fail-closed — throws a plain `Error` on any read failure
 * (see module doc for why this differs from the dispatch-hook's SPLIT
 * polarity). Resolves (no-op) when the org is active. `readArchivedAt` is
 * injectable for unit tests; production callers use the default.
 */
export async function assertTargetOrgNotArchived(
  organizationId: string,
  readArchivedAt: ReadOrganizationArchivedAt = readOrganizationArchivedAt,
): Promise<void> {
  let archivedAt: Date | string | null;
  try {
    archivedAt = await readArchivedAt(organizationId);
  } catch (err) {
    throw new Error(
      `assertTargetOrgNotArchived: could not verify archived state for organization ${organizationId} — ` +
        `refusing (fail-closed; no downstream fence exists for this app-native write). ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (archivedAt !== null && archivedAt !== undefined) {
    throw new OrganizationArchivedError(organizationId);
  }
}
