import "server-only";
/**
 * §VIII "Dashboards as artifacts" — the SESSION-bound resolvers (cinatra#1895).
 *
 * These wrap the pure surface projection (`./dashboard-artifact-surface`) with
 * the session actor + the dashboards-store reads. Kept OUT of the pure module so
 * the projection/dual-auth logic stays unit-testable without `auth-session` or a
 * database. The dashboard authz actor is built the SAME way the /dashboards
 * routes build it (`buildDashboardActorFromSession` — the resolver that carries
 * the FULL project grants the owner+project gate needs), so the library and the
 * pointer detail gate a dashboard EXACTLY as /dashboards does.
 */
import { buildDashboardActorFromSession } from "@/lib/dashboards/dashboard-actor";
import {
  requireDashboardAccess,
  DashboardAccessError,
} from "@/lib/dashboards/authz";
import { resolveLiveExtensionPredicate } from "@/lib/dashboards/live-extension-oracle";
import {
  listOrgDashboardRows,
  readDashboardRowById,
  isProjectTemplate,
  isDashboardRowRenderable,
} from "@cinatra-ai/dashboards/extension-dashboard-reads";
import {
  buildDashboardArtifactPointer,
  selectReadableDashboardArtifactPointers,
  type DashboardArtifactPointer,
} from "@/lib/dashboards/dashboard-artifact-surface";

/**
 * Resolve §VIII pointers for the dashboard-typed artifact ids on a library page,
 * applying liveness/template selection over the object-gated ids. Returns the
 * renderable pointers (keyed by dashboard/artifact id). A dashboards-store
 * failure fails CLOSED (empty map) — a dashboard row is never rendered un-gated.
 *
 * Phase-2 (cinatra#1898): the `artifactIds` were ALREADY authorized by the
 * canonical `object.read` filter inside `listArtifacts` — the SOLE gate now. The
 * Phase-1 dual authorization (a second dashboard-resolver pass) is gone, so no
 * session actor is built here; the projection only drops orphaned/archived and
 * project-template rows that are not an operational surface on either side.
 */
export async function resolveLibraryDashboardPointers(
  orgId: string | null,
  artifactIds: readonly string[],
): Promise<Map<string, DashboardArtifactPointer>> {
  if (!orgId || artifactIds.length === 0)
    return new Map<string, DashboardArtifactPointer>();
  try {
    const [rows, isPackageLive] = await Promise.all([
      listOrgDashboardRows(orgId),
      resolveLiveExtensionPredicate(orgId),
    ]);
    return selectReadableDashboardArtifactPointers({
      rows,
      artifactIds: new Set(artifactIds),
      isPackageLive,
    });
  } catch (e) {
    console.warn(
      `[dashboards/dashboard-artifact-surface] library pointer resolution failed for org ${orgId}; ` +
        `hiding dashboard rows (fail-closed):`,
      e instanceof Error ? e.message : e,
    );
    return new Map<string, DashboardArtifactPointer>();
  }
}

/** Detail-page access outcome for a dashboard artifact pointer. */
export type DashboardArtifactAccess =
  | { readonly access: "ok"; readonly pointer: DashboardArtifactPointer }
  | { readonly access: "denied" }
  | { readonly access: "not-found" };

/**
 * Resolve one dashboard artifact for the §VIII pointer detail, applying the SAME
 * gate chain the canonical /dashboards/[id] route enforces: existence →
 * project-template → liveness → owner+project (Phase-1 dual authorization).
 *
 *   - `not-found` — the row is absent, a project-scope template, or an
 *     orphaned/archived extension dashboard. The detail route 404s (existence
 *     stays hidden).
 *   - `denied`   — the actor CAN list the artifact (the object.read gate already
 *     passed) but the dashboard resolver refuses read. Per spec §III this routes
 *     to the not-authorized panel, never to the bytes.
 *
 * A non-access error (e.g. a dashboards-store failure) is re-thrown for the
 * caller's error frame / route boundary — it is not a `denied`.
 */
export async function resolveDashboardArtifactPointer(
  dashboardId: string,
): Promise<DashboardArtifactAccess> {
  const { actor } = await buildDashboardActorFromSession();
  // Gate ORDER mirrors the canonical /dashboards/[id] route EXACTLY: existence →
  // project-template → liveness (the existence-hiding refinements) precede the
  // owner+project access gate, which runs LAST. Order is load-bearing: a
  // project-scope template or an orphaned/archived extension dashboard is not an
  // operational surface and 404s REGARDLESS of access, so a dashboard-DENIED
  // template/dead row is hidden as `not-found` and never disclosed through the
  // not-authorized panel. (Gating on access FIRST would leak such a row's
  // existence as `denied` — the panel confirms "a dashboard is here" — where the
  // canonical route 404s it.)
  const row = await readDashboardRowById(dashboardId);
  if (!row) return { access: "not-found" };
  if (isProjectTemplate(row)) return { access: "not-found" };
  const isPackageLive = await resolveLiveExtensionPredicate(row.organizationId);
  if (!isDashboardRowRenderable(row, isPackageLive)) {
    return { access: "not-found" };
  }
  // Owner+project gate LAST (Phase-1 dual authorization). The object.read gate
  // already admitted the artifact to the library, so a LIVE, non-template row the
  // dashboard resolver refuses is a genuine "may list but not read" case → the
  // not-authorized panel (spec §III), never the bytes. A `dashboard_not_found`
  // here is a read-race (the row was deleted between the two reads) → not-found.
  try {
    await requireDashboardAccess(actor, dashboardId, "read");
  } catch (e) {
    if (e instanceof DashboardAccessError) {
      return e.code === "dashboard_not_found"
        ? { access: "not-found" }
        : { access: "denied" };
    }
    throw e;
  }
  // The pointer is built from the row we existence-checked; `requireDashboardAccess`
  // above is the authoritative access decision (its own fresh read). This matches
  // the canonical route, which likewise reads the row then gates separately — the
  // pointer carries only display metadata, so a one-read-stale name is immaterial.
  return { access: "ok", pointer: buildDashboardArtifactPointer(row) };
}
