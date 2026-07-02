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
import { eq, max, sql, and } from "drizzle-orm";
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
  validateDashboardConfigV12,
  DASHBOARD_CONFIG_V12_VERSION,
  type PortletKindLookup,
} from "./extension/dashboard-config-v12";
import { registerCorePortletKinds } from "./portlets/kinds";
import { getPortletKindDescriptor, validatePortletConfig } from "./portlets/registry";
import {
  isV12Envelope,
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
  | "dashboards.materialize_template"
  | "dashboards.materialize_instance"
  | "dashboards.extension_archive"
  | "dashboards.extension_restore";

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
      : reEnvelopeDcSave(opts.existingConfig, opts.existingConfig, fallbackScope);
  } else if (isV12Envelope(opts.config)) {
    // Already an envelope — pass through.
    resolved = opts.config;
  } else {
    // Rule 2: bare DC config → wrap, preserving the existing envelope's siblings/scope.
    resolved = reEnvelopeDcSave(opts.existingConfig, opts.config, fallbackScope);
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
    if (patch.name !== undefined) next.name = patch.name;
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

    // 3. INSERT ... ON CONFLICT DO UPDATE — atomic upsert.
    const insertRow: NewDashboardRow = {
      id,
      name: patch.name ?? existing?.name ?? "Untitled",
      description: existing?.description ?? null,
      configJson: nextConfig as never,
      configVersion,
      dashboardVersion: (existing?.dashboardVersion ?? 0) + 1,
      publishedRevisionNumber: existing?.publishedRevisionNumber ?? null,
      ownerLevel: effectiveOwnerLevel,
      ownerId: patch.ownerId ?? existing?.ownerId ?? actor.userId,
      organizationId: actor.organizationId,
      visibility: patch.visibility ?? existing?.visibility ?? "private",
      status: existing?.status ?? "draft",
      createdBy: existing?.createdBy ?? actor.userId,
      updatedBy: actor.userId,
    };
    const updateSet: Record<string, unknown> = {
      configJson: nextConfig as never,
      configVersion,
      updatedAt: new Date(),
      updatedBy: actor.userId,
      dashboardVersion: sql`${dashboards.dashboardVersion} + 1`,
    };
    if (patch.name !== undefined) updateSet.name = patch.name;
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

/** Archive (or restore) the template + all per-project instances of an extension. */
export async function archiveExtensionDashboards(
  tx: DashboardsDb | undefined,
  input: { extensionId: string; organizationId: string; actor: DashboardActor },
): Promise<number> {
  return withDashboardsTx(tx, async (q) => {
    const rows = await q
      .update(dashboards)
      .set({ status: "archived", archivedAt: new Date(), updatedBy: input.actor.userId, updatedAt: new Date() })
      .where(and(eq(dashboards.extensionId, input.extensionId), eq(dashboards.organizationId, input.organizationId)))
      .returning();
    for (const row of rows) {
      await writeAudit(q, { operation: "dashboards.extension_archive", actor: input.actor, row, metadata: { extensionId: input.extensionId } });
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
      .set({ status: "published", archivedAt: null, updatedBy: input.actor.userId, updatedAt: new Date() })
      .where(and(eq(dashboards.extensionId, input.extensionId), eq(dashboards.organizationId, input.organizationId)))
      .returning();
    for (const row of rows) {
      await writeAudit(q, { operation: "dashboards.extension_restore", actor: input.actor, row, metadata: { extensionId: input.extensionId } });
    }
    return rows.length;
  });
}
