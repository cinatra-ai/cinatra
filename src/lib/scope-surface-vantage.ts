/**
 * THE `WorkspaceVantage` BUILDER (cinatra#2808, per-scope surfaces S2).
 *
 * The epic (#2806) names ONE exported builder that every workspace-tier reader
 * consumes, and hands its ownership to this slice: S4 and S5 consume what is
 * built here while keeping their own domain readers. This module is that
 * builder, and nothing else — it is deliberately PURE (no I/O, no
 * `server-only`), so the conformance fixtures the epic names can drive it
 * directly.
 *
 * ── THE CONFORMANCE ANCHOR, RESTATED AS CODE ───────────────────────────────
 * The workspace vantage is the actor's personal scope plus EVERY non-archived
 * organization for which the actor has a current membership row. Within each
 * such organization it carries exactly the teams and projects the actor-visible
 * scope readers admit — never every team or project in the tenant. The reads
 * themselves are the caller's (`readOrgsWithTeamsForUserActiveOnly`,
 * `readProjectsForUser`); this builder folds their results into the one shape
 * the tier's readers share.
 *
 * ── `activeOrganizationId` NEVER PARTICIPATES ──────────────────────────────
 * The anchor is explicit that the session's active organization never adds,
 * removes or selects a member organization. The field is accepted on the input
 * ANYWAY — and ignored — precisely so a fixture can hand the builder two
 * different active organizations and assert the vantage is identical. Leaving
 * it off the input type would make that pin unwritable.
 *
 * FAIL-CLOSED: no user id, no memberships, an archived organization, or a
 * membership row that is not current all yield nothing. A removed membership or
 * an archived organization therefore disappears on the very next read, with no
 * retirement pass of its own.
 */

/** One member organization of the workspace vantage, with its visible scopes. */
export type WorkspaceVantageOrganization = {
  readonly orgId: string;
  /** The teams of this organization the actor-visible team reader admitted. */
  readonly teamIds: readonly string[];
  /** The projects of this organization the actor-visible project reader admitted. */
  readonly projectIds: readonly string[];
};

/** The actor-relative workspace vantage the epic names. */
export type WorkspaceVantage = {
  readonly userId: string;
  /** Every non-archived organization carrying a CURRENT membership row. */
  readonly organizations: readonly WorkspaceVantageOrganization[];
};

/** One membership row as the caller read it. */
export type WorkspaceVantageMembership = {
  readonly orgId: string;
  /** The organization's archive state — an archived organization is dropped. */
  readonly archived?: boolean;
  /**
   * Whether the membership row is CURRENT. Omitted means current (the active
   * readers return only current rows); an explicit `false` is a revoked
   * membership and drops the organization.
   */
  readonly current?: boolean;
};

export type WorkspaceVantageInput = {
  readonly userId: string;
  readonly memberships: readonly WorkspaceVantageMembership[];
  /** Actor-visible team ids per organization (absent → no visible team). */
  readonly teamIdsByOrg?: Readonly<Record<string, readonly string[]>>;
  /** Actor-visible project ids per organization (absent → no visible project). */
  readonly projectIdsByOrg?: Readonly<Record<string, readonly string[]>>;
  /** ACCEPTED AND IGNORED — see the module docstring. */
  readonly activeOrganizationId?: string | null;
};

/** Deduplicate while keeping a deterministic (sorted) order. */
function uniqueSorted(values: readonly string[] | undefined): readonly string[] {
  if (!values || values.length === 0) return [];
  return [...new Set(values.filter((v) => typeof v === "string" && v.length > 0))].sort();
}

/**
 * Build the workspace vantage for an actor.
 *
 * Organizations are returned sorted by id so two reads of the same membership
 * state are byte-identical regardless of the order the readers returned them
 * in — an unstable order would make the tier's own fixtures unpinnable.
 */
export function buildWorkspaceVantage(input: WorkspaceVantageInput): WorkspaceVantage {
  // The session's active organization is read NOWHERE below. Named here so the
  // omission is deliberate and greppable rather than an oversight.
  void input.activeOrganizationId;

  const userId = typeof input.userId === "string" ? input.userId : "";
  if (!userId) return { userId: "", organizations: [] };

  const seen = new Set<string>();
  const organizations: WorkspaceVantageOrganization[] = [];
  for (const membership of input.memberships ?? []) {
    const orgId = membership?.orgId;
    if (typeof orgId !== "string" || orgId.length === 0) continue;
    // An archived organization and a revoked membership are BOTH absences, not
    // muted rows: the tier can never read under an organization it does not
    // return here.
    if (membership.archived === true) continue;
    if (membership.current === false) continue;
    if (seen.has(orgId)) continue;
    seen.add(orgId);
    organizations.push({
      orgId,
      teamIds: uniqueSorted(input.teamIdsByOrg?.[orgId]),
      projectIds: uniqueSorted(input.projectIdsByOrg?.[orgId]),
    });
  }

  organizations.sort((a, b) => a.orgId.localeCompare(b.orgId));
  return { userId, organizations };
}

/** The member organization ids of a vantage, in the vantage's own order. */
export function workspaceVantageOrgIds(vantage: WorkspaceVantage): readonly string[] {
  return vantage.organizations.map((o) => o.orgId);
}

/** Does the vantage carry this organization? (A removed membership is absent.) */
export function workspaceVantageHasOrg(vantage: WorkspaceVantage, orgId: string): boolean {
  return vantage.organizations.some((o) => o.orgId === orgId);
}

/**
 * The concrete organization a scope is READ UNDER, resolved from the actor's own
 * vantage — never from the session's active organization.
 *
 * The vantage is the membership fact: an organization it does not carry is one
 * the actor has no current, non-archived membership in, and a team or project
 * it does not carry is one the actor-visible readers did not return. So this
 * resolution doubles as the membership fence: `null` means "this reader reaches
 * no organization from this scope", and the eligibility read then lists nothing
 * rather than listing another organization's installs.
 *
 * The personal scope is the one arm that consults the session's organization:
 * it is the actor's OWN scope, read under the organization they are working in
 * — and only when the vantage still carries it.
 */
export function resolveVantageOrgForScope(
  vantage: WorkspaceVantage,
  scope: { readonly kind: string; readonly id?: string },
  activeOrganizationId: string | null,
): string | null {
  switch (scope.kind) {
    case "workspace":
      // The workspace tier reads under no single organization.
      return null;
    case "personal":
      return activeOrganizationId && workspaceVantageHasOrg(vantage, activeOrganizationId)
        ? activeOrganizationId
        : null;
    case "organization":
      return scope.id && workspaceVantageHasOrg(vantage, scope.id) ? scope.id : null;
    case "team":
      return vantage.organizations.find((o) => scope.id && o.teamIds.includes(scope.id))?.orgId ?? null;
    case "project":
      return (
        vantage.organizations.find((o) => scope.id && o.projectIds.includes(scope.id))?.orgId ?? null
      );
    default:
      return null;
  }
}
