/**
 * Single mutation service for the dashboards platform.
 *
 * EVERY mutation goes through here. The AST regression gate in
 * `__tests__/no-direct-writes.test.ts` enforces this. UI server actions,
 * MCP write handlers and BullMQ AI jobs all call
 * one of the four methods below.
 *
 * Each call:
 *   1. Open a Postgres transaction.
 *   2. (publish/update/archive) SELECT … FOR UPDATE the dashboard row.
 *   3. Validate DashboardConfig (Zod) if config_json is touched.
 *   4. Resolve `canWrite` via the permission resolver — denial = throw 403.
 *   5. Execute the data change.
 *   6. Insert an `audit_events` row INSIDE THE SAME TX.
 *   7. Commit.
 *
 * Publish uses SELECT FOR UPDATE so concurrent publishes
 * serialize on the row lock and revision_number is computed atomically.
 */
import "server-only";
import { eq, max, sql, and, inArray, ne } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { CURRENT_CONFIG_VERSION } from "./store/dashboard-config";
import type { DashboardActor } from "./permissions";
import { resolveDashboardAccess } from "./permissions";
import {
  auditEvents,
  dashboardRevisions,
  dashboards,
  getDashboardsDb,
  type DashboardsDb,
} from "./store/db";
import type {
  DashboardRow,
  DashboardStatus,
  NewDashboardRow,
  OwnerLevel,
  Visibility,
} from "./store/schema";
import {
  OVERVIEW_DASHBOARD_NAME,
  buildOverviewDashboardId,
  compareDashboardsForList,
  isKnownEntityType,
  parseCanonicalOverviewId,
  type DashboardEntityRef,
} from "./store/entity-identity";
import {
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
  type PortletKindLookup,
} from "./extension/dashboard-config-v12";
import { registerCorePortletKinds } from "./portlets/kinds";
import { getPortletKindDescriptor, isRenderOnlyPortletKind, validatePortletConfig } from "./portlets/registry";
import { collectUnsafeDashboardLinks } from "./extension/portlet-link-guard";
import {
  threeWayMergeDashboardConfig,
  computeAppliedDefaultHash,
  type DashboardConfigLike,
} from "./contribution-upgrade-merge";
import {
  isV12Envelope,
  normalizeDcBodyForWrite,
  normalizeV12AnalyticsForWrite,
  ownerLevelToScopeLevel,
  reEnvelopeDcSave,
} from "./v12-envelope";

export class DashboardForbiddenError extends Error {
  readonly code = "dashboard_forbidden";
  constructor(operation: string, dashboardId: string) {
    super(`${operation} forbidden for dashboard ${dashboardId}`);
    this.name = "DashboardForbiddenError";
  }
}

export class DashboardNotFoundError extends Error {
  readonly code = "dashboard_not_found";
  constructor(dashboardId: string) {
    super(`Dashboard not found: ${dashboardId}`);
    this.name = "DashboardNotFoundError";
  }
}

export class DashboardConfigInvalidError extends Error {
  readonly code = "dashboard_config_invalid";
  constructor(readonly cause: unknown) {
    super(`DashboardConfig validation failed: ${String(cause)}`);
    this.name = "DashboardConfigInvalidError";
  }
}

/**
 * Thrown when a mutation targets the non-removable "Overview" default in a way
 * that would remove or rename it (delete / archive / rename). The Overview is
 * server-enforced (cinatra#700) — this is the hard stop for every write surface
 * (server actions, MCP, AI jobs), not a UI-only affordance.
 */
export class DashboardOverviewProtectedError extends Error {
  readonly code = "dashboard_overview_protected";
  constructor(operation: string, dashboardId: string) {
    super(`${operation} denied: the Overview default (${dashboardId}) cannot be removed or renamed`);
    this.name = "DashboardOverviewProtectedError";
  }
}

/** Thrown when a create/rename would collide with an existing dashboard name
 *  within the same (org, entity, owner). */
export class DashboardNameConflictError extends Error {
  readonly code = "dashboard_name_conflict";
  constructor(readonly name: string) {
    super(`A dashboard named "${name}" already exists for this entity`);
    this.name = "DashboardNameConflictError";
  }
}

/** Thrown when an entity-dashboard mutation is given an invalid entity ref or
 *  name (unknown entityType, empty entityId/ownerId, empty/reserved name). */
export class DashboardInvalidEntityError extends Error {
  readonly code = "dashboard_invalid_entity";
  constructor(message: string) {
    super(message);
    this.name = "DashboardInvalidEntityError";
  }
}

export type CreateDashboardInput = {
  readonly id?: string; // optional — randomUUID() if absent
  readonly name: string;
  readonly description?: string;
  readonly config: unknown; // validated against configVersion
  readonly configVersion?: string; // defaults to CURRENT_CONFIG_VERSION
  readonly ownerLevel: OwnerLevel;
  readonly ownerId: string;
  readonly visibility?: Visibility; // defaults to 'private'
  /** Initial status — defaults to 'draft'. AI jobs may pass 'generation_failed'. */
  readonly status?: DashboardStatus;
};

export type UpdateDashboardPatch = {
  readonly name?: string;
  readonly description?: string;
  readonly config?: unknown;
  readonly configVersion?: string;
  readonly visibility?: Visibility;
};

// ─────────────────────────────────────────────────────────────────────────
// Audit
// ─────────────────────────────────────────────────────────────────────────
type AuditOp =
  | "dashboards.create"
  | "dashboards.update"
  | "dashboards.publish"
  | "dashboards.archive"
  | "dashboards.rename"
  | "dashboards.delete"
  | "dashboards.materialize_template"
  | "dashboards.materialize_instance"
  | "dashboards.extension_archive"
  | "dashboards.extension_restore"
  | "dashboards.extension_adopt"
  | "dashboards.extension_upgrade";

async function writeAudit(
  tx: DashboardsDb,
  opts: {
    operation: AuditOp;
    actor: DashboardActor;
    row: DashboardRow;
    metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    id: randomUUID(),
    organizationId: opts.row.organizationId,
    actorPrincipalId: opts.actor.userId,
    actorPrincipalType: "user",
    resourceType: "dashboard",
    resourceId: opts.row.id,
    operation: opts.operation,
    decision: "allow",
    metadata: opts.metadata ?? null,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Validate a dashboard config against its `configVersion`.
 *
 * Post-cinatra#329 there is ONE format: apiVersion 1.2, validated by the SAME
 * registry-backed validator the extension-install materializer uses
 * (`assertConfigV12`), which accepts the `analytics` portlet kind. This is where
 * a wrapped operator/agent dashboard gets its deep per-kind validation.
 *
 * The legacy 1.0.0/1.1.0 parse path was removed with the migration of all
 * pre-existing rows (cinatra#327); a write that explicitly requests a legacy
 * version is now rejected (the intended tightening — first-party actions already
 * emit apiVersion 1.2, so only an MCP caller sending a legacy version now fails).
 */
async function validateConfig(
  config: unknown,
  configVersion: string,
): Promise<unknown> {
  if (configVersion !== DASHBOARD_CONFIG_V12_VERSION) {
    throw new DashboardConfigInvalidError(
      `Unsupported config_version "${configVersion}". ` +
        `The only supported version is the apiVersion 1.2 envelope ` +
        `(${DASHBOARD_CONFIG_V12_VERSION}).`,
    );
  }
  // assertConfigV12 already throws DashboardConfigInvalidError on failure.
  return assertConfigV12(config);
}

/**
 * Resolve the effective `{ config, configVersion }` a write should PERSIST
 * (cinatra#326 §3b/§3c), then validate it. Callers (create/update/upsert) pass
 * the incoming config + requested version + (for update/upsert) the existing
 * row's config + scope, and persist the returned pair.
 *
 * Rules:
 *   1. Effective version: an existing apiVersion 1.2 row STAYS apiVersion 1.2 —
 *      a write is never silently downgraded to a legacy version (which would
 *      drop sibling portlets / mislabel the row). Otherwise the requested
 *      version (already defaulted to `CURRENT_CONFIG_VERSION` = apiVersion 1.2
 *      for new writes) wins.
 *   2. apiVersion 1.2 target + the provided config is NOT already an envelope
 *      (bare drizzle-cube config from an agent / the entity-screen save action)
 *      → wrap it, preserving the existing envelope's scope + other portlets
 *      (re-envelope). A config that is ALREADY an apiVersion 1.2 envelope passes through
 *      untouched (sophisticated callers).
 *   3. Version-only change with no new config (e.g. an MCP update sending only
 *      `configVersion`) → normalize the EXISTING config to the target version
 *      so the row can never be relabeled apiVersion 1.2 while still holding a
 *      bare legacy body.
 *   4. Non-apiVersion-1.2 target → rejected by `validateConfig` (the legacy
 *      1.0.0/1.1.0 write path was removed in cinatra#329).
 *
 * Always validates the resolved config under the resolved version before
 * returning, so an invalid wrap/body fails closed.
 */
async function normalizeConfigForWrite(opts: {
  /** The incoming config from the caller, or `undefined` for a version-only update. */
  readonly config: unknown;
  /** Whether the caller supplied a `config` at all (distinguishes `undefined` body from absent). */
  readonly hasConfig: boolean;
  /** The requested config version (already defaulted by the caller where applicable). */
  readonly requestedVersion: string;
  /** The existing row's persisted config (for re-envelope), if any. */
  readonly existingConfig?: unknown;
  /** The existing row's config version (for the downgrade guard), if any. */
  readonly existingVersion?: string;
  /** Scope to stamp on a FRESH wrap (no existing apiVersion 1.2 envelope to inherit from).
   *  Raw `string` — the Drizzle row column is typed `string`; the mapper
   *  validates + defaults it. */
  readonly fallbackScopeOwnerLevel: string;
}): Promise<{ config: unknown; configVersion: string }> {
  const existingIsV12 = opts.existingVersion === DASHBOARD_CONFIG_V12_VERSION;
  // Rule 1: never silently downgrade an existing apiVersion 1.2 row.
  const effectiveVersion = existingIsV12
    ? DASHBOARD_CONFIG_V12_VERSION
    : opts.requestedVersion;

  if (effectiveVersion !== DASHBOARD_CONFIG_V12_VERSION) {
    // Rule 4: legacy target — rejected (the legacy write path was removed in
    // cinatra#329; validateConfig throws DashboardConfigInvalidError).
    const config = opts.hasConfig ? opts.config : opts.existingConfig;
    await validateConfig(config, effectiveVersion);
    return { config, configVersion: effectiveVersion };
  }

  // apiVersion 1.2 target.
  const fallbackScope = ownerLevelToScopeLevel(opts.fallbackScopeOwnerLevel);
  let resolved: unknown;
  if (!opts.hasConfig) {
    // Rule 3: version-only change. Normalize the existing body to apiVersion 1.2.
    resolved = isV12Envelope(opts.existingConfig)
      ? opts.existingConfig
      : reEnvelopeDcSave(
          opts.existingConfig,
          normalizeDcBodyForWrite(opts.existingConfig),
          fallbackScope,
        );
  } else if (isV12Envelope(opts.config)) {
    // Already an envelope — passes through, EXCEPT the analytics portlets'
    // embedded DC bodies, which get the legacy-`query` normalization
    // (cinatra#1736: an object-shaped query must never reach a row).
    resolved = normalizeV12AnalyticsForWrite(opts.config);
  } else {
    // Rule 2: bare DC config → normalize (cinatra#1736: legacy `query`
    // object → JSON string), then wrap, preserving the existing envelope's
    // siblings/scope.
    resolved = reEnvelopeDcSave(
      opts.existingConfig,
      normalizeDcBodyForWrite(opts.config),
      fallbackScope,
    );
  }
  await validateConfig(resolved, DASHBOARD_CONFIG_V12_VERSION);
  return { config: resolved, configVersion: DASHBOARD_CONFIG_V12_VERSION };
}

async function selectForUpdate(
  tx: DashboardsDb,
  id: string,
): Promise<DashboardRow | undefined> {
  // Drizzle's .for("update") clause acquires a row-level lock for the
  // remainder of the surrounding TX. Concurrent publishes serialize here.
  const rows = await tx
    .select()
    .from(dashboards)
    .where(eq(dashboards.id, id))
    .for("update")
    .limit(1);
  return rows[0];
}

// ─────────────────────────────────────────────────────────────────────────
// Public surface — used by MCP handlers and server actions.
// ─────────────────────────────────────────────────────────────────────────
export async function createDashboard(
  input: CreateDashboardInput,
  actor: DashboardActor,
): Promise<DashboardRow> {
  // Resolve + validate the persisted shape: a bare drizzle-cube config (the
  // shape agents emit) is wrapped into the apiVersion 1.2 analytics envelope
  // when the (defaulted) target version is apiVersion 1.2; an explicit legacy
  // version or an already-wrapped config passes through (cinatra#326 §3b).
  const { config, configVersion } = await normalizeConfigForWrite({
    config: input.config,
    hasConfig: true,
    requestedVersion: input.configVersion ?? CURRENT_CONFIG_VERSION,
    fallbackScopeOwnerLevel: input.ownerLevel,
  });

  const id = input.id ?? randomUUID();
  const visibility: Visibility = input.visibility ?? "private";

  // Build a pseudo-row for the permission check — the row "doesn't exist
  // yet," so we use the input shape.
  const pseudo: DashboardRow = {
    id,
    name: input.name,
    description: input.description ?? null,
    configJson: config as never,
    configVersion,
    dashboardVersion: 1,
    publishedRevisionNumber: null,
    ownerLevel: input.ownerLevel,
    ownerId: input.ownerId,
    organizationId: actor.organizationId,
    visibility,
    status: input.status ?? "draft",
    createdBy: actor.userId,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    archivedAt: null,
    projectId: null,
    extensionId: null,
    isTemplate: false,
    templateScope: null,
    entityType: null,
    entityId: null,
    isDefault: false,
    contributionId: null,
    appliedContributionVersion: null,
    appliedDefaultJson: null,
    appliedDefaultHash: null,
    archiveReason: null,
  };
  const access = resolveDashboardAccess(pseudo, actor);
  if (!access.canWrite) {
    throw new DashboardForbiddenError("dashboards.create", id);
  }

  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    const insertRow: NewDashboardRow = {
      id,
      name: input.name,
      description: input.description ?? null,
      configJson: config as never,
      configVersion,
      dashboardVersion: 1,
      publishedRevisionNumber: null,
      ownerLevel: input.ownerLevel,
      ownerId: input.ownerId,
      organizationId: actor.organizationId,
      visibility,
      status: input.status ?? "draft",
      createdBy: actor.userId,
    };
    const [row] = await tx.insert(dashboards).values(insertRow).returning();
    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.create",
      actor,
      row,
      metadata: { initialStatus: row.status, ownerLevel: row.ownerLevel },
    });
    return row;
  });
}

export async function updateDashboard(
  id: string,
  patch: UpdateDashboardPatch,
  actor: DashboardActor,
): Promise<DashboardRow> {
  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    const row = await selectForUpdate(tx as unknown as DashboardsDb, id);
    if (!row) throw new DashboardNotFoundError(id);
    const access = resolveDashboardAccess(row, actor);
    if (!access.canWrite) {
      throw new DashboardForbiddenError("dashboards.update", id);
    }

    const next: Partial<NewDashboardRow> = {
      updatedAt: new Date(),
      updatedBy: actor.userId,
      dashboardVersion: row.dashboardVersion + 1,
    };
    // Normalize the persisted config whenever the body OR the version changes.
    // A version-only update (config absent) still has to re-shape the existing
    // body to the target version, and a bare drizzle-cube body update gets
    // wrapped into the apiVersion 1.2 envelope (re-enveloped against the
    // existing row so sibling portlets + scope survive) — cinatra#326 §3b/§3c.
    if (patch.config !== undefined || patch.configVersion !== undefined) {
      const { config, configVersion } = await normalizeConfigForWrite({
        config: patch.config,
        hasConfig: patch.config !== undefined,
        requestedVersion: patch.configVersion ?? row.configVersion,
        existingConfig: row.configJson,
        existingVersion: row.configVersion,
        fallbackScopeOwnerLevel: row.ownerLevel,
      });
      next.configJson = config as never;
      next.configVersion = configVersion;
    }
    if (patch.name !== undefined) {
      // Overview invariant (cinatra#700) — enforced on the GENERIC update path
      // too, since it is MCP-reachable (dashboards_update forwards `name`):
      //   - the is_default Overview can never be renamed; and
      //   - no non-default ENTITY dashboard may claim the reserved "Overview"
      //     name (which would block a later ensureOverview insert). Non-entity
      //     rows (entity_type NULL — legacy/extension) keep the old free rename.
      if (row.isDefault) {
        throw new DashboardOverviewProtectedError("dashboards.update", id);
      }
      if (row.entityType != null && patch.name.trim() === OVERVIEW_DASHBOARD_NAME) {
        throw new DashboardInvalidEntityError(
          `"${OVERVIEW_DASHBOARD_NAME}" is reserved for the non-removable default dashboard`,
        );
      }
      next.name = patch.name;
    }
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.visibility !== undefined) next.visibility = patch.visibility;

    const [updated] = await tx
      .update(dashboards)
      .set(next)
      .where(eq(dashboards.id, id))
      .returning();

    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.update",
      actor,
      row: updated,
      metadata: {
        patchedFields: Object.keys(patch),
        dashboardVersion: updated.dashboardVersion,
      },
    });
    return updated;
  });
}

export async function publishDashboard(
  id: string,
  actor: DashboardActor,
): Promise<DashboardRow> {
  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    const row = await selectForUpdate(tx as unknown as DashboardsDb, id);
    if (!row) throw new DashboardNotFoundError(id);
    const access = resolveDashboardAccess(row, actor);
    if (!access.canWrite) {
      throw new DashboardForbiddenError("dashboards.publish", id);
    }

    // Compute next revision_number atomically under the row lock.
    const [agg] = await tx
      .select({ maxRev: max(dashboardRevisions.revisionNumber) })
      .from(dashboardRevisions)
      .where(eq(dashboardRevisions.dashboardId, id));
    const nextRevision = (agg?.maxRev ?? 0) + 1;

    await tx.insert(dashboardRevisions).values({
      dashboardId: id,
      revisionNumber: nextRevision,
      configJson: row.configJson,
      configVersion: row.configVersion,
      createdBy: actor.userId,
    });

    const prevStatus = row.status;
    const [updated] = await tx
      .update(dashboards)
      .set({
        status: "published",
        publishedRevisionNumber: nextRevision,
        publishedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: actor.userId,
        dashboardVersion: row.dashboardVersion + 1,
      })
      .where(eq(dashboards.id, id))
      .returning();

    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.publish",
      actor,
      row: updated,
      metadata: {
        revisionNumber: nextRevision,
        prevStatus,
        dashboardVersion: updated.dashboardVersion,
      },
    });
    return updated;
  });
}

export async function archiveDashboard(
  id: string,
  actor: DashboardActor,
): Promise<DashboardRow> {
  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    const row = await selectForUpdate(tx as unknown as DashboardsDb, id);
    if (!row) throw new DashboardNotFoundError(id);
    const access = resolveDashboardAccess(row, actor);
    if (!access.canWrite) {
      throw new DashboardForbiddenError("dashboards.archive", id);
    }
    // Non-removable Overview default (cinatra#700) — server-enforced on the
    // archive path, not only hidden in the UI.
    if (row.isDefault) {
      throw new DashboardOverviewProtectedError("dashboards.archive", id);
    }

    const prevStatus = row.status;
    const [updated] = await tx
      .update(dashboards)
      .set({
        status: "archived",
        archivedAt: new Date(),
        updatedAt: new Date(),
        updatedBy: actor.userId,
        dashboardVersion: row.dashboardVersion + 1,
      })
      .where(and(eq(dashboards.id, id), eq(dashboards.status, prevStatus)))
      .returning();

    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.archive",
      actor,
      row: updated,
      metadata: { prevStatus, dashboardVersion: updated.dashboardVersion },
    });
    return updated;
  });
}

// Exported for read-paths that want type-narrowing. Not used as a writer.
export { sql };

// ─────────────────────────────────────────────────────────────────────────
// upsertDashboardConfig.
//
// Used by `<DashboardGrid onSave={...}>` server actions where the dashboard
// id is known (e.g. `system-agents-default`) but the row may or may not yet
// exist. First save materialises the seed config; subsequent saves update.
//
// Race-freedom:
//   1. Open TX.
//   2. `SELECT pg_advisory_xact_lock(hashtext(id))` — serializes all
//      concurrent writers on this id. Released at COMMIT/ROLLBACK.
//   3. Probe the row under the lock — canonical state.
//   4. Auth check against existing row (write-access) or pseudo-row
//      (create-access).
//   5. `INSERT ... ON CONFLICT (id) DO UPDATE` — atomic; defense-in-depth
//      for lock-bypassing writers (manual psql etc).
//   6. Derive audit op from POST-WRITE `row.dashboardVersion === 1`
//      (newly created in this TX) vs `> 1` (updated existing row). The
//      pre-conflict probe flag is NOT used for the audit op.
// ─────────────────────────────────────────────────────────────────────────

export type UpsertDashboardConfigInput = {
  readonly config: unknown;
  readonly configVersion?: string;
  readonly name?: string;
  readonly visibility?: Visibility;
  readonly ownerLevel?: OwnerLevel;
  readonly ownerId?: string;
};

export async function upsertDashboardConfig(
  id: string,
  patch: UpsertDashboardConfigInput,
  actor: DashboardActor,
): Promise<DashboardRow> {
  // The persisted shape is resolved + validated AFTER the row probe below — the
  // re-envelope (cinatra#326 §3c) needs the EXISTING row's config to preserve
  // its scope + sibling portlets. This `requestedVersion` is only the
  // provisional version stamped on the auth pseudo-row (ownership-only check;
  // config content is never inspected for auth).
  const requestedVersion = patch.configVersion ?? CURRENT_CONFIG_VERSION;

  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    // 0. Advisory lock keyed by dashboard id — serializes concurrent
    //    writers on this id. Transaction-scoped, safe under transaction-
    //    mode connection poolers.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`);

    // 1. Probe under the lock — canonical state.
    const probed = await tx
      .select()
      .from(dashboards)
      .where(eq(dashboards.id, id))
      .limit(1);
    const existing = probed[0];

    // 2. Auth check — write-access on existing, create-access on pseudo.
    if (existing) {
      const access = resolveDashboardAccess(existing, actor);
      if (!access.canWrite) {
        throw new DashboardForbiddenError("dashboards.update", id);
      }
    } else {
      if (!patch.ownerLevel || !patch.ownerId || !patch.name) {
        throw new Error(
          "upsertDashboardConfig: first-create requires ownerLevel, ownerId, and name",
        );
      }
      const pseudo: DashboardRow = {
        id,
        name: patch.name,
        description: null,
        configJson: patch.config as never,
        configVersion: requestedVersion,
        dashboardVersion: 1,
        publishedRevisionNumber: null,
        ownerLevel: patch.ownerLevel,
        ownerId: patch.ownerId,
        organizationId: actor.organizationId,
        visibility: patch.visibility ?? "private",
        status: "draft",
        createdBy: actor.userId,
        updatedBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        publishedAt: null,
        archivedAt: null,
        projectId: null,
        extensionId: null,
        isTemplate: false,
        templateScope: null,
        entityType: null,
        entityId: null,
        isDefault: false,
        contributionId: null,
        appliedContributionVersion: null,
        appliedDefaultJson: null,
        appliedDefaultHash: null,
        archiveReason: null,
      };
      const access = resolveDashboardAccess(pseudo, actor);
      if (!access.canWrite) {
        throw new DashboardForbiddenError("dashboards.create", id);
      }
    }

    // 2b. Resolve + validate the persisted shape under the lock. A bare
    //     drizzle-cube config (the shape the entity-screen save action emits)
    //     is wrapped into the apiVersion 1.2 analytics envelope, re-enveloped
    //     against the EXISTING row so its scope + any sibling portlets survive
    //     the save (cinatra#326 §3c). The effective ownerLevel used for a fresh
    //     wrap's scopeLevel matches the row's resolved ownerLevel.
    const effectiveOwnerLevel: OwnerLevel =
      patch.ownerLevel ?? existing?.ownerLevel ?? "user";
    const { config: nextConfig, configVersion } = await normalizeConfigForWrite({
      config: patch.config,
      hasConfig: true,
      requestedVersion,
      existingConfig: existing?.configJson,
      existingVersion: existing?.configVersion,
      fallbackScopeOwnerLevel: effectiveOwnerLevel,
    });

    // cinatra#700 COEXISTENCE: a CANONICAL legacy per-surface save id
    // (`system-<surface>:<org>:<user>`) IS that entity's Overview. Stamp the
    // entity mapping (entity_type/entity_id/is_default) + the reserved name here
    // so a save that lands on a FRESH install, or AFTER the one-time coexistence
    // migration already ran, still produces a properly-mapped, listable,
    // non-removable Overview instead of an orphaned unmapped row that a later
    // `ensureOverview` would double-create. The id converges with
    // `buildOverviewDashboardId` (same `system-…` id), so both paths hit the SAME
    // row via ON CONFLICT (id).
    //
    // FAIL-CLOSED (do NOT stamp) unless the id is the EXACT canonical shape AND
    // it agrees with the tenant + owner it would be stamped under AND any
    // existing row is operator-authored — so a malformed/wrong-org/wrong-owner
    // `system-…` id, an extension/template/project row, or a non-user owner is
    // never coerced into a default (which could otherwise create a default under
    // a non-canonical id and later collide with the canonical one on
    // dashboards_entity_default_uniq). A non-canonical id just writes a plain
    // unmapped row, exactly as before.
    const effectiveOwnerId = patch.ownerId ?? existing?.ownerId ?? actor.userId;
    const canonical = parseCanonicalOverviewId(id);
    const isCanonicalOverview =
      canonical !== null &&
      canonical.entityId === actor.organizationId &&
      canonical.ownerId === effectiveOwnerId &&
      effectiveOwnerLevel === "user" &&
      (!existing ||
        (existing.extensionId == null && !existing.isTemplate && existing.projectId == null));
    const overviewMapping = isCanonicalOverview
      ? { entityType: canonical.entityType, entityId: actor.organizationId, isDefault: true as const }
      : null;

    // 3. INSERT ... ON CONFLICT DO UPDATE — atomic upsert.
    const insertRow: NewDashboardRow = {
      id,
      name: overviewMapping ? OVERVIEW_DASHBOARD_NAME : (patch.name ?? existing?.name ?? "Untitled"),
      description: existing?.description ?? null,
      configJson: nextConfig as never,
      configVersion,
      dashboardVersion: (existing?.dashboardVersion ?? 0) + 1,
      publishedRevisionNumber: existing?.publishedRevisionNumber ?? null,
      ownerLevel: effectiveOwnerLevel,
      ownerId: effectiveOwnerId,
      organizationId: actor.organizationId,
      visibility: patch.visibility ?? existing?.visibility ?? "private",
      status: existing?.status ?? "draft",
      createdBy: existing?.createdBy ?? actor.userId,
      updatedBy: actor.userId,
      entityType: overviewMapping?.entityType ?? existing?.entityType ?? null,
      entityId: overviewMapping?.entityId ?? existing?.entityId ?? null,
      isDefault: overviewMapping?.isDefault ?? existing?.isDefault ?? false,
    };
    const updateSet: Record<string, unknown> = {
      configJson: nextConfig as never,
      configVersion,
      updatedAt: new Date(),
      updatedBy: actor.userId,
      dashboardVersion: sql`${dashboards.dashboardVersion} + 1`,
    };
    if (overviewMapping) {
      // Repair/keep the mapping on every save (idempotent) so a pre-migration
      // unmapped row is healed on its next save, and the Overview name is fixed.
      updateSet.entityType = overviewMapping.entityType;
      updateSet.entityId = overviewMapping.entityId;
      updateSet.isDefault = true;
      updateSet.name = OVERVIEW_DASHBOARD_NAME;
    } else if (patch.name !== undefined && !existing?.isDefault) {
      // Overview invariant on the generic (non-legacy) upsert path: a non-default
      // ENTITY row may not claim the reserved "Overview" name.
      if (existing?.entityType != null && patch.name.trim() === OVERVIEW_DASHBOARD_NAME) {
        throw new DashboardInvalidEntityError(
          `"${OVERVIEW_DASHBOARD_NAME}" is reserved for the non-removable default dashboard`,
        );
      }
      updateSet.name = patch.name;
    }
    if (patch.visibility !== undefined) updateSet.visibility = patch.visibility;

    const [row] = await tx
      .insert(dashboards)
      .values(insertRow)
      .onConflictDoUpdate({
        target: dashboards.id,
        set: updateSet as Partial<NewDashboardRow>,
      })
      .returning();

    // 4. Audit op derived from POST-WRITE dashboardVersion.
    //    === 1 ⇒ newly created in this TX; > 1 ⇒ updated existing row.
    const operation: "dashboards.create" | "dashboards.update" =
      row.dashboardVersion === 1 ? "dashboards.create" : "dashboards.update";
    await writeAudit(tx as unknown as DashboardsDb, {
      operation,
      actor,
      row,
      metadata: { upsert: true, dashboardVersion: row.dashboardVersion },
    });
    return row;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Per-entity multi-dashboard surface (cinatra#700).
//
// Identity is the composite (entityType, entityId, ownerLevel, ownerId, name)
// within the actor's org, replacing the single deterministic per-user id. Each
// entity carries exactly ONE non-removable "Overview" default (`is_default`),
// enforced HERE (server layer) — not merely hidden in the UI, so an MCP / server
// action / AI job cannot delete, archive, or rename it. The single-writer +
// same-TX audit invariants hold as for every other mutation above.
// ─────────────────────────────────────────────────────────────────────────

/** A minimal valid, empty drizzle-cube config seeded into a fresh dashboard. */
const EMPTY_ENTITY_DASHBOARD_DC = {
  portlets: [] as unknown[],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as const;

/** Statuses that appear in the per-entity dropdown (an archived dashboard is hidden). */
const LISTABLE_STATUSES = ["draft", "published"] as const;

/** True if `e` (or anything in its `cause` chain) is a Postgres unique-violation
 *  (23505). Drizzle wraps the driver error, so the code can sit on `.cause`. */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 6 && cur != null; depth += 1) {
    if ((cur as { code?: string }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function assertValidEntityRef(ref: DashboardEntityRef): void {
  if (!isKnownEntityType(ref.entityType)) {
    throw new DashboardInvalidEntityError(`Unknown entityType "${String(ref.entityType)}"`);
  }
  if (!ref.entityId) throw new DashboardInvalidEntityError("entityId is required");
  if (!ref.ownerId) throw new DashboardInvalidEntityError("ownerId is required");
}

/** Validate + normalize a user-supplied dashboard name for create/rename. The
 *  reserved "Overview" name belongs to the default and can never be claimed. */
function assertCreatableName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new DashboardInvalidEntityError("name is required");
  if (trimmed === OVERVIEW_DASHBOARD_NAME) {
    throw new DashboardInvalidEntityError(
      `"${OVERVIEW_DASHBOARD_NAME}" is reserved for the non-removable default dashboard`,
    );
  }
  return trimmed;
}

/** Build a full DashboardRow for an ownership-only auth pre-check (the real row
 *  doesn't exist yet). Config content is never inspected for auth. */
function buildAuthPseudoRow(args: {
  readonly id: string;
  readonly organizationId: string;
  readonly ownerLevel: OwnerLevel;
  readonly ownerId: string;
  readonly visibility: Visibility;
  readonly config: unknown;
  readonly configVersion: string;
  readonly name: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly isDefault: boolean;
  readonly createdBy: string;
}): DashboardRow {
  return {
    id: args.id,
    name: args.name,
    description: null,
    configJson: args.config as never,
    configVersion: args.configVersion,
    dashboardVersion: 1,
    publishedRevisionNumber: null,
    ownerLevel: args.ownerLevel,
    ownerId: args.ownerId,
    organizationId: args.organizationId,
    visibility: args.visibility,
    status: "draft",
    createdBy: args.createdBy,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    publishedAt: null,
    archivedAt: null,
    projectId: null,
    extensionId: null,
    isTemplate: false,
    templateScope: null,
    entityType: args.entityType,
    entityId: args.entityId,
    isDefault: args.isDefault,
    contributionId: null,
    appliedContributionVersion: null,
    appliedDefaultJson: null,
    appliedDefaultHash: null,
    archiveReason: null,
  };
}

/** Locate the Overview default for (org, entity, owner) under the caller's TX. */
async function findDefaultRow(
  q: DashboardsDb,
  organizationId: string,
  ref: DashboardEntityRef,
): Promise<DashboardRow | undefined> {
  const rows = await q
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, organizationId),
        eq(dashboards.entityType, ref.entityType),
        eq(dashboards.entityId, ref.entityId),
        eq(dashboards.ownerLevel, ref.ownerLevel),
        eq(dashboards.ownerId, ref.ownerId),
        eq(dashboards.isDefault, true),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * List every dashboard for (entity, owner) the actor may read, Overview first.
 * Fail-closed: an incomplete ref/actor, a cross-tenant actor, or an actor the
 * shared owner/visibility/OBO resolver denies all yield ZERO rows. The exact
 * (org, entity, owner) composite is the primary scope; `resolveDashboardAccess`
 * is re-applied per row as defense in depth.
 */
export async function listDashboardsForEntity(
  ref: DashboardEntityRef,
  actor: DashboardActor,
): Promise<DashboardRow[]> {
  if (
    !actor.organizationId ||
    !ref.entityId ||
    !ref.ownerId ||
    !isKnownEntityType(ref.entityType)
  ) {
    return [];
  }
  const db = getDashboardsDb();
  const rows = await db
    .select()
    .from(dashboards)
    .where(
      and(
        eq(dashboards.organizationId, actor.organizationId),
        eq(dashboards.entityType, ref.entityType),
        eq(dashboards.entityId, ref.entityId),
        eq(dashboards.ownerLevel, ref.ownerLevel),
        eq(dashboards.ownerId, ref.ownerId),
        inArray(dashboards.status, LISTABLE_STATUSES as unknown as string[]),
      ),
    );
  const readable = rows.filter((r) => resolveDashboardAccess(r, actor).canRead);
  return readable.sort(compareDashboardsForList);
}

/**
 * Fetch ONE dashboard by id for selection, gated by the shared read resolver.
 * Returns `undefined` (not throw) when the row is absent OR the actor may not
 * read it — the caller cannot distinguish the two (no existence leak).
 */
export async function getEntityDashboard(
  id: string,
  actor: DashboardActor,
): Promise<DashboardRow | undefined> {
  const db = getDashboardsDb();
  const rows = await db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
  const row = rows[0];
  if (!row) return undefined;
  if (!resolveDashboardAccess(row, actor).canRead) return undefined;
  return row;
}

export type EnsureOverviewInput = {
  readonly ref: DashboardEntityRef;
  /** Bare drizzle-cube config to seed a NEW Overview with (wrapped into the
   *  apiVersion 1.2 envelope). Ignored when the Overview already exists. Defaults to empty. */
  readonly seedConfig?: unknown;
  readonly visibility?: Visibility;
};

/**
 * Idempotent find-or-create of an entity's non-removable Overview default.
 * Serialized on the (org, entity, owner) composite by a transaction-scoped
 * advisory lock, so concurrent callers converge on the SAME row — and the
 * partial UNIQUE index (`dashboards_entity_default_uniq`) is the DB backstop for
 * "at most one default". A pre-existing migrated legacy row (absorbed by the
 * #700 backfill as the Overview) is found by the composite here, so a live
 * `system-<surface>:…` row is NEVER double-created.
 */
export async function ensureOverview(
  input: EnsureOverviewInput,
  actor: DashboardActor,
): Promise<DashboardRow> {
  const { ref } = input;
  assertValidEntityRef(ref);
  const orgId = actor.organizationId;
  if (!orgId) throw new DashboardInvalidEntityError("actor.organizationId is required");

  const lockKey = ["overview", orgId, ref.entityType, ref.entityId, ref.ownerLevel, ref.ownerId].join(":");

  const db = getDashboardsDb();
  return db.transaction(async (tx) => {
    // Serialize concurrent ensures on the composite; released at COMMIT/ROLLBACK.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const found = await findDefaultRow(tx as unknown as DashboardsDb, orgId, ref);
    if (found) return found;

    const { config, configVersion } = await normalizeConfigForWrite({
      config: input.seedConfig ?? EMPTY_ENTITY_DASHBOARD_DC,
      hasConfig: true,
      requestedVersion: CURRENT_CONFIG_VERSION,
      fallbackScopeOwnerLevel: ref.ownerLevel,
    });
    const id = buildOverviewDashboardId(ref);
    const visibility: Visibility = input.visibility ?? "private";

    const pseudo = buildAuthPseudoRow({
      id,
      organizationId: orgId,
      ownerLevel: ref.ownerLevel,
      ownerId: ref.ownerId,
      visibility,
      config,
      configVersion,
      name: OVERVIEW_DASHBOARD_NAME,
      entityType: ref.entityType,
      entityId: ref.entityId,
      isDefault: true,
      createdBy: actor.userId,
    });
    if (!resolveDashboardAccess(pseudo, actor).canWrite) {
      throw new DashboardForbiddenError("dashboards.create", id);
    }

    // Under the advisory lock the probe→insert is exclusive for this composite,
    // so no concurrent writer can slip in a second default between them.
    const [row] = await tx
      .insert(dashboards)
      .values({
        id,
        name: OVERVIEW_DASHBOARD_NAME,
        configJson: config as never,
        configVersion,
        ownerLevel: ref.ownerLevel,
        ownerId: ref.ownerId,
        organizationId: orgId,
        visibility,
        status: "draft",
        createdBy: actor.userId,
        entityType: ref.entityType,
        entityId: ref.entityId,
        isDefault: true,
      } as NewDashboardRow)
      .returning();

    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.create",
      actor,
      row,
      metadata: { overview: true, entityType: ref.entityType, entityId: ref.entityId },
    });
    return row;
  });
}

export type CreateEntityDashboardInput = {
  readonly ref: DashboardEntityRef;
  readonly name: string;
  /** Bare drizzle-cube config to seed with (wrapped into apiVersion 1.2). Defaults to empty. */
  readonly seedConfig?: unknown;
  readonly visibility?: Visibility;
};

/**
 * Create a NEW named (non-default) dashboard for (entity, owner). The name must
 * be non-empty and is unique within (org, entity, owner) — a collision throws
 * `DashboardNameConflictError`. "Overview" is reserved for the default.
 */
export async function createEntityDashboard(
  input: CreateEntityDashboardInput,
  actor: DashboardActor,
): Promise<DashboardRow> {
  assertValidEntityRef(input.ref);
  const name = assertCreatableName(input.name);
  const orgId = actor.organizationId;
  if (!orgId) throw new DashboardInvalidEntityError("actor.organizationId is required");

  const { config, configVersion } = await normalizeConfigForWrite({
    config: input.seedConfig ?? EMPTY_ENTITY_DASHBOARD_DC,
    hasConfig: true,
    requestedVersion: CURRENT_CONFIG_VERSION,
    fallbackScopeOwnerLevel: input.ref.ownerLevel,
  });
  // Always a fresh random id, so the ONLY unique index a non-default create can
  // hit is the name index — making a 23505 unambiguously a name conflict (a
  // random-UUID primary-key collision is not a reachable case).
  const id = randomUUID();
  const visibility: Visibility = input.visibility ?? "private";

  const pseudo = buildAuthPseudoRow({
    id,
    organizationId: orgId,
    ownerLevel: input.ref.ownerLevel,
    ownerId: input.ref.ownerId,
    visibility,
    config,
    configVersion,
    name,
    entityType: input.ref.entityType,
    entityId: input.ref.entityId,
    isDefault: false,
    createdBy: actor.userId,
  });
  if (!resolveDashboardAccess(pseudo, actor).canWrite) {
    throw new DashboardForbiddenError("dashboards.create", id);
  }

  const db = getDashboardsDb();
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(dashboards)
        .values({
          id,
          name,
          configJson: config as never,
          configVersion,
          ownerLevel: input.ref.ownerLevel,
          ownerId: input.ref.ownerId,
          organizationId: orgId,
          visibility,
          status: "draft",
          createdBy: actor.userId,
          entityType: input.ref.entityType,
          entityId: input.ref.entityId,
          isDefault: false,
        } as NewDashboardRow)
        .returning();
      await writeAudit(tx as unknown as DashboardsDb, {
        operation: "dashboards.create",
        actor,
        row,
        metadata: { entityType: input.ref.entityType, entityId: input.ref.entityId, name },
      });
      return row;
    });
  } catch (e) {
    // The only unique index a non-default create can hit is the name index.
    if (isUniqueViolation(e)) throw new DashboardNameConflictError(name);
    throw e;
  }
}

/**
 * Rename a dashboard. DENIED for the Overview default (server-enforced). The new
 * name is validated (non-empty, not the reserved "Overview") and must stay
 * unique within (org, entity, owner) — a collision throws
 * `DashboardNameConflictError`.
 */
export async function renameDashboard(
  id: string,
  newName: string,
  actor: DashboardActor,
): Promise<DashboardRow> {
  const name = assertCreatableName(newName);
  const db = getDashboardsDb();
  try {
    return await db.transaction(async (tx) => {
      const row = await selectForUpdate(tx as unknown as DashboardsDb, id);
      if (!row) throw new DashboardNotFoundError(id);
      if (!resolveDashboardAccess(row, actor).canWrite) {
        throw new DashboardForbiddenError("dashboards.rename", id);
      }
      if (row.isDefault) {
        throw new DashboardOverviewProtectedError("dashboards.rename", id);
      }
      const [updated] = await tx
        .update(dashboards)
        .set({
          name,
          updatedAt: new Date(),
          updatedBy: actor.userId,
          dashboardVersion: row.dashboardVersion + 1,
        })
        .where(eq(dashboards.id, id))
        .returning();
      await writeAudit(tx as unknown as DashboardsDb, {
        operation: "dashboards.rename",
        actor,
        row: updated,
        metadata: { previousName: row.name, name },
      });
      return updated;
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DashboardNameConflictError(name);
    throw e;
  }
}

/**
 * Hard-delete a dashboard (cascades its revisions). DENIED for the Overview
 * default (server-enforced). The audit event is written BEFORE the row is gone;
 * `audit_events.resource_id` is a text reference (no FK), so it survives.
 */
export async function deleteEntityDashboard(
  id: string,
  actor: DashboardActor,
): Promise<void> {
  const db = getDashboardsDb();
  await db.transaction(async (tx) => {
    const row = await selectForUpdate(tx as unknown as DashboardsDb, id);
    if (!row) throw new DashboardNotFoundError(id);
    if (!resolveDashboardAccess(row, actor).canWrite) {
      throw new DashboardForbiddenError("dashboards.delete", id);
    }
    if (row.isDefault) {
      throw new DashboardOverviewProtectedError("dashboards.delete", id);
    }
    await writeAudit(tx as unknown as DashboardsDb, {
      operation: "dashboards.delete",
      actor,
      row,
      metadata: { name: row.name, entityType: row.entityType, entityId: row.entityId },
    });
    await tx.delete(dashboards).where(eq(dashboards.id, id));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Extension-shipped dashboards
//
// Materialize a workflow extension's `cinatra/dashboard.json` into a TEMPLATE
// row (one per extension+org) and, on demand, per-project INSTANCE rows. These
// are SYSTEM writes triggered by the extension lifecycle — install authz gates
// them upstream, so they do NOT run the user-facing `resolveDashboardAccess`
// (mirrors a migration writer). They live here to honour the single-writer
// invariant. Idempotent on the partial-unique keys, so the ordered
// cross-package install (workflow_template THEN dashboard) self-heals on retry.
// ─────────────────────────────────────────────────────────────────────────

async function withDashboardsTx<T>(
  tx: DashboardsDb | undefined,
  fn: (tx: DashboardsDb) => Promise<T>,
): Promise<T> {
  if (tx) return fn(tx);
  return getDashboardsDb().transaction(async (t) => fn(t as unknown as DashboardsDb));
}

export type ExtensionDashboardOwnerScope = {
  readonly ownerLevel: OwnerLevel;
  readonly ownerId: string;
};

export type MaterializeTemplateInput = {
  readonly extensionId: string; // package name (NOT installed_extension.id)
  readonly organizationId: string;
  readonly config: unknown; // raw cinatra/dashboard.json — validated as v1.2 here
  readonly scope: ExtensionDashboardOwnerScope;
  readonly name?: string;
  readonly actor: DashboardActor;
  readonly getPortletKind?: PortletKindLookup;
};

function assertConfigV12(config: unknown, getPortletKind?: PortletKindLookup) {
  // Self-wire the typed portlet registry (idempotent) so install validates
  // kind/version + per-kind config against the SAME registry the PortletHost
  // renders. A caller may still inject a custom lookup (tests); otherwise the
  // real registry descriptor lookup is the default.
  registerCorePortletKinds();
  const lookup = getPortletKind ?? getPortletKindDescriptor;
  const res = validateDashboardConfigV12(config, { getPortletKind: lookup });
  if (!res.ok) throw new DashboardConfigInvalidError(res.errors.join("; "));
  // Render-only kinds (cinatra#702) are EPHEMERAL presentation built fresh per
  // render (the entity-summary Overview blocks) and may NEVER be persisted — a
  // saved row must not serve a stale / authorization-obsolete summary. Checked
  // unconditionally against the real registry (registered above) so NO write
  // path — including an extension materialize injecting its own lookup — can
  // slip one into a dashboard row.
  const renderOnly = res.config.portlets.filter((p) => isRenderOnlyPortletKind(p.kind, p.version));
  if (renderOnly.length > 0) {
    throw new DashboardConfigInvalidError(
      renderOnly
        .map((p) => `portlet "${p.instanceId}": kind "${p.kind}" is render-only and cannot be persisted to a dashboard`)
        .join("; "),
    );
  }
  // Link/URL safety (cinatra#1628, S11c / AC4): reject a portlet config carrying
  // an unsafe-scheme URL (javascript:/data:/vbscript:/… — stored-XSS + local-file
  // vectors), fail-closed on EVERY write/install path. Runs against the validated
  // config so materialize + operator/agent writes all pass through it.
  const linkErrors = collectUnsafeDashboardLinks(res.config);
  if (linkErrors.length > 0) {
    throw new DashboardConfigInvalidError(linkErrors.join("; "));
  }
  // Per-kind structured config validation (incl. unknown-kind). Only
  // run against the real registry (when no custom lookup was injected).
  if (!getPortletKind) {
    const configErrors: string[] = [];
    for (const p of res.config.portlets) {
      for (const e of validatePortletConfig(p.kind, p.version, { config: p.config, inputs: p.inputs, outputs: p.outputs })) {
        configErrors.push(`portlet "${p.instanceId}": ${e.message}`);
      }
    }
    if (configErrors.length > 0) throw new DashboardConfigInvalidError(configErrors.join("; "));
  }
  return res.config;
}

/**
 * Upsert the single TEMPLATE dashboard row for (extensionId, organizationId).
 * Idempotent: re-install replaces the stored config + name in place.
 */
export async function materializeExtensionTemplate(
  tx: DashboardsDb | undefined,
  input: MaterializeTemplateInput,
): Promise<DashboardRow> {
  const config = assertConfigV12(input.config, input.getPortletKind);
  const templateScope = config.scopeLevel;
  const name = input.name ?? `${input.extensionId} dashboard`;

  return withDashboardsTx(tx, async (q) => {
    const existing = await q
      .select()
      .from(dashboards)
      .where(
        and(
          eq(dashboards.extensionId, input.extensionId),
          eq(dashboards.organizationId, input.organizationId),
          eq(dashboards.isTemplate, true),
        ),
      )
      .limit(1);

    // Reinstall reactivates: clear archivedAt + republish so a previously-archived
    // template comes back live.
    const updateSet = {
      name,
      configJson: config as never,
      configVersion: DASHBOARD_CONFIG_V12_VERSION,
      templateScope,
      ownerLevel: input.scope.ownerLevel,
      ownerId: input.scope.ownerId,
      status: "published" as const,
      archivedAt: null,
      updatedBy: input.actor.userId,
      updatedAt: new Date(),
    };
    async function updateTemplate(targetId: string): Promise<DashboardRow> {
      const [updated] = await q.update(dashboards).set(updateSet).where(eq(dashboards.id, targetId)).returning();
      return updated;
    }

    let row: DashboardRow;
    if (existing[0]) {
      row = await updateTemplate(existing[0].id);
    } else {
      try {
        const [inserted] = await q
          .insert(dashboards)
          .values({
            id: randomUUID(),
            name,
            configJson: config as never,
            configVersion: DASHBOARD_CONFIG_V12_VERSION,
            ownerLevel: input.scope.ownerLevel,
            ownerId: input.scope.ownerId,
            organizationId: input.organizationId,
            visibility: "members",
            status: "published",
            createdBy: input.actor.userId,
            extensionId: input.extensionId,
            isTemplate: true,
            templateScope,
            projectId: null,
          } as NewDashboardRow)
          .returning();
        row = inserted;
      } catch (e) {
        // Concurrent install lost the race to the partial-unique index — re-select
        // the winner and update it (idempotent re-convergence).
        if ((e as { code?: string })?.code !== "23505") throw e;
        const winner = await q
          .select()
          .from(dashboards)
          .where(and(eq(dashboards.extensionId, input.extensionId), eq(dashboards.organizationId, input.organizationId), eq(dashboards.isTemplate, true)))
          .limit(1);
        if (!winner[0]) throw e;
        row = await updateTemplate(winner[0].id);
      }
    }
    await writeAudit(q, { operation: "dashboards.materialize_template", actor: input.actor, row, metadata: { extensionId: input.extensionId, templateScope } });
    return row;
  });
}

export type MaterializeInstanceInput = {
  readonly extensionId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly actor: DashboardActor;
};

/**
 * Clone the extension's TEMPLATE into a per-project INSTANCE row. Idempotent on
 * (extension_id, organization_id, project_id). Throws if no template exists.
 */
export async function materializeExtensionInstanceForProject(
  tx: DashboardsDb | undefined,
  input: MaterializeInstanceInput,
): Promise<DashboardRow> {
  return withDashboardsTx(tx, async (q) => {
    const existingInstance = await q
      .select()
      .from(dashboards)
      .where(
        and(
          eq(dashboards.extensionId, input.extensionId),
          eq(dashboards.organizationId, input.organizationId),
          eq(dashboards.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (existingInstance[0]) return existingInstance[0];

    const template = await q
      .select()
      .from(dashboards)
      .where(
        and(
          eq(dashboards.extensionId, input.extensionId),
          eq(dashboards.organizationId, input.organizationId),
          eq(dashboards.isTemplate, true),
        ),
      )
      .limit(1);
    if (!template[0]) {
      throw new DashboardNotFoundError(`extension template ${input.extensionId} (org ${input.organizationId})`);
    }
    const t = template[0];
    let inserted: DashboardRow;
    try {
      const [row] = await q
        .insert(dashboards)
        .values({
          id: randomUUID(),
          name: t.name,
          description: t.description,
          configJson: t.configJson as never,
          configVersion: t.configVersion,
          ownerLevel: t.ownerLevel,
          ownerId: t.ownerId,
          organizationId: t.organizationId,
          visibility: t.visibility,
          status: "published",
          createdBy: input.actor.userId,
          extensionId: input.extensionId,
          isTemplate: false,
          templateScope: null,
          projectId: input.projectId,
        } as NewDashboardRow)
        .returning();
      inserted = row;
    } catch (e) {
      // Concurrent create lost the race to the (extension,org,project) partial-unique
      // index — return the winning instance row (idempotent).
      if ((e as { code?: string })?.code !== "23505") throw e;
      const winner = await q
        .select()
        .from(dashboards)
        .where(and(eq(dashboards.extensionId, input.extensionId), eq(dashboards.organizationId, input.organizationId), eq(dashboards.projectId, input.projectId)))
        .limit(1);
      if (!winner[0]) throw e;
      return winner[0];
    }
    await writeAudit(q, { operation: "dashboards.materialize_instance", actor: input.actor, row: inserted, metadata: { extensionId: input.extensionId, projectId: input.projectId } });
    return inserted;
  });
}

/** Archive (or restore) the template + all per-project instances of an extension.
 *  `reason` (cinatra#1628) is stamped on `archive_reason` so the durable-uninstall
 *  hook and the migration orphan sweep record WHY a row was archived (adopt-in-
 *  place restore, S11b, reads it). Only NON-archived rows are touched, so a
 *  re-fire is idempotent + never re-stamps an already-archived row's reason. */
export async function archiveExtensionDashboards(
  tx: DashboardsDb | undefined,
  input: { extensionId: string; organizationId: string; actor: DashboardActor; reason?: string },
): Promise<number> {
  return withDashboardsTx(tx, async (q) => {
    const rows = await q
      .update(dashboards)
      .set({
        status: "archived",
        archivedAt: new Date(),
        archiveReason: input.reason ?? null,
        updatedBy: input.actor.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(dashboards.extensionId, input.extensionId),
          eq(dashboards.organizationId, input.organizationId),
          ne(dashboards.status, "archived"),
        ),
      )
      .returning();
    for (const row of rows) {
      await writeAudit(q, { operation: "dashboards.extension_archive", actor: input.actor, row, metadata: { extensionId: input.extensionId, reason: input.reason ?? null } });
    }
    return rows.length;
  });
}

export async function restoreExtensionDashboards(
  tx: DashboardsDb | undefined,
  input: { extensionId: string; organizationId: string; actor: DashboardActor },
): Promise<number> {
  return withDashboardsTx(tx, async (q) => {
    const rows = await q
      .update(dashboards)
      .set({ status: "published", archivedAt: null, archiveReason: null, updatedBy: input.actor.userId, updatedAt: new Date() })
      .where(
        and(
          eq(dashboards.extensionId, input.extensionId),
          eq(dashboards.organizationId, input.organizationId),
          eq(dashboards.status, "archived"),
        ),
      )
      .returning();
    for (const row of rows) {
      await writeAudit(q, { operation: "dashboards.extension_restore", actor: input.actor, row, metadata: { extensionId: input.extensionId } });
    }
    return rows.length;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Adopt-in-place re-key (cinatra#1628, S11b — the AC2 "re-key not duplicate"
// recovery).
//
// When a LIVE successor `kind:"agent"` extension declares a
// `cinatra.dashboardContribution` whose `adopts` edge names an ORPHANED/legacy
// row's lineage, the reconciler adopts those rows IN PLACE: it re-keys
// `extension_id` (→ the successor package) + `contribution_id` (→ the successor's
// AGENT-era canonical lineage), un-archives them, and stamps the applied-version
// provenance — preserving the user's `config_json` overlay, the row id, and
// render continuity (NEVER a duplicate). Adoption is the transactional restore of
// a row the orphan sweep / lifecycle hook archived (recoverably).
//
// SAFETY INVARIANTS:
//   - ARCHIVED-ONLY: adoption re-keys ONLY `status = 'archived'` rows — it is the
//     RESTORE of an orphan the migration sweep or the uninstall/archive lifecycle
//     hook already archived (recoverably). This is the load-bearing guard against
//     clobbering a LIVE extension's still-published rows: a published (live)
//     extension row can NEVER be re-homed out from under its owner. If a legacy
//     package is still installed, the operator uninstalls it first (the hook
//     archives its rows), and only THEN can a successor adopt them.
//   - NEVER clobbers an OPERATOR row: `extension_id IS NOT NULL` scopes the write
//     to extension-owned rows only (an operator dashboard has extension_id NULL
//     and a NULL contribution_id, so it can match neither guard). An operator's
//     OWN archived dashboard is also excluded — it has extension_id NULL.
//   - EXACT lineage identity: matches on `(contribution_id ∈ matchLineageIds,
//     organizationId)`; a template and its per-project instances share the
//     lineage, so all re-key together onto the successor.
//   - IDEMPOTENT: after adoption the rows are `published` (restored), so a re-fire
//     is excluded by the archived-only gate; a row already keyed to the successor
//     identity is additionally excluded (belt-and-suspenders).
//   - ATOMIC + FAIL-CLOSED on collision: ONE UPDATE per successor across the UNION
//     of its adopts-edge candidate lineages, in ONE transaction. If re-keying the
//     matched rows would violate the successor's two-tier contribution uniqueness
//     (e.g. two distinct orphan templates collapsing onto one successor lineage,
//     or a successor that already materialized a template), the UNIQUE index
//     raises 23505 and the transaction ROLLS BACK — nothing is partially adopted;
//     the caller contains the throw per successor.
//   - The reconciler's PLANNER fails closed on cross-extension ambiguity BEFORE
//     this primitive is called (two successors contesting one lineage never reach
//     here), so this primitive assumes a single, resolved successor.
//
// BASELINE: the applied-default SNAPSHOT (`applied_default_json`/`_hash`) is the
// merge base for the deferred 3-way UPGRADE path — it is set here only when the
// caller resolves the successor's validated default; otherwise it is left
// untouched (adoption never fabricates a baseline from the user's current config,
// which would mis-attribute the user's customizations as the extension default
// and corrupt a later upgrade merge). Provenance (`applied_contribution_version`)
// is always stamped.
// ─────────────────────────────────────────────────────────────────────────

export type AdoptExtensionDashboardsInput = {
  readonly organizationId: string;
  /** The successor CARRIER package the rows are re-keyed onto. */
  readonly successorPackage: string;
  /** The AGENT-era canonical lineage id the rows are re-keyed TO. */
  readonly successorContributionId: string;
  /** The candidate legacy lineage ids to match orphaned rows on (from the
   *  planner's `adoptionMatchLineageIds`). */
  readonly matchLineageIds: readonly string[];
  /** The successor's declared DATA version — persisted as provenance. */
  readonly appliedContributionVersion: number;
  readonly actor: DashboardActor;
  /** Optional validated default SNAPSHOT + hash (the upgrade-merge base). Omit to
   *  leave the baseline untouched (set on the deferred materialize/upgrade path). */
  readonly appliedDefaultJson?: unknown;
  readonly appliedDefaultHash?: string;
};

/**
 * Transactionally adopt-in-place the orphaned rows matching `matchLineageIds` in
 * the org onto the successor identity. Returns the number of rows re-keyed (0
 * when no orphan matched — a safe no-op, e.g. already adopted or never stranded).
 */
export async function adoptExtensionDashboards(
  tx: DashboardsDb | undefined,
  input: AdoptExtensionDashboardsInput,
): Promise<number> {
  if (input.matchLineageIds.length === 0) return 0;
  const lineageIds = [...input.matchLineageIds];
  return withDashboardsTx(tx, async (q) => {
    const setPatch: Record<string, unknown> = {
      extensionId: input.successorPackage,
      contributionId: input.successorContributionId,
      appliedContributionVersion: input.appliedContributionVersion,
      // Adoption restores an orphan-swept / lifecycle-archived row to live.
      status: "published" as const,
      archivedAt: null,
      archiveReason: null,
      updatedBy: input.actor.userId,
      updatedAt: new Date(),
    };
    if (input.appliedDefaultJson !== undefined) {
      setPatch.appliedDefaultJson = input.appliedDefaultJson as never;
      setPatch.appliedDefaultHash = input.appliedDefaultHash ?? null;
    }

    const rows = await q
      .update(dashboards)
      .set(setPatch)
      .where(
        and(
          eq(dashboards.organizationId, input.organizationId),
          // RESTORE-of-archived ONLY: never re-home a LIVE (published) extension
          // row out from under its owner (the load-bearing anti-clobber guard).
          eq(dashboards.status, "archived"),
          // NEVER an operator row — extension-owned only.
          sql`${dashboards.extensionId} IS NOT NULL`,
          inArray(dashboards.contributionId, lineageIds),
          // Idempotency belt-and-suspenders: skip rows already keyed to the
          // successor identity (the archived gate already makes a re-fire a no-op).
          sql`NOT (${dashboards.extensionId} = ${input.successorPackage} AND ${dashboards.contributionId} = ${input.successorContributionId})`,
        ),
      )
      .returning();

    for (const row of rows) {
      await writeAudit(q, {
        operation: "dashboards.extension_adopt",
        actor: input.actor,
        row,
        metadata: {
          successorPackage: input.successorPackage,
          successorContributionId: input.successorContributionId,
          appliedContributionVersion: input.appliedContributionVersion,
          isTemplate: row.isTemplate,
          projectId: row.projectId,
        },
      });
    }
    return rows.length;
  });
}


// ---------------------------------------------------------------------------
// 3-WAY UPGRADE MERGE writer (cinatra#1628, S11c / remaining AC2).
//
// When a contribution's default changes (a new contributionVersion shipping a
// new sidecar default), upgrade each LIVE row of that contribution IN PLACE via
// the baseline-backed 3-way merge (`contribution-upgrade-merge.ts`): base =
// applied_default_json, theirs = the new default, ours = config_json. User
// customization is never clobbered; the baseline is re-based to theirs and the
// applied_contribution_version stamped. Single-writer + same-TX audit.
//
// BASELINE SEEDING: a row with NO applied_default_json (a legacy/adopted row that
// predates baseline capture) cannot be safely 3-way merged (no common ancestor).
// So the first upgrade SEEDS the baseline (applied_default_json = theirs) WITHOUT
// touching config_json — the user's current config is preserved verbatim, and the
// NEXT upgrade has a real base to merge against. The conservative no-clobber
// bootstrap.
//
// FAIL-CLOSED INTEGRITY: the merged config is re-validated structurally
// (validateDashboardConfigV12 — wiring integrity, no registry lookup) BEFORE it is
// written; a merge that would produce a dangling input binding (e.g. theirs
// removed a fixed-slot source the user's portlet still binds) is REJECTED and that
// row is left untouched (surfaced in `failed`), never persisted broken.
// ---------------------------------------------------------------------------

export type UpgradeExtensionDashboardsInput = {
  readonly organizationId: string;
  /** The contribution lineage id whose rows are upgraded (template + instances). */
  readonly contributionId: string;
  /** The NEW extension default (theirs) — the merge target. MUST be pre-validated
   *  by the caller (the materializer/reconciler validates the sidecar). */
  readonly newDefault: DashboardConfigLike;
  /** The new contribution DATA version, stamped as provenance. */
  readonly newContributionVersion: number;
  readonly actor: DashboardActor;
};

export type UpgradeExtensionDashboardsResult = {
  /** Rows whose config_json was 3-way merged + re-based. */
  readonly merged: number;
  /** Rows that only SEEDED a baseline (no prior applied_default_json). */
  readonly seeded: number;
  /** Rows already at this default, or where the merge changed nothing (re-based). */
  readonly unchanged: number;
  /** Rows left untouched because the merged config failed structural re-validation. */
  readonly failed: number;
};

/**
 * Upgrade every LIVE (published) row of a contribution in an org to a new default
 * via the baseline-backed 3-way merge. Idempotent (a row already at this
 * default+version is skipped) and no-clobber (user customization always wins).
 */
export async function upgradeExtensionDashboards(
  tx: DashboardsDb | undefined,
  input: UpgradeExtensionDashboardsInput,
): Promise<UpgradeExtensionDashboardsResult> {
  const newHash = computeAppliedDefaultHash(input.newDefault);
  return withDashboardsTx(tx, async (q) => {
    // Lock every matched row FOR UPDATE so a concurrent user edit (updateDashboard
    // uses SELECT FOR UPDATE too) cannot interleave between this read and the
    // merge write — the no-clobber guarantee holds under concurrency. A user edit
    // that commits first is read here as `ours`; one that arrives after blocks
    // until this tx commits and then re-bases on the merged result.
    const rows = await q
      .select()
      .from(dashboards)
      .where(
        and(
          eq(dashboards.organizationId, input.organizationId),
          eq(dashboards.contributionId, input.contributionId),
          sql`${dashboards.extensionId} IS NOT NULL`,
          eq(dashboards.status, "published"),
        ),
      )
      .for("update");

    let merged = 0;
    let seeded = 0;
    let unchanged = 0;
    let failed = 0;
    for (const row of rows) {
      // Idempotent: already at this exact default + version.
      if (
        row.appliedDefaultHash === newHash &&
        row.appliedContributionVersion === input.newContributionVersion
      ) {
        unchanged += 1;
        continue;
      }

      const base = (row.appliedDefaultJson ?? null) as unknown as DashboardConfigLike | null;
      if (base === null) {
        // No baseline -> SEED only (never clobber the user's current config).
        await q
          .update(dashboards)
          .set({
            appliedDefaultJson: input.newDefault as never,
            appliedDefaultHash: newHash,
            appliedContributionVersion: input.newContributionVersion,
            updatedBy: input.actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(dashboards.id, row.id));
        await writeAudit(q, {
          operation: "dashboards.extension_upgrade",
          actor: input.actor,
          row,
          metadata: { contributionId: input.contributionId, mode: "seed-baseline", appliedContributionVersion: input.newContributionVersion },
        });
        seeded += 1;
        continue;
      }

      const ours = (row.configJson ?? { portlets: [] }) as unknown as DashboardConfigLike;
      const { merged: mergedConfig, report, unchanged: noChange } = threeWayMergeDashboardConfig({
        base,
        theirs: input.newDefault,
        ours,
      });

      // FAIL-CLOSED integrity at the WRITE boundary (never trust a caller-side
      // prevalidation contract): re-validate the merged structure + wiring AND run
      // the AC4 link/URL guard on the merged result. A dangling binding (theirs
      // removed a source the user still consumes) OR an unsafe link leaves the row
      // untouched (surfaced in `failed`), never persisted.
      const check = validateDashboardConfigV12(mergedConfig);
      const linkErrors = collectUnsafeDashboardLinks(
        mergedConfig as unknown as Parameters<typeof collectUnsafeDashboardLinks>[0],
      );
      if (!check.ok || linkErrors.length > 0) {
        failed += 1;
        continue;
      }

      if (noChange) {
        // Merge changed nothing, but the baseline/version moved -> re-base (so the
        // NEXT upgrade has a fresh base) without a spurious config write.
        await q
          .update(dashboards)
          .set({
            appliedDefaultJson: input.newDefault as never,
            appliedDefaultHash: newHash,
            appliedContributionVersion: input.newContributionVersion,
            updatedBy: input.actor.userId,
            updatedAt: new Date(),
          })
          .where(eq(dashboards.id, row.id));
        await writeAudit(q, {
          operation: "dashboards.extension_upgrade",
          actor: input.actor,
          row,
          metadata: { contributionId: input.contributionId, mode: "rebase-only", appliedContributionVersion: input.newContributionVersion },
        });
        unchanged += 1;
        continue;
      }

      const [updated] = await q
        .update(dashboards)
        .set({
          configJson: mergedConfig as never,
          appliedDefaultJson: input.newDefault as never,
          appliedDefaultHash: newHash,
          appliedContributionVersion: input.newContributionVersion,
          dashboardVersion: row.dashboardVersion + 1,
          updatedBy: input.actor.userId,
          updatedAt: new Date(),
        })
        .where(eq(dashboards.id, row.id))
        .returning();
      await writeAudit(q, {
        operation: "dashboards.extension_upgrade",
        actor: input.actor,
        row: updated,
        metadata: {
          contributionId: input.contributionId,
          mode: "merge",
          added: report.added.length,
          updated: report.updated.length,
          removed: report.removed.length,
          keptCustomized: report.keptCustomized.length,
          conflicts: report.conflicts.length,
          appliedContributionVersion: input.newContributionVersion,
        },
      });
      merged += 1;
    }
    return { merged, seeded, unchanged, failed };
  });
}
