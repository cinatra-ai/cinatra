/**
 * THE PER-SCOPE ELIGIBILITY LOADER'S PURE CORE (cinatra#2808, per-scope
 * surfaces S2).
 *
 * "What may this reader reach from THIS scope?" is answered here, and nowhere
 * else, for all five scopes. The module is PURE — no I/O, no `server-only` —
 * exactly as `installed-catalog-eligibility.ts` is pure beside its server read:
 * the read fetches, this decides, so every rule below is directly fixture-
 * driven.
 *
 * ── TWO ARMS OFF ONE POLICY SNAPSHOT ───────────────────────────────────────
 * The precedent is `installed-catalog-read.ts` gate 6 and it is followed to the
 * letter: the stored access policy is read ONCE per install
 * (`arms.policyFor`) and BOTH arms are evaluated against that same value, so a
 * concurrent policy edit can never combine an old actor-allow with a new
 * vantage-allow.
 *
 *   ACTOR   — may this principal reach the package (the platform's own
 *             evaluator, injected).
 *   VANTAGE — could a GENERIC MEMBER positioned at exactly this scope reach it
 *             (`policyFieldAdmitsScopeVantage`, injected).
 *
 * Both arms are INJECTED rather than imported. This module is reached from ten
 * scope-tab routes; the extensions access modules reach the permissions store
 * and its Postgres connection, and the route-graph ratchet measures what each
 * route's graph carries. Injection keeps the decision testable without a DB and
 * keeps the heavy graph on the server reader that already pays for it.
 *
 * ── THE SCOPE REACH RULE, AS THE ISSUE WORDS IT ────────────────────────────
 *   personal      — the actor's invocable set.
 *   organization  — exact-org installs.
 *   team          — exact-team + exact-org.
 *   project       — exact-project installs + non-hidden project bindings +
 *                   exact-org. HIDDEN BINDINGS NEVER SURFACE: a hidden binding
 *                   is not merely ranked lower, it is never a reason a row is
 *                   admitted, and it can never be the only reason either.
 *   workspace     — the epic's `WorkspaceVantage`, applied here: the union over
 *                   every member organization, org-NULL rows admitted once.
 *
 * ── WORKSPACE ROWS KEEP THEIR EXECUTION ORGANIZATIONS ──────────────────────
 * The epic's launch-organization contract makes candidate production this
 * slice's: a workspace row retains its eligible CONCRETE execution
 * organizations AFTER the package-level display dedupe, so the selection step
 * (#2809) has real organizations to choose between rather than a deduped row
 * that lost them. Every other scope produces exactly its own organization.
 */
import type { AccessScopeVantage } from "@cinatra-ai/extensions/access-scope-vantage";

import type { ScopeSurfaceRef } from "./scope-surfaces";
import type { WorkspaceVantage } from "./scope-surface-vantage";

/** The canonical install statuses a scope tab lists — active or locked. */
export const SCOPE_SURFACE_LIVE_STATUSES = ["active", "locked"] as const;
export type ScopeSurfaceStatus = (typeof SCOPE_SURFACE_LIVE_STATUSES)[number];

/**
 * ONE scope binding an install carries.
 *
 * A binding is how a package reaches a scope that is not its row anchor — the
 * project tier has no owner level of its own, so a project's packages are
 * expressed as bindings. `hidden` marks a binding that must never surface a row
 * on the bound scope's tab.
 */
export type ScopeSurfaceBinding = {
  readonly kind: "organization" | "team" | "project";
  readonly id: string;
  readonly hidden?: boolean;
};

/** One live install row, projected to what the scope tabs decide and render. */
export type ScopeSurfaceInstall = {
  readonly installId: string;
  readonly packageName: string;
  readonly displayName: string;
  readonly description: string | null;
  /** The row's own anchor — `null` for a workspace/platform (org-NULL) row. */
  readonly organizationId: string | null;
  readonly ownerLevel: "user" | "team" | "organization" | "workspace" | "platform";
  readonly ownerId: string | null;
  readonly status: ScopeSurfaceStatus;
  readonly version: string | null;
  readonly bindings?: readonly ScopeSurfaceBinding[];
};

/** The actor axes a scope's eligibility read resolves against. */
export type ScopeSurfaceAnchor = {
  readonly userId: string;
  /**
   * The VIEWED organization — the organization the scope being read belongs to.
   * Deliberately named "viewed" and not "active": a team or project page may be
   * read while the session points at another organization, and the workspace
   * arm ignores the session's organization entirely.
   */
  readonly viewedOrgId: string | null;
  readonly teamIds?: readonly string[];
  readonly projectIds?: readonly string[];
  /** The workspace tier's vantage; required by the workspace arm only. */
  readonly workspace?: WorkspaceVantage | null;
};

/** One candidate vantage: the scope projection plus the concrete organization
 *  the decision is taken under. */
export type ScopeSurfaceCandidateVantage = {
  readonly orgId: string;
  readonly vantage: AccessScopeVantage;
};

/** The injected decision arms — see the module docstring. */
export type ScopeSurfaceArms<TPolicy> = {
  /** Read the install's stored policy ONCE. Called at most once per install. */
  policyFor(install: ScopeSurfaceInstall): TPolicy | Promise<TPolicy>;
  /** The ACTOR arm, over the already-resolved policy value. */
  actorAdmits(
    policy: TPolicy,
    install: ScopeSurfaceInstall,
    orgId: string,
  ): boolean | Promise<boolean>;
  /** The VANTAGE arm, over that SAME policy value. */
  vantageAdmits(policy: TPolicy, vantage: AccessScopeVantage): boolean | Promise<boolean>;
};

/** One eligible row — what a scope tab renders, plus its execution organizations. */
export type ScopeSurfaceEligibilityRow = {
  readonly packageName: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly version: string | null;
  readonly status: ScopeSurfaceStatus;
  /** The install whose policy governed the admission that produced this row. */
  readonly installId: string;
  /**
   * The eligible CONCRETE execution organizations, retained after the
   * package-level display dedupe (the epic's launch-organization contract).
   * Exactly one element for every scope but the workspace.
   */
  readonly executionOrgIds: readonly string[];
};

// ---------------------------------------------------------------------------
// THE SCOPE REACH RULE
// ---------------------------------------------------------------------------

/** The non-hidden bindings of an install for one scope kind. A hidden binding
 *  is dropped HERE, so no rule below can ever read one. */
function visibleBindings(
  install: ScopeSurfaceInstall,
  kind: ScopeSurfaceBinding["kind"],
): readonly ScopeSurfaceBinding[] {
  return (install.bindings ?? []).filter((b) => b.kind === kind && b.hidden !== true);
}

/** An install anchored EXACTLY at this organization (its own row anchor). */
function isExactOrgInstall(install: ScopeSurfaceInstall, orgId: string): boolean {
  return install.organizationId === orgId;
}

/** An install anchored EXACTLY at this team. */
function isExactTeamInstall(install: ScopeSurfaceInstall, teamId: string): boolean {
  return install.ownerLevel === "team" && install.ownerId === teamId;
}

/** A row with no owning organization — the workspace/platform anchor. The
 *  workspace tier admits it ONCE rather than once per member organization. */
export function isOrgNullInstall(install: ScopeSurfaceInstall): boolean {
  return install.organizationId === null;
}

/**
 * Does this install reach `scope` at all, BEFORE either policy arm runs?
 *
 * Purely structural: ownership and bindings, never a policy or a role. It can
 * only ever NARROW what the arms would admit.
 */
export function installReachesScope(
  scope: ScopeSurfaceRef,
  anchor: ScopeSurfaceAnchor,
  install: ScopeSurfaceInstall,
): boolean {
  if (!SCOPE_SURFACE_LIVE_STATUSES.includes(install.status)) return false;

  switch (scope.kind) {
    case "personal": {
      // The actor's invocable set: everything addressable to the organization
      // they are reading under, plus the org-NULL rows that reach app-wide. The
      // ACTOR arm is what makes it "invocable"; this is only the address fence.
      if (!anchor.viewedOrgId) return isOrgNullInstall(install);
      return isOrgNullInstall(install) || isExactOrgInstall(install, anchor.viewedOrgId);
    }
    case "organization":
      // Exact-org installs. An org-NULL row is NOT an organization's install;
      // it belongs to the workspace tier and surfaces there.
      return isExactOrgInstall(install, scope.id);
    case "team": {
      // Exact-team + exact-org.
      if (isExactTeamInstall(install, scope.id)) return true;
      return !!anchor.viewedOrgId && isExactOrgInstall(install, anchor.viewedOrgId);
    }
    case "project": {
      // Exact-project installs + non-hidden project bindings + exact-org. A
      // HIDDEN binding was already dropped by `visibleBindings`, so it can be
      // neither the only reason nor a contributing one.
      if (visibleBindings(install, "project").some((b) => b.id === scope.id)) return true;
      return !!anchor.viewedOrgId && isExactOrgInstall(install, anchor.viewedOrgId);
    }
    case "workspace": {
      const vantage = anchor.workspace;
      if (!vantage) return false;
      if (isOrgNullInstall(install)) return true;
      return vantage.organizations.some((o) => isExactOrgInstall(install, o.orgId));
    }
  }
}

// ---------------------------------------------------------------------------
// THE CANDIDATE VANTAGES
// ---------------------------------------------------------------------------

/**
 * The vantages a scope's decision is taken under, each paired with the CONCRETE
 * organization it is taken in.
 *
 * Every scope but the workspace yields exactly one. The workspace yields one
 * per member organization: org-fenced sources are read SEPARATELY under each
 * member organization, which is also what lets a row retain the concrete
 * organizations it is eligible in.
 */
export function scopeSurfaceCandidateVantages(
  scope: ScopeSurfaceRef,
  anchor: ScopeSurfaceAnchor,
): readonly ScopeSurfaceCandidateVantage[] {
  switch (scope.kind) {
    case "personal":
      return anchor.viewedOrgId
        ? [{ orgId: anchor.viewedOrgId, vantage: { kind: "personal", orgId: anchor.viewedOrgId } }]
        : [];
    case "organization":
      return [
        { orgId: scope.id, vantage: { kind: "organization", orgId: scope.id, scopeId: scope.id } },
      ];
    case "team":
      return anchor.viewedOrgId
        ? [
            {
              orgId: anchor.viewedOrgId,
              vantage: { kind: "team", orgId: anchor.viewedOrgId, scopeId: scope.id },
            },
          ]
        : [];
    case "project":
      return anchor.viewedOrgId
        ? [
            {
              orgId: anchor.viewedOrgId,
              vantage: { kind: "project", orgId: anchor.viewedOrgId, scopeId: scope.id },
            },
          ]
        : [];
    case "workspace": {
      // THE VANTAGE UNION, as the epic words it: within each member
      // organization the vantage carries exactly the actor-visible teams and
      // projects, so a package a generic member of team T (or project P) can
      // reach is reachable FROM the workspace tier too. Reading only the
      // organization vantage would drop every `team:`/`project:`-scoped row the
      // actor genuinely reaches. Every candidate stays anchored to its own
      // concrete organization, so the admitted execution organizations are
      // unchanged by the widening.
      const out: ScopeSurfaceCandidateVantage[] = [];
      for (const o of anchor.workspace?.organizations ?? []) {
        out.push({
          orgId: o.orgId,
          vantage: { kind: "organization", orgId: o.orgId, scopeId: o.orgId },
        });
        for (const teamId of o.teamIds)
          out.push({ orgId: o.orgId, vantage: { kind: "team", orgId: o.orgId, scopeId: teamId } });
        for (const projectId of o.projectIds)
          out.push({
            orgId: o.orgId,
            vantage: { kind: "project", orgId: o.orgId, scopeId: projectId },
          });
      }
      return out;
    }
  }
}

/**
 * Is this candidate vantage a legitimate one to judge THIS install under?
 *
 * THE PER-INSTALL TENANT FENCE. An org-anchored row belongs to exactly one
 * organization, so it is only ever judged under that organization's candidate.
 * Without the fence a workspace reader with several member organizations would
 * hand org A's install to org B's candidate, where the evaluator's own cross-org
 * guard is the only thing standing in the way — and that guard is bypassed
 * wholesale for a platform administrator, who would then collect B as an
 * execution organization for a package that exists only in A. An org-NULL
 * (workspace/platform) row has no tenant to fence against and is judged under
 * every candidate, which is exactly how it reaches app-wide.
 */
export function candidateJudgesInstall(
  install: ScopeSurfaceInstall,
  candidate: ScopeSurfaceCandidateVantage,
): boolean {
  return install.organizationId === null || install.organizationId === candidate.orgId;
}

// ---------------------------------------------------------------------------
// THE LOADER
// ---------------------------------------------------------------------------

export type ResolveScopeSurfaceEligibilityInput<TPolicy> = {
  readonly scope: ScopeSurfaceRef;
  readonly anchor: ScopeSurfaceAnchor;
  readonly installs: readonly ScopeSurfaceInstall[];
  readonly arms: ScopeSurfaceArms<TPolicy>;
};

/**
 * The eligible rows for a scope.
 *
 * Order of work, and why: the structural reach fence runs FIRST so no policy
 * read is spent on a row the scope could not address anyway; the snapshot is
 * then taken ONCE per surviving install and both arms read that one value; the
 * admitted organizations are collected per package; and the display dedupe runs
 * LAST so the organizations survive it.
 */
export async function resolveScopeSurfaceEligibility<TPolicy>(
  input: ResolveScopeSurfaceEligibilityInput<TPolicy>,
): Promise<readonly ScopeSurfaceEligibilityRow[]> {
  const { scope, anchor, installs, arms } = input;
  const candidates = scopeSurfaceCandidateVantages(scope, anchor);
  if (candidates.length === 0) return [];

  // packageName → the row plus the union of its eligible execution orgs.
  const byPackage = new Map<
    string,
    { row: Omit<ScopeSurfaceEligibilityRow, "executionOrgIds">; orgIds: Set<string> }
  >();

  for (const install of installs) {
    if (!installReachesScope(scope, anchor, install)) continue;

    // ── THE ONE SNAPSHOT ────────────────────────────────────────────────────
    // Read once, here, and handed to both arms for every candidate vantage.
    const policy = await arms.policyFor(install);

    const admittedOrgIds: string[] = [];
    for (const candidate of candidates) {
      // THE PER-INSTALL TENANT FENCE — before either arm.
      if (!candidateJudgesInstall(install, candidate)) continue;
      // One organization is admitted once, however many of its vantages reach
      // the package (the workspace tier carries one per team and project).
      if (admittedOrgIds.includes(candidate.orgId)) continue;
      // VANTAGE ARM first: it is the pure one, so it costs nothing and spares
      // the actor arm's per-candidate store reads for a scope that could not
      // reach the package anyway (the ordering `installed-catalog-read` uses).
      if (!(await arms.vantageAdmits(policy, candidate.vantage))) continue;
      if (!(await arms.actorAdmits(policy, install, candidate.orgId))) continue;
      admittedOrgIds.push(candidate.orgId);
    }
    if (admittedOrgIds.length === 0) continue;

    const existing = byPackage.get(install.packageName);
    if (existing) {
      // PACKAGE-LEVEL DISPLAY DEDUPE — one card per package. The organizations
      // are unioned rather than dropped: the launch step needs every concrete
      // organization the package is eligible in, not just the first row's.
      for (const orgId of admittedOrgIds) existing.orgIds.add(orgId);
      continue;
    }
    byPackage.set(install.packageName, {
      row: {
        packageName: install.packageName,
        displayName: install.displayName,
        description: install.description,
        version: install.version,
        status: install.status,
        installId: install.installId,
      },
      orgIds: new Set(admittedOrgIds),
    });
  }

  const rows: ScopeSurfaceEligibilityRow[] = [];
  for (const { row, orgIds } of byPackage.values()) {
    rows.push({ ...row, executionOrgIds: [...orgIds].sort() });
  }
  return rows.sort(
    (a, b) =>
      a.displayName.localeCompare(b.displayName) || a.packageName.localeCompare(b.packageName),
  );
}
