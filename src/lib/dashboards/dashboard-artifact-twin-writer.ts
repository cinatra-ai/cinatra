import "server-only";
import { randomUUID } from "node:crypto";

import { postgresSchema } from "@/lib/postgres-config";
import { rawWithParams } from "@/lib/dashboards/raw-with-params";
import { deriveDashboardScopeTuple } from "@/lib/dashboards/dashboard-scope-tuple";
import { buildBindingReconcileQueries } from "@/lib/objects/binding-write-path";
import { buildObjectsWithOutboxQuery, buildSoftDeleteObjectQuery } from "@/lib/objects-store";
import { buildAssertSemanticTypeQueries } from "@/lib/artifacts/semantic-assertion-store";
import { maybeBuildProducedEventInsertOp } from "@/lib/lifecycle/lifecycle-emit";
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
 *      UPSERT mode: scope axis (owner_level/owner_id/visibility/project_id) is the
 *      canonical Phase-2 scope-tuple mapping (cinatra#1898 — `deriveDashboardScopeTuple`),
 *      NOT the retired conservative floor. The graphiti outbox fires ONLY on a
 *      REAL objects-row change (delta D3).
 *   3. `representation` — a NEW revision `COALESCE(MAX(revision),0)+1` under the
 *      advisory lock (delta D2: rev=1 is merely the empty-history result). NOT
 *      outbox-gated — a no-op object update still advances the revision (D3).
 *   4. `artifact_audit` — the substrate audit row. NOT outbox-gated (D3).
 *   5. `buildBindingReconcileQueries` — spliced VERBATIM (drift tier a). The
 *      dashboard object type is self-registered + NON-dedicated-claim, so the
 *      winner CTE is empty and this is a no-op; splicing it pins the invariant.
 *   6. MEANING ASSERTION (cinatra#1896 Scope 2) — ONLY when the MATERIALIZE
 *      writers explicitly request it (`ctx.mintMeaningAssertion` true) AND a pack
 *      is named (`ctx.extensionId` non-null). Splices `buildAssertSemanticTypeQueries`
 *      (the same builder `assertSemanticType` uses) to mint an eligible
 *      `authoring_skill` (classic-basis) `semantic_assertion` for the twin artifact
 *      with `extension` = the materializing pack, precedence-guarded + idempotent
 *      under the held advisory lock. A user/operator/agent dashboard, and every
 *      non-materialize extension write (archive/restore/adopt/upgrade), mint none.
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
function buildDashboardRepresentationQuery(
  schema: string,
  ctx: DashboardTwinContext,
  representationRevisionId: string,
): SubstrateQuery {
  const s = schema.replaceAll('"', '""');
  return {
    text: `INSERT INTO "${s}"."representation"
  (id, org_id, artifact_id, resource_id, revision, form, created_by, created_by_run_id, classifier_signals)
SELECT $1::text, $2::text, $3::text, $4::text,
       COALESCE(MAX(r.revision), 0) + 1, '${DASHBOARD_REPRESENTATION_FORM}', $5::text, NULL, NULL
FROM "${s}"."representation" r
WHERE r.org_id = $2::text AND r.artifact_id = $3::text`,
    values: [
      representationRevisionId,
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
  // The append-only representation revision id for THIS twin write — generated
  // here (not inside the builder) so the lifecycle produced-event (below) can pin
  // it as its review target, matching the substrate revision the twin allocates.
  const representationRevisionId = randomUUID();
  // Phase-2 canonical scope-tuple mapping (cinatra#1898, epic #1883 §D7): the
  // object row's ownership axis derives PURELY from the dashboard's scope (owner
  // ruling 5) — user→private, team→team, org→organization, workspace→org-local
  // public, project→organization-owned/private/project-refined. The retired
  // conservative floor + Phase-1 dual authorization are gone; the single
  // canonical object.read filter now gates dashboard-typed rows outright, so this
  // tuple IS the ACL (a project row is org-owned+private so the filter admits it
  // only via the project clause — never a bare user/team owner clause).
  const scope = deriveDashboardScopeTuple({
    ownerLevel: ctx.ownerLevel,
    ownerId: ctx.ownerId,
    organizationId: ctx.orgId,
    projectId: ctx.projectId,
  });
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
    // Scope axis = the canonical Phase-2 mapping (NOT verbatim — a project row is
    // re-owned to the organization so the object.read filter gates it purely on
    // project membership).
    ownerLevel: scope.ownerLevel,
    ownerId: scope.ownerId,
    visibility: scope.visibility,
    projectId: scope.projectId,
  });

  const bindingOps = buildBindingReconcileQueries(schema, {
    orgId: ctx.orgId,
    artifactId: ctx.dashboardId,
  });

  // ── MEANING ASSERTION AT MATERIALIZATION (cinatra#1896 Scope 2) ──────────
  // Mint the pack's meaning as an eligible `authoring_skill` (CLASSIC-basis)
  // `semantic_assertion` for the twin artifact (`artifact_id = dashboardId`,
  // `extension = ctx.extensionId`), atomically in THIS twin tx — but ONLY when the
  // MATERIALIZE writers explicitly request it (`ctx.mintMeaningAssertion`), AND a
  // pack is named (`ctx.extensionId` non-null). A user/operator/agent dashboard
  // (extension_id null) and every non-materialize extension write (archive /
  // restore / adopt / upgrade — which also carry extension_id) take the empty
  // branch: the pre-#1896 twin behaviour is UNCHANGED for every path but the two
  // materialize calls. This NARROW gate (codex round adoption) is deliberate — a
  // broad "any extension_id upsert" gate would RE-MINT an eligible assertion onto
  // a dashboard being ARCHIVED on uninstall, and would leave both predecessor and
  // successor eligible after an adopt.
  //
  // `buildAssertSemanticTypeQueries` is the single-sourced builder `assertSemanticType`
  // uses (archive-same-ext-lower-or-equal-rank + precedence-guarded INSERT-RETURNING).
  // It requires the caller to (a) hold the per-artifact advisory lock and (b) run any
  // graphiti refresh in the same tx. (a) holds — the twin's query[0] is
  // `pg_advisory_xact_lock(hashtext(dashboardId))` (dashboardId == the artifact id).
  // (b) is intentionally a NO-OP here: a dashboard twin is NEVER graphiti-projected
  // (the projector's source gate rejects `source='dashboards-twin'`), and the meaning
  // is consumed via DIRECT `semantic_assertion` reads (`listEligibleAssertions`), so
  // no `buildGraphitiRefreshQueries` tail is appended.
  //
  // Idempotency + precedence: on a re-materialize the archive supersedes the prior
  // equal-rank authoring_skill and the INSERT re-creates it (net one eligible row;
  // the shared builder's supersede semantics, same as every other materializer that
  // calls `assertSemanticType`). A `user` pin (rank 3) OUTRANKS authoring_skill
  // (rank 2) — the INSERT's `WHERE NOT EXISTS` guard leaves it untouched. No binding
  // collision on `sa_active_unique_idx` is reachable: the twin artifact's object type
  // is the self-registered NON-dedicated generic `@cinatra-ai/dashboard-artifact:dashboard`,
  // so `buildBindingReconcileQueries`' winner CTE is always empty ⇒ no active binding
  // row for this artifact to collide with the classic INSERT.
  //
  // No migration: the `semantic_assertion` table + the `authoring_skill` source
  // already exist (semantic-assertion-schema.ts / semantic-assertion-store.ts).
  const meaningOps: SubstrateQuery[] =
    ctx.mintMeaningAssertion === true && ctx.extensionId != null
      ? buildAssertSemanticTypeQueries({
          orgId: ctx.orgId,
          artifactId: ctx.dashboardId,
          extension: ctx.extensionId,
          assertedBy: "authoring_skill",
          principal: ctx.actorId,
        }).queries
      : [];

  // ORDER: `meaningOps` BEFORE `bindingOps`. For the real fleet this is
  // immaterial — a dashboard twin's object type is the self-registered
  // NON-dedicated generic `dashboard`, so `bindingOps`' winner CTE is empty and
  // the reconcile is a total no-op (it neither archives nor inserts). The order
  // only matters in the (grep-verified-absent, hypothetical) case where a pack
  // holds a DEDICATED cross-claim over the base `dashboard` type AND materializes:
  // then the binding reconcile is the STRONGER identity, and running it AFTER the
  // classic mint lets its same-extension supersede archive the just-minted classic
  // row and install the binding instead — so a first materialize converges on the
  // binding identity WITHOUT an `sa_active_unique_idx` collision, rather than
  // rolling back. (A re-materialize of such a cross-claiming pack still fails
  // closed on the pre-existing binding — an accepted bound for an unsupported
  // manifest shape, never data corruption.)
  // ── LIFECYCLE-INTERCEPTIONS S1 PRODUCED EVENT (cinatra#2039, epic #2037) ──
  // The transactional ArtifactProduced event for the dashboard twin, written in
  // THIS same dashboards tx so review is driven by a durable, same-tx idempotent
  // event. FENCED default-OFF: `maybeBuildProducedEventInsertOp` returns null when
  // the S1 activation fence is off, so this splices NOTHING (the twin query list
  // is byte-identical to origin/main). ORIGIN: an extension-MATERIALIZED dashboard
  // (`extensionId` set) is `agent_generated` (review-eligible per policy); a
  // user/operator-built dashboard is `upload` (→ user_provided → the review core
  // default SKIPS, unless an org bound requires it). The dashboard produces no
  // external effect at write time, so `destinationClass` defaults to `none`.
  // Appended LAST — the twin's result rows are positional only for the pinned
  // substrate ops above (all before this); the event's result is never read.
  const s = schema.replaceAll('"', '""');
  const producedEventOp = maybeBuildProducedEventInsertOp(s, {
    orgId: ctx.orgId,
    artifactId: ctx.dashboardId,
    representationRevisionId,
    emitter: "dashboard_twin_writer",
    originKind: ctx.extensionId != null ? "agent_generated" : "upload",
    producerRunId: null,
    producerAgentId: null,
  });

  return [
    lock,
    buildDashboardResourceQuery(schema, ctx),
    objectsOutbox,
    buildDashboardRepresentationQuery(schema, ctx, representationRevisionId),
    buildDashboardAuditQuery(schema, ctx, "upsert"),
    ...meaningOps,
    ...bindingOps,
    ...(producedEventOp ? [producedEventOp] : []),
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
