import "server-only";
/**
 * §VIII "Dashboards as artifacts" — the PURE surface bridge (cinatra#1895,
 * epic #1883 D7/D9; spec `specs/app-artifacts.html` §VIII, pinned at
 * design@5daf862 — content commit 16efd8d).
 *
 * A dashboard is an artifact: the #1894 twin writer pairs every dashboard with
 * an `objects` row of type `@cinatra-ai/dashboard-artifact:dashboard`, so a
 * dashboard already flows into the library through the object substrate. This
 * module turns those rows into the §VIII POINTER surface (owner ruling
 * 2026-07-20: NO inline dashboard render — the row and the detail page both
 * POINT to the dashboard's canonical surface).
 *
 * PURE by design (no session, no I/O): the pure functions here take rows the
 * session-bound resolvers (`./dashboard-artifact-pointer-resolvers`) fetch, so
 * the dual-authorization + pointer projection is unit-testable without a DB.
 * The render paths (library-mode, the /artifacts/[id] detail) import ONLY this
 * pure module + the resolvers — never the server-only, self-registering
 * twin-writer module.
 */
import { canonicalDashboardPath } from "@cinatra-ai/dashboards/canonical-path";
import {
  excludeProjectTemplates,
  filterRenderableDashboards,
  type ExtensionLivenessOracle,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import type { ScopeLevel } from "@/components/scope-badge";

/**
 * The `objects.type` a dashboard artifact carries — the self-registered,
 * NON-dedicated-claim type enrolled by `@cinatra-ai/dashboard-artifact` and
 * written by the #1894 twin writer (`DASHBOARD_OBJECT_TYPE`). Declared standalone
 * so the library/detail render paths never import the server-only twin-writer
 * module (which self-registers into the dashboards mutation seam on import and
 * pulls the artifact-substrate builders); the equality invariant against the
 * twin's own constant is pinned in the surface unit test.
 */
export const DASHBOARD_ARTIFACT_OBJECT_TYPE =
  "@cinatra-ai/dashboard-artifact:dashboard";

/** True for a dashboard-typed artifact object row (§VIII). */
export function isDashboardArtifactType(
  objectType: string | null | undefined,
): boolean {
  return objectType === DASHBOARD_ARTIFACT_OBJECT_TYPE;
}

/**
 * The structural fields the §VIII pointer projection + the dual-auth/liveness
 * gates read off a dashboard row. `DashboardRow` (the drizzle `$inferSelect`)
 * satisfies this structurally, so the resolvers pass their fetched rows straight
 * through; keeping it structural leaves the pure functions DB-type-free and the
 * unit test a plain object literal.
 */
export type DashboardArtifactRow = {
  readonly id: string;
  readonly name: string;
  readonly ownerLevel: string;
  readonly ownerId: string;
  readonly organizationId: string;
  readonly projectId: string | null;
  readonly updatedAt: Date | string | null;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly extensionId: string | null;
  readonly status: string;
  readonly isTemplate: boolean;
  readonly templateScope: string | null;
};

/** A single scope listing chip on the pointer detail (§VIII, D9). Serializable
 *  (no React) so the pure projection stays framework-free. */
export type DashboardScopeChip = {
  readonly level: ScopeLevel;
  readonly label: string;
  /** Opens the dashboard IN that scope's context (`open-scope -> scope-view`). */
  readonly href: string;
};

/** The §VIII pointer: the metadata a dashboard row / detail page needs to POINT
 *  at the dashboard, never to render it inline. */
export type DashboardArtifactPointer = {
  readonly dashboardId: string;
  readonly name: string;
  readonly ownerLevel: ScopeLevel;
  readonly projectId: string | null;
  readonly updatedAt: string | null;
  /** The dashboard's canonical surface (`open-dashboard -> dashboard-canonical`). */
  readonly canonicalHref: string;
  readonly scopeChips: readonly DashboardScopeChip[];
};

const SCOPE_LABEL: Readonly<Record<ScopeLevel, string>> = {
  user: "Personal",
  team: "Team",
  organization: "Organization",
  workspace: "Workspace",
  project: "Project",
};

const SCOPE_LEVELS: readonly ScopeLevel[] = [
  "user",
  "team",
  "organization",
  "workspace",
  "project",
];

function normalizeScopeLevel(level: string): ScopeLevel {
  return (SCOPE_LEVELS as readonly string[]).includes(level)
    ? (level as ScopeLevel)
    : "workspace";
}

function toIsoOrNull(v: Date | string | null): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Project a readable dashboard row into its §VIII pointer. PURE. The canonical
 * href derives from the SINGLE source of truth (`canonicalDashboardPath` —
 * cinatra#1738 D2: an entity-anchored dashboard lives under its scope's nested
 * route, else the flat `/dashboards/[id]`). Phase-1 renders exactly ONE scope
 * chip — the dashboard's canonical home; secondary reference listings (the
 * separate D9 listing relation) ride #1897/#1898, so no second chip is minted
 * here.
 */
export function buildDashboardArtifactPointer(
  row: DashboardArtifactRow,
): DashboardArtifactPointer {
  const href = canonicalDashboardPath(row);
  // A project-scoped dashboard reads as "Project" scope; otherwise its owner tier
  // is the scope. (The twin floors object visibility conservatively for exactly
  // this row; the dual-auth gate is what safely re-admits it — §VIII ruling 5.)
  const level = normalizeScopeLevel(row.projectId ? "project" : row.ownerLevel);
  return {
    dashboardId: row.id,
    name: row.name,
    ownerLevel: level,
    projectId: row.projectId,
    updatedAt: toIsoOrNull(row.updatedAt),
    canonicalHref: href,
    scopeChips: [{ level, label: SCOPE_LABEL[level] ?? level, href }],
  };
}

/**
 * Phase-2 SINGLE-GATE + liveness selection over the org's dashboard rows, keyed
 * to the artifact ids actually present on the library page. PURE (no I/O): the
 * caller supplies the org rows and the resolved liveness oracle.
 *
 * Phase-2 ACL cutover (cinatra#1898, epic #1883 §D7): the Phase-1 dual
 * authorization is GONE. The canonical `object.read` filter — ALREADY applied by
 * `listArtifacts`, hence a row's presence in `artifactIds` — is now the SOLE
 * authorization gate for dashboard-typed rows, because the twin stamps the
 * canonical scope tuple (`deriveDashboardScopeTuple`) so the object row's
 * ownership IS the dashboard's ACL. The library and every /dashboards surface
 * therefore agree row-for-row (pinned by `library-dashboard-agreement.test.ts`).
 *
 * This function no longer authorizes — it only projects the object-gated rows
 * into §VIII pointers, after dropping the rows that are not an operational
 * surface on BOTH sides: orphaned/archived extension rows and project-scope
 * templates (the SAME liveness/template gates the /dashboards surfaces apply, so
 * the two still agree on exactly which dashboards render).
 */
export function selectReadableDashboardArtifactPointers(input: {
  readonly rows: readonly DashboardArtifactRow[];
  readonly artifactIds: ReadonlySet<string>;
  readonly isPackageLive: ExtensionLivenessOracle;
}): Map<string, DashboardArtifactPointer> {
  const renderable = filterRenderableDashboards(
    excludeProjectTemplates([...input.rows]),
    input.isPackageLive,
  );
  const out = new Map<string, DashboardArtifactPointer>();
  for (const row of renderable) {
    if (!input.artifactIds.has(row.id)) continue;
    out.set(row.id, buildDashboardArtifactPointer(row));
  }
  return out;
}
