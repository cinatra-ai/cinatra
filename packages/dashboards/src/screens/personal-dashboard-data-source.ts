/**
 * `/personal` binding for the reusable entity Dashboards surface (cinatra#703).
 *
 * The lowest-risk first integration of the multi-dashboard model (#700) + the
 * reusable shell (#701): `/personal` gains the "+ New dashboard" button and the
 * dashboard-select dropdown by dropping `<EntityDashboardsShell>` into the
 * personal screen and handing it a data source bound to the PERSONAL entity ref.
 *
 * Provider-neutral (no `"use server"` / `"use client"` / `server-only`) so it is
 * importable from both the server screen (`personal-dashboard.tsx`) and the
 * jsdom component test. Two small, testable pieces:
 *
 *   - `buildPersonalEntityRef` — the personal entity's identity. Personal is the
 *     user's own scope, so it maps onto the shared 4-tier axis as a USER-owned
 *     entity whose `entityId` is the ambient org and whose `ownerId` is the user
 *     (matching the six historical per-org surfaces: the Overview's canonical id
 *     is exactly the legacy `system-personal:<org>:<user>` row, so ensure /
 *     migration / the live save path all converge on the SAME row — no
 *     double-render, no stranded save; see `store/entity-identity.ts`).
 *   - `bindPersonalDashboardsDataSource` — prepends the server-derived ref to
 *     every generic `#701` entity action via `Function.bind`. Binding (rather
 *     than wrapping in a closure) is REQUIRED: a bound server action stays a
 *     server-action reference Next can serialize to the client shell with the
 *     ref encrypted, whereas a plain arrow closure cannot cross the RSC boundary.
 *
 * No rename/delete is withheld: personal owns its dashboards outright, so the
 * full create/rename/delete/save surface is wired (Overview stays server-
 * protected by #700 regardless of what the UI offers).
 */
import type { DashboardConfigV1_1 } from "../store/dashboard-config";
import type { DashboardEntityRef } from "../store/entity-identity";
import type {
  DeletedEntityDashboard,
  EntityDashboardsDataSource,
  EntityDashboardsList,
  MutatedEntityDashboard,
} from "../entity-dashboards-contract";

/**
 * The personal entity ref for `(organizationId, userId)`. Pure — the caller
 * derives org + user from the session server-side; this only shapes the ref.
 */
export function buildPersonalEntityRef(
  organizationId: string,
  userId: string,
): DashboardEntityRef {
  return {
    entityType: "personal",
    entityId: organizationId,
    ownerLevel: "user",
    ownerId: userId,
  };
}

/**
 * The generic `#701` entity Dashboards actions, ref-first. The screen passes the
 * real `"use server"` actions here; the component test passes in-memory spies —
 * so the ref-forwarding is unit-testable without a session or a database.
 */
export type PersonalDashboardsActions = {
  readonly listEntityDashboardsAction: (
    ref: DashboardEntityRef,
  ) => Promise<EntityDashboardsList>;
  readonly getEntityDashboardConfigAction: (
    ref: DashboardEntityRef,
    id: string,
  ) => Promise<DashboardConfigV1_1>;
  readonly createEntityDashboardAction: (
    ref: DashboardEntityRef,
    name: string,
  ) => Promise<MutatedEntityDashboard>;
  readonly renameEntityDashboardAction: (
    ref: DashboardEntityRef,
    id: string,
    name: string,
  ) => Promise<MutatedEntityDashboard>;
  readonly deleteEntityDashboardAction: (
    ref: DashboardEntityRef,
    id: string,
  ) => Promise<DeletedEntityDashboard>;
  readonly saveEntityDashboardConfigAction: (
    ref: DashboardEntityRef,
    id: string,
    config: unknown,
  ) => Promise<void>;
};

/**
 * Bind the personal `ref` into every action so the shell's ref-free
 * `EntityDashboardsDataSource` thunks confine to this user's personal scope.
 */
export function bindPersonalDashboardsDataSource(
  ref: DashboardEntityRef,
  actions: PersonalDashboardsActions,
): EntityDashboardsDataSource {
  return {
    listDashboards: actions.listEntityDashboardsAction.bind(null, ref),
    loadConfig: actions.getEntityDashboardConfigAction.bind(null, ref),
    createDashboard: actions.createEntityDashboardAction.bind(null, ref),
    renameDashboard: actions.renameEntityDashboardAction.bind(null, ref),
    deleteDashboard: actions.deleteEntityDashboardAction.bind(null, ref),
    saveDashboard: actions.saveEntityDashboardConfigAction.bind(null, ref),
  };
}
