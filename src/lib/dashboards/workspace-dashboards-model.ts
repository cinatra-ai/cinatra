/**
 * The workspace Dashboards tab's DECISIONS (cinatra#2811, per-scope surfaces
 * S5), as pure functions over facts the server has already read. No I/O and no
 * `server-only`, so every rule the amended drawing (§IX.1 to §IX.4) and the
 * issue fix can be pinned directly.
 *
 * The active organization is not an input anywhere below: the workspace tab
 * reads identically whichever organization the session has active.
 */
import { formatDistanceToNow } from "date-fns";

import { canonicalDashboardPath } from "@cinatra-ai/dashboards/canonical-path";
import type { WorkspaceOverviewSummary } from "@cinatra-ai/dashboards/overview-config";
import type { WorkspaceVantage } from "@/lib/scope-surface-vantage";
import type { ScopeDashboardTabRow } from "@/components/dashboards/scope-dashboards-contract";

// ── The Overview summary ──────────────────────────────────────────────────

/** The two `instance_identity` fields the Overview may show. The type names
 *  them alone, so no other identity field (the instance UUID, any ciphertext)
 *  can travel through it. */
export type WorkspaceOverviewIdentity = {
  readonly instanceDisplayName?: string | null;
  readonly instanceNamespace?: string | null;
};

/**
 * The workspace Overview's summary: the instance's display name and namespace,
 * and the viewer's counts over the `WorkspaceVantage` (organizations, and the
 * teams and projects the actor-visible readers admitted in them). Fields are
 * copied by name, so an identity row carrying more (the UUID, secrets) leaks
 * nothing; a blank field is skipped rather than rendered empty.
 */
export function workspaceOverviewSummaryFrom(
  identity: WorkspaceOverviewIdentity | null,
  vantage: WorkspaceVantage,
): WorkspaceOverviewSummary {
  const name = identity?.instanceDisplayName?.trim() ?? "";
  const namespace = identity?.instanceNamespace?.trim() ?? "";
  let teamCount = 0;
  let projectCount = 0;
  for (const org of vantage.organizations) {
    teamCount += org.teamIds.length;
    projectCount += org.projectIds.length;
  }
  return {
    ...(name ? { instanceName: name } : {}),
    ...(namespace ? { namespace } : {}),
    organizationCount: vantage.organizations.length,
    teamCount,
    projectCount,
  };
}

// ── The listing authority and the viewer filter ───────────────────────────

/**
 * Who may curate the workspace reference collection (§IX.2, §IX.3). A distinct
 * arm from the tenant scopes' write gate: the collection is references, not a
 * scope's own dashboards.
 */
export type WorkspaceCurator = {
  /** A platform administrator curates every link. */
  readonly platformAdmin: boolean;
  /** The organizations the viewer administers (owner or admin), read from the
   *  viewer's own memberships, never from the active organization. */
  readonly managedOrgIds: ReadonlySet<string>;
};

/** May this viewer add or remove the workspace link whose target is homed in
 *  `homeOrgId`? Platform administrators: every link. Organization admins: the
 *  links whose target's home organization is theirs. Nobody else. */
export function mayCurateWorkspaceReference(
  curator: WorkspaceCurator,
  homeOrgId: string,
): boolean {
  if (!homeOrgId) return false;
  if (curator.platformAdmin) return true;
  return curator.managedOrgIds.has(homeOrgId);
}

/** The viewer filter (§IX.1, §IX.3): an entry appears only when the viewer
 *  holds the everyone-grant on it or passes the target's home access. */
export function workspaceReferenceVisible(
  reference: { readonly granted: boolean },
  passesHomeAccess: boolean,
): boolean {
  return reference.granted || passesHomeAccess;
}

// ── The tab rows ──────────────────────────────────────────────────────────

/** One of the viewer's OWN workspace dashboards (homed in the workspace). */
export type WorkspaceTabOwnRow = {
  readonly dashboardId: string;
  readonly name: string;
  readonly updatedAt: Date | string | null;
  readonly isDefault: boolean;
};

/** One workspace reference, with the two facts the viewer filter reads. */
export type WorkspaceTabReference = {
  readonly dashboardId: string;
  readonly name: string;
  readonly updatedAt: Date | string | null;
  /** The target's home organization (the link's organization column). */
  readonly homeOrgId: string;
  /** The target's own anchor, for its canonical surface. */
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly granted: boolean;
  readonly passesHomeAccess: boolean;
};

function updatedRel(updatedAt: Date | string | null): string {
  if (!updatedAt) return "recently";
  const d = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  return Number.isNaN(d.getTime()) ? "recently" : formatDistanceToNow(d, { addSuffix: true });
}

function byName<T extends { readonly name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
}

/**
 * The workspace tab's rows, in the drawing's order: the non-removable Overview,
 * then the viewer's other workspace dashboards (homed here, never removable),
 * then the references the viewer filter admits (Remove only for a curator of
 * that link; the everyone mark on each, settable by a platform administrator
 * alone). A reference the filter refuses produces NOTHING: no row, no name.
 */
export function buildWorkspaceTabRows(input: {
  readonly own: readonly WorkspaceTabOwnRow[];
  readonly references: readonly WorkspaceTabReference[];
  readonly curator: WorkspaceCurator;
}): ScopeDashboardTabRow[] {
  const overview = input.own.filter((r) => r.isDefault);
  const others = input.own.filter((r) => !r.isDefault).sort(byName);
  const home: ScopeDashboardTabRow[] = [...overview, ...others].map((r) => ({
    dashboardId: r.dashboardId,
    name: r.name,
    metaLine: `updated ${updatedRel(r.updatedAt)}`,
    relation: "home",
    canonicalHref: canonicalDashboardPath({
      id: r.dashboardId,
      entityType: "workspace",
      entityId: "__workspace__",
    }),
    canRemove: false,
  }));
  const listed: ScopeDashboardTabRow[] = input.references
    .filter((r) => workspaceReferenceVisible(r, r.passesHomeAccess))
    .sort(byName)
    .map((r) => ({
      dashboardId: r.dashboardId,
      name: r.name,
      metaLine: `updated ${updatedRel(r.updatedAt)}`,
      relation: "listed",
      canonicalHref: canonicalDashboardPath({
        id: r.dashboardId,
        entityType: r.entityType,
        entityId: r.entityId,
      }),
      canRemove: mayCurateWorkspaceReference(input.curator, r.homeOrgId),
      everyone: { granted: r.granted, canSet: input.curator.platformAdmin },
    }));
  return [...home, ...listed];
}
