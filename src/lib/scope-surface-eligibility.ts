/**
 * THE PER-SCOPE ELIGIBILITY LOADER (cinatra#2808, per-scope surfaces S2).
 *
 * "Eligibility loader (net-new): two arms off one policy snapshot — the actor
 *  can see/invoke the package AND a generic member of the represented scope
 *  could."
 *
 * The Assistants and Agents tabs of a scope page answer ONE question about
 * every installed package: is it reachable HERE, from the vantage the reader is
 * looking at? That is deliberately not the same question `/agents` and
 * `/assistants` ask — those are the actor's own global set. A scope page shows
 * the SCOPE's set, narrowed to what the actor may also reach, so both arms have
 * to hold:
 *
 *   ACTOR   — the platform's own access evaluation for this principal. Handed
 *             in as `actorMayUse`, already given the policy value below, so
 *             this module never takes a second read of its own.
 *   VANTAGE — `policyFieldAdmitsScopeVantage` over the SAME field that op
 *             reads, which answers "could a generic member positioned at
 *             exactly this scope reach it".
 *
 * ONE POLICY SNAPSHOT. `policyFor` is read exactly ONCE per install and the one
 * value is handed to both arms, exactly as `installed-catalog-read.ts` does it —
 * so a concurrent policy edit can never combine an old actor-allow with a new
 * vantage-allow.
 *
 * PURE. No I/O, no `server-only`, no store imports: the reads are the caller's
 * (they differ per surface), and the RULES are here, where a fixture can drive
 * every one of them. The only import is the platform's own pure vantage
 * projection, so this module adds no route-graph weight beyond it.
 *
 * ── THE FIVE SCOPE RULES ───────────────────────────────────────────────────
 *   personal      the actor's invocable set (a personal scope has exactly one
 *                 member — the actor — so the vantage arm asks the same
 *                 question the actor arm already answered).
 *   organization  exact-org installs.
 *   team          exact-team + exact-org (never another team's install).
 *   project       exact-project installs + non-hidden project bindings +
 *                 exact-org. A HIDDEN binding never surfaces.
 *   workspace     the epic's normative `WorkspaceVantage` (#2806): the union
 *                 over every member organization, deduped at package level,
 *                 each row keeping its eligible concrete execution
 *                 organizations (the launch-organization contract; this slice
 *                 owns candidate production).
 *
 * An organization-NULL workspace/platform row is above every organization and
 * is admitted ONCE, with no concrete execution organization — the workspace
 * launch then requires an explicit selection from the vantage.
 */
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy-types";
import type { ExtensionOwnerLevel } from "@cinatra-ai/extensions/canonical-types";
import {
  policyFieldAdmitsScopeVantage,
  type AccessScopeVantage,
} from "@cinatra-ai/extensions/access-scope-vantage";

// ---------------------------------------------------------------------------
// THE WORKSPACE VANTAGE — the epic's conformance anchor, owned by this slice.
// ---------------------------------------------------------------------------

/** One member organization of the workspace vantage, with what the actor may
 *  see inside it — NOT every team/project in the tenant. */
export type WorkspaceOrganizationVantage = {
  readonly orgId: string;
  readonly teamIds: readonly string[];
  readonly projectIds: readonly string[];
};

/**
 * "At read time, the workspace vantage consists of the actor's personal scope
 *  plus every non-archived organization for which the actor has a current
 *  `public.member` row."
 *
 * S4 (#2810) and S5 (#2811) consume THIS value; they keep their own domain
 * readers. `activeOrganizationId` is not part of it, by contract.
 */
export type WorkspaceVantage = {
  readonly userId: string;
  readonly organizations: readonly WorkspaceOrganizationVantage[];
};

/** The reads the builder needs, injected so the conformance fixtures can drive
 *  membership revocation, archival and an active-org switch without a session. */
export type WorkspaceVantageDeps = {
  /** Every organization the actor holds a current member row for. */
  readMemberOrganizations(
    userId: string,
  ): Promise<readonly { readonly orgId: string; readonly archived?: boolean }[]>;
  /** The teams of that organization this actor may see. */
  readVisibleTeams(userId: string, orgId: string): Promise<readonly string[]>;
  /** The projects of that organization this actor may see. */
  readVisibleProjects(userId: string, orgId: string): Promise<readonly string[]>;
};

/**
 * Build the workspace vantage for an actor.
 *
 * `activeOrganizationId` is ACCEPTED and deliberately IGNORED: the contract is
 * that it "never adds, removes, or selects a member organization", and a caller
 * that has one in hand should not have to decide whether to pass it. A fixture
 * pins that two different values — and none at all — produce the identical
 * vantage.
 */
export async function buildWorkspaceVantage(
  deps: WorkspaceVantageDeps,
  args: { userId: string; activeOrganizationId?: string | null },
): Promise<WorkspaceVantage> {
  void args.activeOrganizationId; // see the docstring: never consulted.
  const memberships = await deps.readMemberOrganizations(args.userId);
  const organizations: WorkspaceOrganizationVantage[] = [];
  for (const membership of memberships) {
    // Archival removes the organization on the next read, exactly like a
    // revoked membership — both are simply absent from what is read here.
    if (membership.archived) continue;
    const [teamIds, projectIds] = await Promise.all([
      deps.readVisibleTeams(args.userId, membership.orgId),
      deps.readVisibleProjects(args.userId, membership.orgId),
    ]);
    organizations.push({
      orgId: membership.orgId,
      teamIds: [...teamIds],
      projectIds: [...projectIds],
    });
  }
  return { userId: args.userId, organizations };
}

// ---------------------------------------------------------------------------
// THE ELIGIBILITY READ.
// ---------------------------------------------------------------------------

/** The scope a tab is being read FOR — the VIEWED one, never the active one. */
export type ScopeEligibilityScope =
  | { readonly kind: "personal"; readonly orgId: string }
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "team"; readonly orgId: string; readonly teamId: string }
  | { readonly kind: "project"; readonly orgId: string; readonly projectId: string }
  | { readonly kind: "workspace" };

/** One canonical install row, projected to what the rules and the cards need. */
export type ScopePackageInstall = {
  readonly installId: string;
  readonly packageName: string;
  readonly displayName: string;
  readonly description?: string | null;
  /** Already-resolved version text; the card renders it as it arrives. */
  readonly version: string;
  readonly status: "active" | "locked" | "archived";
  readonly ownerLevel: ExtensionOwnerLevel;
  readonly ownerId: string | null;
  readonly organizationId: string | null;
  /** An assistant package belongs to the Assistants tab, everything else to
   *  the Agents tab ("Non-assistant agent packages" / "Assistant packages
   *  only"). */
  readonly isAssistant: boolean;
};

/**
 * A project's binding of a package (`project_agent_template_bindings`), whose
 * `visibility` column carries exactly these three words.
 *
 *   project-private  the project's OWN install — an exact-project install.
 *   visible          a non-hidden binding of an ambient package.
 *   hidden           never surfaces, on any tab.
 */
export type ScopeProjectBinding = {
  readonly packageName: string;
  readonly projectId: string;
  readonly visibility: "visible" | "hidden" | "project-private";
};

/** One eligible package, as the tabs render it. */
export type ScopeEligibilityRow = {
  readonly packageName: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly version: string;
  /** `active|locked` — an archived row is never eligible. */
  readonly status: "active" | "locked";
  readonly isAssistant: boolean;
  /**
   * The eligible CONCRETE execution organizations kept after package-level
   * display dedupe (the epic's launch-organization contract). One entry →
   * the launch selects it directly; several → the launch requires an explicit
   * selection; EMPTY → an organization-NULL-only package, whose launch selects
   * from the `WorkspaceVantage`. Non-workspace scopes carry their own single
   * organization.
   */
  readonly executionOrganizationIds: readonly string[];
};

export type ListScopeEligiblePackagesInput = {
  readonly scope: ScopeEligibilityScope;
  readonly actorUserId: string;
  readonly installs: readonly ScopePackageInstall[];
  /** THE ONE SNAPSHOT: read once per install, handed to both arms. */
  readonly policyFor: (install: ScopePackageInstall) => AgentAuthPolicy;
  /** The ACTOR arm, over the value this module just read. */
  readonly actorMayUse: (install: ScopePackageInstall, policy: AgentAuthPolicy) => boolean;
  /** The viewed project's bindings (project scope only). */
  readonly bindings?: readonly ScopeProjectBinding[];
  /** Required for the workspace scope; ignored elsewhere. */
  readonly vantage?: WorkspaceVantage;
};

const LIVE_STATUSES = new Set(["active", "locked"]);

/** Above every organization: a workspace/platform row with no organization. */
function isTenantWide(install: ScopePackageInstall): boolean {
  return (
    (install.ownerLevel === "workspace" || install.ownerLevel === "platform") &&
    install.organizationId === null
  );
}

/** The organization's OWN install — not a user's and not a team's. */
function isExactOrg(install: ScopePackageInstall, orgId: string): boolean {
  return (
    install.ownerLevel === "organization" &&
    (install.ownerId === orgId || install.organizationId === orgId)
  );
}

function isExactTeam(install: ScopePackageInstall, orgId: string, teamId: string): boolean {
  return (
    install.ownerLevel === "team" &&
    install.ownerId === teamId &&
    (install.organizationId === null || install.organizationId === orgId)
  );
}

/** The STRUCTURAL arm: does this scope REACH the row at all, before any policy
 *  is consulted? */
function scopeReaches(
  install: ScopePackageInstall,
  scope: Exclude<ScopeEligibilityScope, { kind: "workspace" }>,
  bindings: readonly ScopeProjectBinding[],
): boolean {
  if (isTenantWide(install)) return true;
  switch (scope.kind) {
    case "personal":
      // The actor's invocable set: the actor arm is the whole rule here.
      return true;
    case "organization":
      return isExactOrg(install, scope.orgId);
    case "team":
      return isExactTeam(install, scope.orgId, scope.teamId) || isExactOrg(install, scope.orgId);
    case "project": {
      const here = bindings.filter(
        (b) => b.packageName === install.packageName && b.projectId === scope.projectId,
      );
      // HIDDEN NEVER SURFACES — and it is a VETO, not merely an absent grant.
      // A hidden binding is the project's own curation decision about an
      // ambient package, so it has to outrank the exact-org arm that would
      // otherwise carry that same package straight back in; a binding that only
      // failed to grant would make "hidden" mean nothing for every org-wide
      // package, which is exactly the set a project curates.
      if (here.some((b) => b.visibility === "hidden")) return false;
      // The project's OWN install (`project-private`) and a non-hidden binding
      // (`visible`) both reach; so does the organization's own install.
      return here.length > 0 || isExactOrg(install, scope.orgId);
    }
  }
}

/** The vantage this scope presents to the policy projection. */
function vantageFor(
  scope: Exclude<ScopeEligibilityScope, { kind: "workspace" }>,
): AccessScopeVantage {
  switch (scope.kind) {
    case "personal":
      return { kind: "personal", orgId: scope.orgId };
    case "organization":
      return { kind: "organization", orgId: scope.orgId, scopeId: scope.orgId };
    case "team":
      return { kind: "team", orgId: scope.orgId, scopeId: scope.teamId };
    case "project":
      return { kind: "project", orgId: scope.orgId, scopeId: scope.projectId };
  }
}

function project(
  install: ScopePackageInstall,
  executionOrganizationIds: readonly string[],
): ScopeEligibilityRow {
  return {
    packageName: install.packageName,
    displayName: install.displayName,
    description: install.description ?? null,
    version: install.version,
    status: install.status === "locked" ? "locked" : "active",
    isAssistant: install.isAssistant,
    executionOrganizationIds,
  };
}

function byPackageName(a: ScopeEligibilityRow, b: ScopeEligibilityRow): number {
  return a.packageName.localeCompare(b.packageName);
}

/**
 * The eligible packages of ONE non-workspace scope. Both arms, off one
 * snapshot, in the order that spends nothing on a row the scope cannot reach.
 */
function listForConcreteScope(
  input: ListScopeEligiblePackagesInput,
  scope: Exclude<ScopeEligibilityScope, { kind: "workspace" }>,
): ScopeEligibilityRow[] {
  const bindings = input.bindings ?? [];
  const vantage = vantageFor(scope);
  const rows: ScopeEligibilityRow[] = [];
  for (const install of input.installs) {
    if (!LIVE_STATUSES.has(install.status)) continue;
    if (!scopeReaches(install, scope, bindings)) continue;
    // THE ONE SNAPSHOT — read once, given to both arms below.
    const policy = input.policyFor(install);
    // VANTAGE ARM first: pure, so a row the scope could not reach anyway costs
    // the caller's actor evaluation nothing.
    if (!policyFieldAdmitsScopeVantage(policy.runDataVisibility, vantage)) continue;
    if (!input.actorMayUse(install, policy)) continue;
    rows.push(
      project(
        install,
        install.organizationId ? [install.organizationId] : [],
      ),
    );
  }
  return rows;
}

/**
 * The eligible packages of the VIEWED scope, sorted by package name.
 *
 * The workspace arm runs the organization rule once per member organization of
 * the `WorkspaceVantage`, then dedupes at PACKAGE level and keeps each row's
 * eligible concrete execution organizations.
 */
export function listScopeEligiblePackages(
  input: ListScopeEligiblePackagesInput,
): readonly ScopeEligibilityRow[] {
  if (input.scope.kind !== "workspace") {
    // A concrete scope launches in its OWN organization — there is nothing to
    // select, so every row carries exactly that one candidate.
    const orgId = input.scope.orgId;
    return listForConcreteScope(input, input.scope)
      .map((row) => ({ ...row, executionOrganizationIds: [orgId] }))
      .sort(byPackageName);
  }

  const vantage = input.vantage;
  // Fail closed: a workspace read with no vantage sees nothing rather than
  // everything.
  if (!vantage) return [];

  const deduped = new Map<string, { row: ScopeEligibilityRow; orgIds: Set<string> }>();
  for (const org of vantage.organizations) {
    const rows = listForConcreteScope(input, { kind: "organization", orgId: org.orgId });
    for (const row of rows) {
      const existing = deduped.get(row.packageName);
      const orgIds = existing ? existing.orgIds : new Set<string>();
      // An organization-NULL row carries no concrete execution organization —
      // it is admitted ONCE and its launch selects from the vantage.
      for (const orgId of row.executionOrganizationIds) orgIds.add(orgId);
      if (!existing) deduped.set(row.packageName, { row, orgIds });
    }
  }
  return [...deduped.values()]
    .map(({ row, orgIds }) => ({ ...row, executionOrganizationIds: [...orgIds] }))
    .sort(byPackageName);
}
