/**
 * Per-entity multi-dashboard identity (cinatra#700).
 *
 * Pure, dependency-light helpers shared by the mutation service and the
 * (later) UI loaders. A dashboard's identity moves from the single
 * deterministic per-user id (`system-<surface>:<orgId>:<userId>`) to the
 * composite (entityType, entityId, ownerLevel, ownerId, name). Each entity
 * carries exactly one non-removable "Overview" default (`is_default = true`).
 *
 * No DB / React / server-only imports here so the identity rules can be unit
 * tested and reused on either side of the write boundary.
 */
import type { OwnerLevel } from "./schema";

/** The reserved, non-removable default dashboard name for every entity. */
export const OVERVIEW_DASHBOARD_NAME = "Overview" as const;

/**
 * The six live surfaces whose existing single-id rows the #700 compat backfill
 * absorbs as that entity's Overview. Each maps 1:1 from a
 * `system-<surface>:<orgId>:<userId>` id. Keep in exact sync with the backfill
 * `IN (...)` list in `src/lib/drizzle-store.ts` — the
 * `entity-identity.compat` test pins the two together.
 */
export const MIGRATABLE_SURFACE_ENTITY_TYPES = [
  "agents",
  "artifacts",
  "personal",
  "projects",
  "teams",
  "organizations",
] as const;

/**
 * Per-instance detail surfaces (project / team / organization detail pages,
 * epic #699 → #704-#706). Not produced by the #700 backfill; allowed as
 * `entityType` for dashboards created against a specific entity instance.
 */
export const INSTANCE_ENTITY_TYPES = ["project", "team", "organization"] as const;

/** Every entityType the service accepts on create/ensure. */
export const DASHBOARD_ENTITY_TYPES = [
  ...MIGRATABLE_SURFACE_ENTITY_TYPES,
  ...INSTANCE_ENTITY_TYPES,
] as const;

export type DashboardEntityType = (typeof DASHBOARD_ENTITY_TYPES)[number];

/** Type guard: is `value` a known dashboard entity type? */
export function isKnownEntityType(value: unknown): value is DashboardEntityType {
  return (
    typeof value === "string" &&
    (DASHBOARD_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Reference to the (entity, owner) a dashboard belongs to — the issue's
 * composite identity minus the tenant. `entityType` + `entityId` identify the
 * entity; `ownerLevel` + `ownerId` identify the owner (today always user/userId,
 * but modeled on the 4-tier axis). The organization is NOT part of the ref: it
 * is the ambient tenant, always taken from the actor's active org at the service
 * layer, so a ref can never point across tenants.
 */
export type DashboardEntityRef = {
  readonly entityType: DashboardEntityType;
  readonly entityId: string;
  readonly ownerLevel: OwnerLevel;
  readonly ownerId: string;
};

/**
 * Deterministic id for a FRESHLY-created Overview. The Overview is LOCATED by the
 * (org, entity, owner, is_default) composite, not by this id; this only names a
 * brand-new row and makes concurrent ensure/retry converge via ON CONFLICT (id).
 *
 * CONVERGENCE (cinatra#700): for the six historical per-org surfaces (user-owned;
 * entityId == organizationId, ownerId == userId), the Overview's canonical id IS
 * the historical `system-<surface>:<org>:<user>` id. So a fresh `ensureOverview`,
 * the one-time coexistence migration, AND the still-live `upsertDashboardConfig`
 * save action ALL resolve to the SAME row — no dual-id default collision, no
 * double-render, no stranded save. Other (per-instance) surfaces use the
 * dedicated `dash:…:overview` form.
 */
export function buildOverviewDashboardId(ref: DashboardEntityRef): string {
  if (
    ref.ownerLevel === "user" &&
    (MIGRATABLE_SURFACE_ENTITY_TYPES as readonly string[]).includes(ref.entityType)
  ) {
    return `system-${ref.entityType}:${ref.entityId}:${ref.ownerId}`;
  }
  return ["dash", ref.entityType, ref.entityId, ref.ownerLevel, ref.ownerId, "overview"].join(":");
}

/** Fields the list comparator reads. */
export type DashboardOrderFields = {
  readonly isDefault: boolean;
  readonly name: string;
  readonly createdAt: Date;
};

/**
 * Ordering for the per-entity dropdown: the Overview default ALWAYS first, then
 * by name (case-insensitive, locale), then oldest-first on createdAt as a stable
 * tiebreak. Pure + total (never throws).
 */
export function compareDashboardsForList(
  a: DashboardOrderFields,
  b: DashboardOrderFields,
): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "accent" });
  if (byName !== 0) return byName;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Parse the `entityType` a legacy `system-<surface>:…` id's FIRST segment maps
 * to — the pure mirror of the SQL prefix parse (`split_part(id, ':', 1)`) in the
 * backfill migration. Keys ONLY on the surface prefix (like the SQL), so it is
 * the right check for the migration-parity test; it is NOT sufficient to decide
 * that an id is a canonical Overview (use `parseCanonicalOverviewId` for that).
 * Returns null for any unknown prefix (fail-closed).
 */
export function parseLegacySurfaceEntityType(
  id: string,
): (typeof MIGRATABLE_SURFACE_ENTITY_TYPES)[number] | null {
  const prefix = id.split(":", 1)[0]; // split_part(id, ':', 1)
  if (!prefix.startsWith("system-")) return null;
  const surface = prefix.slice("system-".length);
  return (MIGRATABLE_SURFACE_ENTITY_TYPES as readonly string[]).includes(surface)
    ? (surface as (typeof MIGRATABLE_SURFACE_ENTITY_TYPES)[number])
    : null;
}

/**
 * STRICT parse of a CANONICAL Overview id — exactly
 * `system-<surface>:<entityId>:<ownerId>` (three colon-delimited, non-empty
 * segments; a known migratable surface). This is the inverse of
 * `buildOverviewDashboardId` for the six user-owned surfaces. Fail-closed:
 * returns null for a malformed / wrong-arity / unknown-surface id, so a hostile
 * or buggy `system-…` id is NEVER treated as an Overview to stamp. The CALLER
 * must additionally verify the parsed `entityId`/`ownerId` agree with the actor's
 * org + effective owner before acting on it.
 */
export function parseCanonicalOverviewId(id: string): {
  entityType: (typeof MIGRATABLE_SURFACE_ENTITY_TYPES)[number];
  entityId: string;
  ownerId: string;
} | null {
  const parts = id.split(":");
  if (parts.length !== 3) return null;
  const [prefix, entityId, ownerId] = parts;
  if (!prefix.startsWith("system-")) return null;
  const surface = prefix.slice("system-".length);
  if (!(MIGRATABLE_SURFACE_ENTITY_TYPES as readonly string[]).includes(surface)) return null;
  if (entityId.length === 0 || ownerId.length === 0) return null;
  return {
    entityType: surface as (typeof MIGRATABLE_SURFACE_ENTITY_TYPES)[number],
    entityId,
    ownerId,
  };
}
