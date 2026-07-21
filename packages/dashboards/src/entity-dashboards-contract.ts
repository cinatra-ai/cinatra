/**
 * Shared contract for the reusable entity Dashboards surface (cinatra#701).
 *
 * These are the plain data types that cross the client/server seam: the server
 * actions (`actions.ts`, `"use server"`) return them and the client shell
 * (`entity-dashboards-shell.tsx`, `"use client"`) consumes them. They live in
 * this provider-neutral module (no `"use server"` / `"use client"`) because a
 * `"use server"` file may export ONLY async functions, so its result types have
 * to be declared elsewhere.
 *
 * Capability model (codex round-0): `listDashboardsForEntity` returns every row
 * the actor can READ, some of which they may not WRITE (a members-visible
 * team dashboard read by a non-admin member). So each summary carries a
 * server-derived `canWrite`, and the list carries a surface-level `canCreate`,
 * and the UI gates edit / rename / delete / New on those — never on an
 * unconditional `editable`.
 */
import type { DashboardConfigV1_1 } from "./store/dashboard-config";

/** One row in the dashboard-select dropdown. */
export type EntityDashboardSummary = {
  readonly id: string;
  readonly name: string;
  /** The non-removable Overview default (server-enforced). Reflected in the UI:
   *  no rename/delete affordance is offered for it. */
  readonly isDefault: boolean;
  /** Server-derived: may the actor edit/save THIS dashboard's config? */
  readonly canWrite: boolean;
};

/** The dropdown's data + whether the actor may create a new dashboard here. */
export type EntityDashboardsList = {
  readonly dashboards: readonly EntityDashboardSummary[];
  /** Server-derived: may the actor create a new dashboard for this entity? */
  readonly canCreate: boolean;
};

/**
 * Expected (non-500) mutation failures. Returned as data — NOT thrown — so the
 * reason survives the RSC boundary intact (Next sanitizes thrown server-action
 * errors in production). Unexpected failures still throw (→ 500 / error state).
 */
export type EntityDashboardMutationReason =
  | "name-conflict"
  | "name-required"
  | "name-reserved"
  | "denied"
  | "protected"
  | "not-found"
  | "invalid-config";

export type MutatedEntityDashboard =
  | { readonly ok: true; readonly dashboard: EntityDashboardSummary }
  | { readonly ok: false; readonly reason: EntityDashboardMutationReason };

export type DeletedEntityDashboard =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: EntityDashboardMutationReason };

/** Human copy for each mutation failure reason (dialog field + toast text). */
export const ENTITY_DASHBOARD_REASON_COPY: Readonly<
  Record<EntityDashboardMutationReason, string>
> = {
  "name-conflict": "A dashboard with that name already exists.",
  "name-required": "Enter a dashboard name.",
  "name-reserved": "“Overview” is reserved for the default dashboard.",
  denied: "You don’t have permission to do that.",
  protected: "The Overview dashboard can’t be changed.",
  "not-found": "That dashboard no longer exists.",
  // Fallback only — the save result usually carries the validator's own
  // card-naming `message` (cinatra#1913), which the shell prefers.
  "invalid-config": "The dashboard configuration is invalid.",
};

/** Result of persisting an edited config (cinatra#1913: the save path returns
 *  a typed result like every other mutation — it never throws into the client,
 *  so a validation failure renders as in-product copy, not an error overlay). */
export type SavedEntityDashboard =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: EntityDashboardMutationReason;
      /** The validator's user-facing copy (names the offending card). Present
       *  only for `invalid-config`. */
      readonly message?: string;
    };

/**
 * The server-action callback surface a hosting screen (#703–#706) binds (with
 * its server-derived, Next-encrypted entity ref) and hands to
 * `<EntityDashboardsShell>`. The shell never sees the ref — only these thunks —
 * so the client can neither read nor forge the owner axis.
 */
export type EntityDashboardsDataSource = {
  /** Ensured Overview-inclusive list + capabilities. */
  readonly listDashboards: () => Promise<EntityDashboardsList>;
  /** The unwrapped drizzle-cube config for one dashboard id (ref-confined). */
  readonly loadConfig: (id: string) => Promise<DashboardConfigV1_1>;
  /** Create a named (non-default) dashboard, seeded empty. */
  readonly createDashboard: (name: string) => Promise<MutatedEntityDashboard>;
  /** Rename a dashboard. Absent ⇒ no rename affordance. Never targets Overview. */
  readonly renameDashboard?: (
    id: string,
    name: string,
  ) => Promise<MutatedEntityDashboard>;
  /** Delete a dashboard. Absent ⇒ no delete affordance. Never targets Overview. */
  readonly deleteDashboard?: (id: string) => Promise<DeletedEntityDashboard>;
  /** Persist the selected dashboard's edited config (config-only, Overview-safe). */
  readonly saveDashboard: (
    id: string,
    config: DashboardConfigV1_1,
  ) => Promise<SavedEntityDashboard>;
};
