// Real-DB integration proof for cinatra#1433 (epic #1424) — default/dynamic
// artifact coverage. Runs against a live Postgres (SUPABASE_DB_URL /
// SUPABASE_SCHEMA) — excluded from the fast `test:root` suite (root vitest
// excludes **/*.integration.test.ts). The three issue ACs end-to-end against
// real DDL + constraints:
//
//   AC-1  the default-artifact manifest's DEFAULT claim on
//         `@cinatra-ai/objects:object` activates through the #1432 lifecycle,
//         the floor rebalancer's artifact_type_claims EXISTS branch matches the
//         exact type, a REAL classic floor assertion lands, and
//         resolveEffectiveIdentity returns a selectable default-artifact
//         identity whose assertion id is the context/pinning candidate.
//   AC-2  a dynamic type minted `status='active'` (the MCP/install path)
//         resolves plain-object until the NEW org-scoped artifact-visibility
//         approval creates the org default claim; approval flips rows of the
//         type to default-artifact (truth-table rows 7–8). Denial ladder
//         (not_found / not_active / already_approved) proven on real rows.
//
// The object-side write axis is driven through the REAL universal writer
// (objects-store.ts upsertObjectAndEnqueue): its widened
// binding_reconcile_enqueue CTE is asserted directly — enqueues on a create
// into a DEFAULT-claimed type (platform arm in AC-1, org arm in AC-2),
// nothing on a content-only update, nothing in an org without the claim.
//   AC-3  a dedicated claimant dominates the org default claim ('dormant',
//         winner-change event), rows upgrade to the dedicated extension
//         (catalog browse-only until the binding lands, then
//         binding-selectable); retiring it reactivates the default claim with
//         a NEW generation and rows fall back to default-artifact WITHOUT
//         re-approval (the approval record persists through dormancy).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The full app bootstrap references Supabase-only tables (public.user) absent
// on a plain verify Postgres, so we no-op ensurePostgresSchema and build ONLY
// the tables this slice needs (minimal objects/outbox/installed_extension/
// dynamic_object_types/change_set/object_change_event + the merged
// assertion/claim leaves).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

// The root vitest config aliases @/lib/database to an inert unit-test stub
// (a placeholder DSN + schema 'cinatra'), which would sever the REAL universal
// writer (objects-store.ts upsertObjectAndEnqueue) from the live verify DB.
// This suite exists to drive that writer's binding_reconcile_enqueue CTE
// against real SQL, so re-point ONLY the connection surface at the real
// env-driven postgres-config; everything else keeps the stub's inert exports.
vi.mock("@/lib/database", async (importOriginal) => {
  const stub = await importOriginal<Record<string, unknown>>();
  const real = await import("@/lib/postgres-config");
  return {
    ...stub,
    postgresSchema: real.postgresSchema,
    getPostgresConnectionString: real.getPostgresConnectionString,
  };
});

import {
  parseArtifactObjectTypeClaims,
  validateObjectTypeClaimSchemaSources,
} from "@cinatra-ai/objects/claims";
import { DEFAULT_ARTIFACT_EXTENSION } from "@cinatra-ai/objects/artifact-floor";

import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { semanticAssertionSchemaQueries } from "@/lib/semantic-assertion-schema";
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";

import {
  activateArtifactExtensionClaims,
  retireArtifactExtensionClaims,
} from "@/lib/objects/artifact-claim-lifecycle";
import { readArtifactClaimEvents, readArtifactTypeClaimById } from "@/lib/objects/artifact-claim-store";
import { upsertObjectAndEnqueue } from "@/lib/objects-store";
import { processBindingReconcileQueue } from "@/lib/objects/binding-reconcile-sweep";
import { buildFloorRebalanceAndRefreshQueries } from "@/lib/artifacts/semantic-assertion-store";
import { computeClaimDispositionFingerprint } from "@/lib/artifacts/object-content-snapshot";
import { resolveArtifactEffectiveIdentity } from "@/lib/objects/effective-identity";
import {
  CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
  approveDynamicTypeArtifactVisibility,
  readDynamicTypeArtifactVisibilityApproval,
  listDynamicTypeVisibilityReviewRows,
  type DynamicTypeVisibilityDeps,
} from "@/lib/objects/artifact-visibility-approval";

const GENERIC_OBJECT_TYPE = "@cinatra-ai/objects:object";

// The exact claim entry the default-artifact manifest PR declares (cinatra#1433
// AC-1). Inline schema: the floor claims a type registered by
// `@cinatra-ai/objects` (not the claimant, not a manifest dependency), so the
// #1432 schema-source rule requires the schema shipped IN the claim.
const EXPECTED_FLOOR_CLAIM = {
  type: GENERIC_OBJECT_TYPE,
  claim: "default",
  dispositions: {
    projection: "artifact-safe",
    pinnable: false,
    snapshotPolicy: "none",
    sensitivity: "normal",
  },
  schema: { type: "object" },
} as const;

const S = () => postgresSchema.replaceAll('"', '""');
let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function exec(text: string) {
  runPostgresQueriesSync({ connectionString: getPostgresConnectionString(), queries: [{ text }] });
}

/** Seed an object row of a given type. */
function seedObject(input: { id: string; type: string; orgId: string; data?: unknown }) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization')`,
    [input.id, input.type, input.orgId, JSON.stringify(input.data ?? {})],
  );
}

/** Seed a dynamic_object_types row (the MCP/install mint shape). */
function seedDynamicType(input: { type: string; status: string; source?: string }) {
  sql(
    `INSERT INTO "${S()}"."dynamic_object_types" (type, display_name, inferred_category, slug, source, status)
     VALUES ($1,$2,'profile',$3,$4,$5)`,
    [input.type, `Display ${input.type}`, input.type.split(":")[1] ?? input.type, input.source ?? "mcp", input.status],
  );
}

/** Register a live installed_extension row so the effective-identity resolver
 * (which requires an INSTALLED extension) recognizes a dedicated winner. */
function seedInstalledArtifactExtension(pkg: string, orgId: string | null) {
  sql(
    `INSERT INTO "${S()}"."installed_extension" (id, package_name, kind, status, organization_id)
     VALUES ($1,$2,'artifact','active',$3)
     ON CONFLICT DO NOTHING`,
    [nextId("inst"), pkg, orgId],
  );
}

/** Drain the durable reconcile queue — the PRODUCTION trigger: claim winner
 * transitions enqueue 'binding-reconcile' rows (core__0034) and the object
 * write path enqueues per-artifact 'binding-reconcile-write' rows; the drain
 * reconciles bindings AND the guarded default-coverage floor (cinatra#1433). */
function drainQueue() {
  return processBindingReconcileQueue({ limit: 200 });
}

/** Save a row through the REAL universal writer (objects-store
 * upsertObjectAndEnqueue — the @/lib/database mock above points it at the
 * live verify DB): whether its `binding_reconcile_enqueue` CTE fires is
 * exactly the widened-predicate behavior under test, so nothing here touches
 * the queue by hand. */
function saveViaUniversalWriter(input: { id: string; type: string; orgId: string }) {
  return upsertObjectAndEnqueue({
    upsertInput: {
      id: input.id,
      type: input.type,
      orgId: input.orgId,
      data: { note: "written by the real universal writer" },
      createdBy: "it-1433",
      ownerLevel: "organization",
      ownerId: input.orgId,
      visibility: "organization",
    },
    operation: "upsert",
  });
}

/** PENDING write-reconcile queue rows for one artifact — the durable record
 * the writer's CTE either produced (predicate matched) or did not. */
function pendingWriteReconcileRows(
  artifactId: string,
): { scope: string; type: string; kind: string; orgId: string }[] {
  const r = sql(
    `SELECT scope, object_type_id, kind, org_id FROM "${S()}"."artifact_binding_reconcile_queue"
     WHERE object_id=$1 AND status='pending' ORDER BY created_at`,
    [artifactId],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    scope: String(row.scope),
    type: String(row.object_type_id),
    kind: String(row.kind),
    orgId: String(row.org_id),
  }));
}

/** Run the REAL floor-rebalance builder under the per-artifact advisory lock
 * (re-qualified to the isolated test schema — the binding-write-path
 * integration precedent; this still exercises the EXACT builder output). */
function runFloor(orgId: string, artifactId: string) {
  const reQualify = (t: string) =>
    t.replace(
      /"[a-z_0-9]+"\.("semantic_assertion"|"objects"|"graphiti_projection_outbox"|"artifact_type_claims")/g,
      (_m, tbl) => `"${S()}".${tbl}`,
    );
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: [
      { text: `SELECT pg_advisory_xact_lock(hashtext($1))`, values: [artifactId] },
      ...buildFloorRebalanceAndRefreshQueries(orgId, artifactId, "agent").map((qy) => ({
        text: reQualify(qy.text),
        values: qy.values,
      })),
    ],
  });
}

function floorAssertions(orgId: string, artifactId: string): { id: string; basis: string }[] {
  const r = sql(
    `SELECT id, assertion_basis FROM "${S()}"."semantic_assertion"
     WHERE org_id=$1 AND artifact_id=$2 AND extension=$3 AND eligibility='eligible'`,
    [orgId, artifactId, DEFAULT_ARTIFACT_EXTENSION],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    basis: String(row.assertion_basis),
  }));
}

/** Integration deps: real dynamic-type readers (drizzle, isolated schema) +
 * real claim store; only the floor-version read is injected (its canonical
 * store rides the full app schema, out of this fixture's scope — the version
 * is provenance, proven separately in the unit ladder). */
const IT_DEPS: DynamicTypeVisibilityDeps = {
  readInstalledFloorVersion: async () => "0.1.0",
};

beforeAll(() => {
  const s = S();
  exec(`CREATE SCHEMA IF NOT EXISTS "${s}"`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."objects" (
    id text PRIMARY KEY, type text NOT NULL, parent_id text, parent_type text,
    data jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(), created_by text, org_id text,
    source text, run_id text, agent_id text, package_version text,
    agent_spec_version text, version integer NOT NULL DEFAULT 1,
    graphiti_sync_status text DEFAULT 'pending', graphiti_projection_error text,
    owner_level text, owner_id text, visibility text, project_id text,
    deleted_at timestamptz )`);
  // The universal writer's canonical-history CTE arms (change_set +
  // object_change_event, mirroring src/lib/drizzle-store.ts) — the writer
  // emits both rows in the SAME transaction as the object upsert, so the
  // fixture must carry the leaves for the real writer to run at all.
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."change_set" (
    id text PRIMARY KEY, org_id text, opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz, closure_reason text, actor_id text, actor_kind text,
    run_id text, tool_call_id text, action_id text,
    effect_rollup text NOT NULL DEFAULT 'reversible-internal',
    restorable boolean NOT NULL DEFAULT true, restorable_reason text,
    parent_change_set_id text, restore_of_change_set_id text, created_by text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now() )`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."object_change_event" (
    id text PRIMARY KEY, change_set_id text NOT NULL, sequence integer NOT NULL,
    object_id text NOT NULL, object_type text NOT NULL, operation text NOT NULL,
    history_effect text NOT NULL, before_snapshot jsonb, after_snapshot jsonb,
    base_version integer, result_version integer NOT NULL,
    object_schema_version text NOT NULL DEFAULT 'v1',
    restore_eligible boolean NOT NULL DEFAULT true, restore_ineligible_reason text,
    compensating_template_id text, remote_revision_ref jsonb,
    actor_id text, actor_kind text, run_id text, audit_event_id text,
    org_id text, project_id text, owner_level text, owner_id text, visibility text,
    idempotency_key text NOT NULL, event_checksum text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), tombstoned_at timestamptz )`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."graphiti_projection_outbox" (
    id text PRIMARY KEY, object_id text NOT NULL, object_version integer NOT NULL,
    org_id text, operation text NOT NULL, payload_hash text,
    status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now() )`);
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."installed_extension" (
    id text PRIMARY KEY, package_name text NOT NULL, kind text NOT NULL,
    status text NOT NULL, organization_id text )`);
  // The globally-keyed dynamic-type registry (PK=type, NO org column — the
  // cinatra#1433 premise), mirroring packages/objects/src/schema.ts.
  exec(`CREATE TABLE IF NOT EXISTS "${s}"."dynamic_object_types" (
    type text PRIMARY KEY, display_name text NOT NULL, inferred_category text NOT NULL,
    slug text, json_schema jsonb, source text, confidence text,
    status text NOT NULL DEFAULT 'proposed', created_at timestamptz NOT NULL DEFAULT now(),
    created_by text, promoted_to_type text, origin_context jsonb, identity_key text )`);
  for (const query of [
    ...semanticAssertionSchemaQueries(postgresSchema),
    ...artifactClaimSchemaQueries(postgresSchema),
  ]) {
    exec(query.text);
  }
});

afterAll(async () => {
  // Close the lazy drizzle pool the REAL dynamic-type readers opened (the
  // approve path reads dynamic_object_types through @cinatra-ai/objects/db)
  // so the vitest process can exit.
  const pool = (globalThis as { __cinatraObjectsPool?: { end(): Promise<void> } }).__cinatraObjectsPool;
  await pool?.end().catch(() => {});
});

// RETIRED MODEL (epic #1785): these ACs prove the default-artifact-FLOOR +
// dynamic-default-coverage + catalog/binding IDENTITY model. A2 replaces
// effective identity with the type-driven resolver (no floor, no catalog, no
// binding-derived identity), so these identity assertions no longer describe
// production behavior. Skipped here (identity coverage is obsolete); the floor
// rebalancer + arbitration this also exercises is deleted in A5 and its DB rows
// purged in A6 — this file is removed with that plumbing.
describe.skip("AC-1 — generic-object floor claim (default-artifact manifest)", () => {
  it("the manifest claim entry is schema-valid and satisfies the #1432 schema-source rule with zero dependencies", () => {
    const parsed = parseArtifactObjectTypeClaims([EXPECTED_FLOOR_CLAIM]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      validateObjectTypeClaimSchemaSources({
        packageName: DEFAULT_ARTIFACT_EXTENSION,
        claims: parsed.claims,
        dependencyPackageNames: [],
      }),
    ).toEqual([]);
  });

  it("claim activates → floor EXISTS branch matches the exact type → real classic assertion → selectable default-artifact identity (context/pinning candidate)", () => {
    const orgId = nextId("org");
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type: GENERIC_OBJECT_TYPE, orgId });

    // BEFORE the claim: a typed (non-generic-artifact) row gets NO floor —
    // the EXISTS branch has nothing to match.
    runFloor(orgId, artifactId);
    expect(floorAssertions(orgId, artifactId)).toHaveLength(0);
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: GENERIC_OBJECT_TYPE }).identity,
    ).toMatchObject({ kind: "plain-object" });

    // INSTALL the manifest claim through the real #1432 lifecycle (platform
    // scope — the floor is a system extension).
    const activated = activateArtifactExtensionClaims(
      {
        scope: "platform",
        extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
        extensionVersion: "0.1.0",
        actor: "system",
      },
      [
        {
          type: EXPECTED_FLOOR_CLAIM.type,
          claim: EXPECTED_FLOOR_CLAIM.claim,
          dispositions: EXPECTED_FLOOR_CLAIM.dispositions,
        },
      ],
    );
    expect(activated).toHaveLength(1);
    expect(readArtifactTypeClaimById(activated[0].claimId)).toMatchObject({
      status: "active",
      claimKind: "default",
      scope: "platform",
      objectTypeId: GENERIC_OBJECT_TYPE,
    });

    // PRODUCTION trigger: the activation's winner-change enqueued a
    // 'binding-reconcile' row; the drain's guarded floor reconcile runs the
    // rebalancer, whose artifact_type_claims EXISTS branch matches o.type and
    // inserts a REAL semantic_assertion row.
    drainQueue();
    const floors = floorAssertions(orgId, artifactId);
    expect(floors).toHaveLength(1);
    expect(floors[0].basis).toBe("classic");
    // The direct builder path stays idempotent over the converged row.
    runFloor(orgId, artifactId);
    expect(floorAssertions(orgId, artifactId)).toHaveLength(1);

    // resolveEffectiveIdentity: default-artifact, selectable through the real
    // floor assertion id — the context/pinning candidate.
    const { identity } = resolveArtifactEffectiveIdentity({
      orgId,
      artifactId,
      baseType: GENERIC_OBJECT_TYPE,
    });
    expect(identity).toEqual({
      kind: "default-artifact",
      selectable: true,
      assertionId: floors[0].id,
    });

    // The PLATFORM-scope arm of the widened writer predicate: a NEW
    // generic-type row saved through the REAL universal writer enqueues its
    // own 'binding-reconcile-write' row (the platform floor claim matches),
    // and the drain floors it — no manual queue insert, no manual floor call.
    const savedViaWriter = nextId("obj");
    saveViaUniversalWriter({ id: savedViaWriter, type: GENERIC_OBJECT_TYPE, orgId });
    expect(pendingWriteReconcileRows(savedViaWriter)).toEqual([
      { scope: `org:${orgId}`, type: GENERIC_OBJECT_TYPE, kind: "binding-reconcile-write", orgId },
    ]);
    drainQueue();
    expect(floorAssertions(orgId, savedViaWriter)).toHaveLength(1);
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId: savedViaWriter, baseType: GENERIC_OBJECT_TYPE })
        .identity,
    ).toMatchObject({ kind: "default-artifact", selectable: true });

    // Pin candidacy rides the null-binding path: default-claimed rows never
    // carry bindings, so the snapshot fingerprint is the stable "none"
    // sentinel (object-content-snapshot.ts — proven generically by #1530).
    expect(
      computeClaimDispositionFingerprint({
        bindingClaimId: null,
        bindingGeneration: null,
        extension: null,
        dispositions: null,
      }),
    ).toBe("none");
  });
});

describe.skip("AC-2 — dynamic-type org approval gate", () => {
  it("an MCP/install-minted active dynamic type stays plain-object until the org approval; approval flips rows to default-artifact", async () => {
    const orgId = nextId("org");
    const type = `@cinatra-ai/dynamic:${nextId("dyn")}`;
    seedDynamicType({ type, status: "active", source: "mcp" });
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });

    // Premise: status='active' alone conveys NOTHING — no claim winner, no
    // floor, plain object.
    runFloor(orgId, artifactId);
    expect(floorAssertions(orgId, artifactId)).toHaveLength(0);
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type }).identity,
    ).toMatchObject({ kind: "plain-object", selectable: false });

    // The NEW org-scoped admin approval — reserve+activate the org default
    // claim via the landed primitives.
    const res = await approveDynamicTypeArtifactVisibility(
      { orgId, objectTypeId: type, approvedBy: "admin-1" },
      IT_DEPS,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readArtifactTypeClaimById(res.claimId)).toMatchObject({
      scope: `org:${orgId}`,
      claimKind: "default",
      extensionPackage: DEFAULT_ARTIFACT_EXTENSION,
      status: "active",
      dispositions: CONSERVATIVE_DYNAMIC_COVERAGE_DISPOSITIONS,
    });

    // The approval record is readable and the review surface pairs it.
    expect(
      await readDynamicTypeArtifactVisibilityApproval({ orgId, objectTypeId: type }, IT_DEPS),
    ).toMatchObject({ claimId: res.claimId, status: "active", generation: 1 });
    const reviewRows = await listDynamicTypeVisibilityReviewRows({ orgId }, IT_DEPS);
    expect(reviewRows.find((r) => r.objectTypeId === type)?.approval?.claimId).toBe(res.claimId);

    // Coverage flips through the PRODUCTION trigger — the approval's claim
    // activation enqueued the winner-change reconcile; the drain floors the
    // type's EXISTING rows. Identity = default-artifact selectable
    // (truth-table rows 7–8).
    drainQueue();
    const floors = floorAssertions(orgId, artifactId);
    expect(floors).toHaveLength(1);
    const { identity } = resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type });
    expect(identity).toEqual({
      kind: "default-artifact",
      selectable: true,
      assertionId: floors[0].id,
    });

    // A row saved AFTER the approval rides the OBJECT-side axis THROUGH THE
    // REAL universal writer: upsertObjectAndEnqueue's widened
    // binding_reconcile_enqueue CTE (org-scope arm: a live DEFAULT claim at
    // 'org:<id>') must itself record the 'binding-reconcile-write' row in the
    // upsert transaction; the drain then floors exactly that row.
    const savedLater = nextId("obj");
    saveViaUniversalWriter({ id: savedLater, type, orgId });
    expect(pendingWriteReconcileRows(savedLater)).toEqual([
      { scope: `org:${orgId}`, type, kind: "binding-reconcile-write", orgId },
    ]);
    drainQueue();
    expect(floorAssertions(orgId, savedLater)).toHaveLength(1);
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId: savedLater, baseType: type }).identity,
    ).toMatchObject({ kind: "default-artifact", selectable: true });

    // A CONTENT-ONLY update (same type) through the real writer enqueues
    // NOTHING — the CTE's create/type-change predicate excludes it.
    saveViaUniversalWriter({ id: savedLater, type, orgId });
    expect(pendingWriteReconcileRows(savedLater)).toEqual([]);

    // ORG-SCOPED: the same type in ANOTHER org stays a plain object — and the
    // real writer's CTE correctly enqueues NOTHING there (no live claim at
    // 'org:<other>' and none at 'platform' for this type).
    const otherOrg = nextId("org");
    const otherArtifact = nextId("obj");
    saveViaUniversalWriter({ id: otherArtifact, type, orgId: otherOrg });
    expect(pendingWriteReconcileRows(otherArtifact)).toEqual([]);
    runFloor(otherOrg, otherArtifact);
    expect(floorAssertions(otherOrg, otherArtifact)).toHaveLength(0);
    expect(
      resolveArtifactEffectiveIdentity({ orgId: otherOrg, artifactId: otherArtifact, baseType: type })
        .identity,
    ).toMatchObject({ kind: "plain-object" });
  });

  it("denial ladder on real rows: not_found / not_active (proposed + archived) / already_approved", async () => {
    const orgId = nextId("org");

    const missing = await approveDynamicTypeArtifactVisibility(
      { orgId, objectTypeId: `@cinatra-ai/dynamic:${nextId("nope")}`, approvedBy: "admin-1" },
      IT_DEPS,
    );
    expect(missing).toMatchObject({ ok: false, code: "not_found" });

    const proposed = `@cinatra-ai/dynamic:${nextId("proposed")}`;
    seedDynamicType({ type: proposed, status: "proposed" });
    expect(
      await approveDynamicTypeArtifactVisibility(
        { orgId, objectTypeId: proposed, approvedBy: "admin-1" },
        IT_DEPS,
      ),
    ).toMatchObject({ ok: false, code: "not_active" });

    const archived = `@cinatra-ai/dynamic:${nextId("archived")}`;
    seedDynamicType({ type: archived, status: "archived" });
    expect(
      await approveDynamicTypeArtifactVisibility(
        { orgId, objectTypeId: archived, approvedBy: "admin-1" },
        IT_DEPS,
      ),
    ).toMatchObject({ ok: false, code: "not_active" });

    const active = `@cinatra-ai/dynamic:${nextId("active")}`;
    seedDynamicType({ type: active, status: "active" });
    const first = await approveDynamicTypeArtifactVisibility(
      { orgId, objectTypeId: active, approvedBy: "admin-1" },
      IT_DEPS,
    );
    expect(first.ok).toBe(true);
    expect(
      await approveDynamicTypeArtifactVisibility(
        { orgId, objectTypeId: active, approvedBy: "admin-2" },
        IT_DEPS,
      ),
    ).toMatchObject({ ok: false, code: "already_approved" });
  });
});

describe.skip("AC-3 — dedicated upgrade / retirement fallback", () => {
  it("dedicated install dormants the org default; rows upgrade (catalog → binding); retirement reactivates coverage on a NEW generation with NO re-approval", async () => {
    const orgId = nextId("org");
    const scope = `org:${orgId}`;
    const type = `@cinatra-ai/dynamic:${nextId("dyn3")}`;
    const pkg = "@vendor/dyn-dedicated-artifact";
    seedDynamicType({ type, status: "active", source: "install" });
    const artifactId = nextId("obj");
    seedObject({ id: artifactId, type, orgId });

    // (1) org approval → default coverage.
    const approval = await approveDynamicTypeArtifactVisibility(
      { orgId, objectTypeId: type, approvedBy: "admin-1" },
      IT_DEPS,
    );
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    drainQueue();
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type }).identity,
    ).toMatchObject({ kind: "default-artifact", selectable: true });

    // (2) DEDICATED claim installs on the same type → the default claim goes
    // 'dormant' (winner-change event), rows upgrade to the dedicated
    // extension: catalog browse-only until the binding lands.
    seedInstalledArtifactExtension(pkg, orgId);
    const [dedicated] = activateArtifactExtensionClaims(
      { scope, extensionPackage: pkg, extensionVersion: "1.0.0", actor: "system" },
      [{ type, claim: "dedicated", dispositions: { projection: "artifact-safe" } }],
    );
    expect(readArtifactTypeClaimById(approval.claimId)).toMatchObject({ status: "dormant" });
    const dormancyEvents = readArtifactClaimEvents(scope, type).filter(
      (e) =>
        e.event === "winner-change" &&
        (e.payload as { reason?: string } | null)?.reason === "dedicated-activated",
    );
    expect(dormancyEvents.length).toBeGreaterThan(0);
    // The approval record persists through dormancy (claim-as-record).
    expect(
      await readDynamicTypeArtifactVisibilityApproval({ orgId, objectTypeId: type }, IT_DEPS),
    ).toMatchObject({ claimId: approval.claimId, status: "dormant" });

    const catalogIdentity = resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type }).identity;
    expect(catalogIdentity).toEqual({
      kind: "extension",
      extension: pkg,
      basis: "catalog",
      selectable: false,
      assertionId: null,
    });

    // ONE production drain converges the takeover: the binding lands
    // (binding-selectable) and the guarded floor reconcile archives the floor
    // default (a non-default eligible assertion now exists).
    drainQueue();
    expect(floorAssertions(orgId, artifactId)).toHaveLength(0);
    const boundIdentity = resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type }).identity;
    expect(boundIdentity).toMatchObject({
      kind: "extension",
      extension: pkg,
      basis: "binding",
      selectable: true,
    });

    // (3) RETIRE/uninstall the dedicated claimant → the default claim
    // reactivates with a NEW generation; rows fall back WITHOUT re-approval.
    const result = retireArtifactExtensionClaims({
      scope,
      extensionPackage: pkg,
      extensionVersion: "1.0.0",
      actor: "system",
    });
    expect(result.retiredClaims).toContain(dedicated.claimId);

    const reactivated = readArtifactTypeClaimById(approval.claimId);
    expect(reactivated).toMatchObject({ status: "active", generation: 2 });
    const reactivationEvents = readArtifactClaimEvents(scope, type).filter(
      (e) =>
        e.event === "winner-change" &&
        (e.payload as { reason?: string } | null)?.reason === "dedicated-retired",
    );
    expect(reactivationEvents.length).toBeGreaterThan(0);

    // The SAME approval record — no new approval call happened; the record
    // (claim row) carries the new generation.
    expect(
      await readDynamicTypeArtifactVisibilityApproval({ orgId, objectTypeId: type }, IT_DEPS),
    ).toMatchObject({ claimId: approval.claimId, status: "active", generation: 2 });

    // Fallback identity through the PRODUCTION trigger: the reactivation's
    // winner-change enqueued the reconcile; the drain's guarded floor
    // reconcile re-lands the floor now that the reactivated default claim
    // matches the EXISTS branch again.
    drainQueue();
    const floors = floorAssertions(orgId, artifactId);
    expect(floors).toHaveLength(1);
    expect(
      resolveArtifactEffectiveIdentity({ orgId, artifactId, baseType: type }).identity,
    ).toEqual({ kind: "default-artifact", selectable: true, assertionId: floors[0].id });
  });
});
