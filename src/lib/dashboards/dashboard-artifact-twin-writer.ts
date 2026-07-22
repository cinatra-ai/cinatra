import "server-only";
import { randomUUID } from "node:crypto";

import { postgresSchema } from "@/lib/postgres-config";
import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import { buildObjectsWithOutboxQuery } from "@/lib/objects/objects-outbox-cte";
import { buildBindingReconcileQueries } from "@/lib/objects/binding-write-path";
import { buildSoftDeleteObjectQuery } from "@/lib/objects-store";
import {
  setDashboardArtifactTwinWriter,
  type DashboardArtifactTwinWriter,
  type DashboardTwinContext,
  type TwinTx,
} from "@cinatra-ai/dashboards/twin-writer-seam";

/**
 * The HOST dashboards-artifact TWIN WRITER (cinatra#1894, epic #1883 §D7 /
 * decomposition #1944 B1b).
 *
 * Registered into the `packages/dashboards` fail-closed seam at boot. Every
 * dashboards mutation calls `pairTwin(tx, ctx)`, which dispatches HERE INSIDE the
 * dashboards Drizzle transaction — the ONE already holding the dashboard row
 * lock. We run the artifact-substrate writes on that SAME connection via
 * `tx.execute(rawWithParams(text, values))`, so the substrate twin lands
 * ATOMICALLY with the dashboards row: no second writer, no post-commit
 * reconcile. A twin throw propagates and rolls the whole mutation back.
 *
 * This module lives host-side (it consumes `@/lib` substrate builders) and
 * self-registers on import; the core-boot phase imports it + asserts registration.
 *
 * === WHAT THE TWIN WRITES (operation === "upsert") ===
 *   0. `pg_advisory_xact_lock(hashtext(dashboardId))` — FIRST (delta D2). Serializes
 *      the representation-revision allocation for this dashboard; lock order is the
 *      dashboards-row SELECT…FOR UPDATE (already taken by the caller) → this
 *      advisory lock. Per-id key (hashtext(dashboardId)) is disjoint from the
 *      artifact substrate's own hashtext(artifactId) keys (delta D5).
 *   1. `resource` (kind='dashboard') — a deterministic-id, substance-keyed row so
 *      the append-only `representation` has a stable resource to point at. Idempotent.
 *   2. `objects` + `graphiti_projection_outbox` — the SHARED single-CTE builder in
 *      UPSERT mode: scope axis (owner_level/owner_id/project_id) copied VERBATIM
 *      from the dashboards row, visibility derived conservatively. The graphiti
 *      outbox fires ONLY on a REAL objects-row change (delta D3).
 *   3. `representation` — a NEW revision `COALESCE(MAX(revision),0)+1` under the
 *      advisory lock (delta D2: rev=1 is merely the empty-history result). NOT
 *      outbox-gated — a no-op object update still advances the revision (D3).
 *   4. `artifact_audit` — the substrate audit row. NOT outbox-gated (D3).
 *   5. `buildBindingReconcileQueries` — spliced VERBATIM (drift tier a). The
 *      dashboard object type is self-registered + NON-dedicated-claim, so the
 *      winner CTE is empty and this is a no-op; splicing it pins the invariant.
 *
 * === DELETE (operation === "delete", Q2 CONFIRMED) ===
 *   0. `pg_advisory_xact_lock(hashtext(dashboardId))`.
 *   1. `buildSoftDeleteObjectQuery` VERBATIM (drift tier a): objects `deleted_at`
 *      tombstone + a 'delete' graphiti outbox op + change_set + object_change_event,
 *      one atomic CTE. No explicit claim-binding withdraw is required — a dashboard
 *      mints no dedicated claim binding, so the tombstone + delete outbox suffice.
 *   2. `artifact_audit` (action='delete').
 */

/** The `objects.type` a dashboard artifact carries — the self-registered,
 *  NON-dedicated-claim type enrolled by `@cinatra-ai/dashboard-artifact` (B1a).
 *  Namespaced `<package>:<type>` per the artifact object-type convention. Because
 *  no dedicated claim is minted for it, `buildBindingReconcileQueries`' winner CTE
 *  is always empty (self-claim only). */
export const DASHBOARD_OBJECT_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";

/** The substrate `resource.kind` + `representation.form` a dashboard uses (both
 *  admitted by the B1a CHECK-constraint widening). */
const DASHBOARD_RESOURCE_KIND = "dashboard";
const DASHBOARD_REPRESENTATION_FORM = "dashboard";
const DASHBOARD_RESOURCE_MIME = "application/vnd.cinatra.dashboard+json";
/** Provenance tag on the twin's objects write (distinct from the artifact path's
 *  `'route'`). */
const TWIN_SOURCE = "dashboards-twin";

type SubstrateQuery = { text: string; values: readonly unknown[] };

/**
 * Derive the substrate `objects.visibility` CONSERVATIVELY from the dashboards
 * row's owner axis (cinatra#1894 scope-axis section). A project-scoped dashboard
 * floors to `private`; otherwise the owner tier maps to its natural share axis,
 * with `workspace` taking the conservative floor. Phase-1 dual-auth
 * (`resolveDashboardAccess` still gates dashboard-typed rows) is the safety
 * margin that permits the floor.
 */
export function deriveConservativeVisibility(
  ownerLevel: string,
  projectId: string | null,
): "private" | "team" | "organization" {
  if (projectId != null) return "private";
  switch (ownerLevel) {
    case "team":
      return "team";
    case "organization":
      return "organization";
    case "user":
      return "private";
    // workspace (and any unknown tier) → conservative floor.
    default:
      return "private";
  }
}

/** A stable, per-dashboard `resource.id`. The resource is 1:1 with the dashboard
 *  (substance_key = dashboardId), so a deterministic id lets the representation
 *  point at it WITHOUT a cross-statement RETURNING round-trip through the bridge. */
function dashboardResourceId(dashboardId: string): string {
  return `dashboard-resource:${dashboardId}`;
}

/** The deterministic-id, substance-keyed `resource` row for a dashboard. Idempotent:
 *  first mutation INSERTs, later ones DO NOTHING (the row never changes). */
function buildDashboardResourceQuery(schema: string, ctx: DashboardTwinContext): SubstrateQuery {
  const s = schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."resource"
  (id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, metadata, created_by)
VALUES ($1::text, $2::text, '${DASHBOARD_RESOURCE_KIND}', $3::text, '${DASHBOARD_RESOURCE_MIME}', 0, 'skipped', '{}'::jsonb, $4::text)
ON CONFLICT (id) DO NOTHING`,
    values: [dashboardResourceId(ctx.dashboardId), ctx.orgId, ctx.dashboardId, ctx.actorId ?? null],
  };
}

/** The next append-only `representation` revision for this dashboard, allocated
 *  `COALESCE(MAX(revision),0)+1` under the held advisory lock (delta D2). One
 *  statement — the aggregate SELECT over the (org, artifact) history feeds the
 *  INSERT. Always advances (NOT outbox-gated, D3). */
function buildDashboardRepresentationQuery(schema: string, ctx: DashboardTwinContext): SubstrateQuery {
  const s = schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, classifier_signals)
SELECT $1::text, $2::text, $3::text, $4::text,
       COALESCE(MAX(r.revision), 0) + 1, '${DASHBOARD_REPRESENTATION_FORM}', $5::text, NULL, NULL
FROM "${s}"."representation" r
WHERE r.org_id = $2::text AND r.artifact_id = $3::text`,
    values: [
      randomUUID(),
      ctx.orgId,
      ctx.dashboardId,
      dashboardResourceId(ctx.dashboardId),
      ctx.actorId ?? null,
    ],
  };
}

/** The substrate `artifact_audit` row (distinct from the dashboards `audit_events`
 *  row the mutation service already writes). Always advances (NOT outbox-gated, D3). */
function buildDashboardAuditQuery(
  schema: string,
  ctx: DashboardTwinContext,
  action: "upsert" | "delete",
): SubstrateQuery {
  const s = schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."artifact_audit"
  (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
VALUES (gen_random_uuid()::text, $1::text, $2::text, NULL, $3::text, $4::text, $5::jsonb)`,
    values: [
      ctx.orgId,
      ctx.dashboardId,
      action,
      ctx.actorId ?? null,
      JSON.stringify({ twin: true, operation: action, source: TWIN_SOURCE }),
    ],
  };
}

/** Build the ORDERED substrate query list for a twin call. Pure — the caller runs
 *  each `{text,values}` on the dashboards tx via `tx.execute(rawWithParams(...))`. */
export function buildDashboardTwinQueries(ctx: DashboardTwinContext): SubstrateQuery[] {
  const schema = postgresSchema;

  // 0. Advisory lock FIRST (delta D2) — serializes representation revision.
  const lock: SubstrateQuery = {
    text: `SELECT pg_advisory_xact_lock(hashtext($1))`,
    values: [ctx.dashboardId],
  };

  if (ctx.operation === "delete") {
    // Soft-delete tombstone VERBATIM (drift tier a). No binding withdraw (Q2).
    const { query } = buildSoftDeleteObjectQuery({
      id: ctx.dashboardId,
      orgId: ctx.orgId,
      actorId: ctx.actorId,
      actorKind: "user",
    });
    return [lock, query, buildDashboardAuditQuery(schema, ctx, "delete")];
  }

  // operation === "upsert".
  const visibility = deriveConservativeVisibility(ctx.ownerLevel, ctx.projectId);
  const objectsOutbox = buildObjectsWithOutboxQuery(schema, "upsert", {
    id: ctx.dashboardId,
    type: DASHBOARD_OBJECT_TYPE,
    parentId: null,
    parentType: null,
    // Minimal IDENTITY payload — the config body lives in dashboards.config_json;
    // the objects row mirrors the artifact's identity/scope only. A config-only
    // edit leaves this + the scope axis unchanged ⇒ a no-op object update (D3).
    dataJson: JSON.stringify({ kind: "dashboard", dashboardId: ctx.dashboardId }),
    createdBy: ctx.actorId ?? null,
    orgId: ctx.orgId,
    source: TWIN_SOURCE,
    // Scope axis copied VERBATIM from the dashboards row.
    ownerLevel: ctx.ownerLevel,
    ownerId: ctx.ownerId,
    visibility,
    projectId: ctx.projectId,
  });

  const bindingOps = buildBindingReconcileQueries(schema, {
    orgId: ctx.orgId,
    artifactId: ctx.dashboardId,
  });

  return [
    lock,
    buildDashboardResourceQuery(schema, ctx),
    objectsOutbox,
    buildDashboardRepresentationQuery(schema, ctx),
    buildDashboardAuditQuery(schema, ctx, "upsert"),
    ...bindingOps,
  ];
}

/** The registered twin writer: run each substrate query on the dashboards tx. */
export const dashboardArtifactTwinWriter: DashboardArtifactTwinWriter = async (
  tx: TwinTx,
  ctx: DashboardTwinContext,
): Promise<void> => {
  for (const q of buildDashboardTwinQueries(ctx)) {
    await tx.execute(rawWithParams(q.text, q.values));
  }
};

/** Register the host twin writer into the dashboards seam. Idempotent for the
 *  same reference (delta D4) — the boot phase may re-import this module. */
export function registerDashboardArtifactTwinWriter(): void {
  setDashboardArtifactTwinWriter(dashboardArtifactTwinWriter);
}

// Self-register on import (mirrors extension-dashboard-lifecycle-wiring): a
// side-effect import from the core-boot phase installs the twin.
registerDashboardArtifactTwinWriter();
