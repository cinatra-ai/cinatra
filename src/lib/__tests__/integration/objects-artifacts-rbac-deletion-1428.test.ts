/**
 * cinatra#1428 — RBAC matrix + deletion unification, REAL-SURFACE integration
 * test (no mocks on the DB path). Guarded by `describe.skipIf(!HAS_REAL_DB)`
 * like `artifact-materialization-ledger.test.ts`: CI without a reachable
 * Postgres emits zero failures and zero noise.
 *
 * AC2 (cross-surface authorization property): over seeded artifact-eligible
 * rows spanning owner levels (user / team / organization / workspace — in
 * BOTH the artifact composite visibility vocabulary and the objects column
 * vocabulary, so the property holds before AND after the sibling
 * vocabulary-normalization slice lands) and an actor matrix (owner member,
 * other member, team member, org admin, platform admin, service account):
 * NO row returned by one surface is denied by the other —
 *   objects surface  = objects_list / objects_get MCP handlers (real);
 *   artifact surface = listArtifacts / getArtifact service (real).
 *
 * AC3 (deletion unification): an artifact-surface delete emits the
 * object_change_event + the graphiti outbox 'delete' projection + an
 * undoable change_set, and `restoreChangeSet` actually restores the row.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

vi.mock("@/lib/database", () => ({
  readChatThreadForClassifier: () => null,
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
  readObjectsClassificationModelFromDatabase: () => "openai:gpt-4o-mini",
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => process.env.SUPABASE_DB_URL ?? "",
  get postgresSchema() {
    return process.env.SUPABASE_SCHEMA ?? "public";
  },
}));
// The artifact service warms the object-type registry through the heavy
// server-only barrel; the registry itself is irrelevant here (reads filter on
// the literal SEMANTIC_ARTIFACT_OBJECT_TYPE).
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));

const TEST_SCHEMA = "cinatra_test_rbac_del_1428";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const ORG = "org-1428";
const ARTIFACT_TYPE = "@cinatra-ai/artifact:object";
const U1 = "user-1428-a";
const U2 = "user-1428-b";
const ADMIN = "user-1428-admin";
const TEAM = "team-1428";

type SeedRow = {
  id: string;
  ownerLevel: "user" | "team" | "organization" | "workspace";
  ownerId: string;
  visibility: string;
  type?: string;
};

const ROWS: SeedRow[] = [
  // Artifact composite vocabulary (what the artifact write path emits today).
  { id: "r-user-own", ownerLevel: "user", ownerId: U1, visibility: `user:${U1}` },
  { id: "r-team", ownerLevel: "team", ownerId: TEAM, visibility: `team:${TEAM}` },
  { id: "r-org-composite", ownerLevel: "organization", ownerId: ORG, visibility: "org" },
  { id: "r-workspace", ownerLevel: "workspace", ownerId: ORG, visibility: "workspace" },
  // Objects column vocabulary (what objects_save emits today). The parity
  // property must hold for these too — whatever the data layer decides,
  // it must decide IDENTICALLY on both surfaces.
  { id: "r-user-other-private", ownerLevel: "user", ownerId: U2, visibility: "private" },
  { id: "r-org-column", ownerLevel: "organization", ownerId: ORG, visibility: "organization" },
  // Project-scoped visibility: reachable ONLY through the actor's
  // projectIds/projectGrants axis — locks the codex round-1 finding that
  // the read-scope actor must carry project grants through the bridge.
  { id: "r-project", ownerLevel: "organization", ownerId: ORG, visibility: "project:proj-1428" },
];

describe.skipIf(!HAS_REAL_DB)("cinatra#1428 RBAC + deletion unification (real DB)", () => {
  let client: Client;
  let priorSchemaEnv: string | undefined;

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
        continue;
      }
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    // Seed the artifact-eligible faceted rows + one non-artifact typed row
    // (never visible through the artifact surface regardless of authz).
    for (const r of [...ROWS, { id: "r-typed-nonartifact", ownerLevel: "organization" as const, ownerId: ORG, visibility: "org", type: "@cinatra-ai/campaigns:email" }]) {
      await client.query(
        `INSERT INTO "${TEST_SCHEMA}"."objects"
           (id, type, data, org_id, owner_level, owner_id, visibility, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          r.id,
          r.type ?? ARTIFACT_TYPE,
          JSON.stringify({ artifactType: "file", title: r.id, mime: "text/plain", size: 1, originKind: "upload" }),
          ORG,
          r.ownerLevel,
          r.ownerId,
          r.visibility,
        ],
      );
    }
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
  });

  // -------------------------------------------------------------------------
  // Actor matrix. Each actor exists in BOTH plumbing shapes:
  //   - the MCP primitive the objects handlers receive;
  //   - the kernel ActorContext the artifact service receives (built by the
  //     same bridge the production read path uses).
  // -------------------------------------------------------------------------
  type PrimitiveShape = Record<string, unknown>;
  const primitiveActors: Record<string, PrimitiveShape> = {
    ownerMember: { actorType: "human", source: "ui", userId: U1, orgId: ORG, organizationId: ORG, orgRole: "member" },
    otherMember: { actorType: "human", source: "ui", userId: U2, orgId: ORG, organizationId: ORG, orgRole: "member" },
    teamMember: { actorType: "human", source: "ui", userId: "user-1428-t", orgId: ORG, organizationId: ORG, orgRole: "member", teamIds: [TEAM] },
    orgAdmin: { actorType: "human", source: "ui", userId: ADMIN, orgId: ORG, organizationId: ORG, orgRole: "org_admin" },
    platformAdmin: { actorType: "human", source: "ui", userId: "user-1428-p", orgId: ORG, organizationId: ORG, platformRole: "platform_admin" },
    serviceAccount: { actorType: "model", source: "mcp", userId: "svc-1428", orgId: ORG, organizationId: ORG },
    projectMember: {
      actorType: "human",
      source: "ui",
      userId: "user-1428-proj",
      orgId: ORG,
      organizationId: ORG,
      orgRole: "member",
      projectIds: ["proj-1428"],
      projectGrants: [
        { projectId: "proj-1428", effectiveRole: "read", accessSource: "user" },
      ],
    },
  };

  async function objectsSurfaceListIds(primitive: PrimitiveShape): Promise<string[]> {
    const { createObjectsPrimitiveHandlers } = await import(
      "@cinatra-ai/objects/mcp-handlers"
    );
    const handlers = createObjectsPrimitiveHandlers();
    const res = (await handlers["objects_list"]({
      input: { type: ARTIFACT_TYPE, limit: 100 },
      actor: primitive as never,
    } as never)) as { items: Array<{ id: string }> };
    return res.items.map((i) => i.id).sort();
  }

  async function objectsSurfaceGet(primitive: PrimitiveShape, id: string): Promise<boolean> {
    const { createObjectsPrimitiveHandlers } = await import(
      "@cinatra-ai/objects/mcp-handlers"
    );
    const handlers = createObjectsPrimitiveHandlers();
    try {
      const res = (await handlers["objects_get"]({
        input: { objectId: id },
        actor: primitive as never,
      } as never)) as { object: unknown | null };
      return res.object != null;
    } catch {
      return false; // 404-hidden / denied
    }
  }

  async function artifactSurface(primitive: PrimitiveShape) {
    const { kernelActorForRead } = await import("@/lib/authz/enforce-resource-access");
    const { listArtifacts, getArtifact } = await import("@/lib/artifacts/artifact-service");
    const actor = kernelActorForRead(primitive as never, ORG);
    return {
      listIds: () =>
        listArtifacts({ orgId: ORG, actor, limit: 100 })
          .map((a) => a.artifactId)
          .sort(),
      get: (id: string) =>
        getArtifact({ artifactId: id, orgId: ORG, actor }) != null,
    };
  }

  for (const [name, primitive] of Object.entries(primitiveActors)) {
    it(`AC2 parity — ${name}: artifact list == objects list, and per-row get decisions agree`, async () => {
      const objectsIds = await objectsSurfaceListIds(primitive);
      const art = await artifactSurface(primitive);
      const artifactIds = art.listIds();

      // List parity (objects side already type-filtered to the artifact type).
      expect(artifactIds).toEqual(objectsIds);

      // Per-row read parity across every seeded faceted row.
      for (const r of ROWS) {
        const viaObjects = await objectsSurfaceGet(primitive, r.id);
        const viaArtifacts = art.get(r.id);
        expect(
          { row: r.id, viaObjects, viaArtifacts },
        ).toEqual({ row: r.id, viaObjects, viaArtifacts: viaObjects });
      }
    });
  }

  it("AC2 sanity: the property is not vacuous — the owner reads their own row and the org-composite row on BOTH surfaces", async () => {
    const ids = await objectsSurfaceListIds(primitiveActors.ownerMember);
    expect(ids).toContain("r-user-own");
    expect(ids).toContain("r-org-composite");
    const art = await artifactSurface(primitiveActors.ownerMember);
    expect(art.get("r-user-own")).toBe(true);
  });

  it("AC2 sanity: another member's private row is hidden on BOTH surfaces", async () => {
    const ids = await objectsSurfaceListIds(primitiveActors.ownerMember);
    expect(ids).not.toContain("r-user-other-private");
    const art = await artifactSurface(primitiveActors.ownerMember);
    expect(art.get("r-user-other-private")).toBe(false);
  });

  it("AC2 sanity: project grants reach the read scope — the granted member sees the project row on BOTH surfaces, others do not", async () => {
    const grantedIds = await objectsSurfaceListIds(primitiveActors.projectMember);
    expect(grantedIds).toContain("r-project");
    const grantedArt = await artifactSurface(primitiveActors.projectMember);
    expect(grantedArt.get("r-project")).toBe(true);

    const ungrantedIds = await objectsSurfaceListIds(primitiveActors.otherMember);
    expect(ungrantedIds).not.toContain("r-project");
    const ungrantedArt = await artifactSurface(primitiveActors.otherMember);
    expect(ungrantedArt.get("r-project")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC3 — deletion unification.
  // -------------------------------------------------------------------------
  it("AC3: artifact-surface delete emits change event + outbox delete and is undoable", async () => {
    const artifactId = `del-${randomUUID()}`;
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."objects"
         (id, type, data, org_id, owner_level, owner_id, visibility, version)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'org', 1)`,
      [artifactId, ARTIFACT_TYPE, JSON.stringify({ artifactType: "file", title: "del", mime: "text/plain", size: 1, originKind: "upload" }), ORG],
    );
    // Provider-cache row that must be invalidated in the same transaction.
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."artifact_provider_cache"
         (id, org_id, artifact_id, representation_revision_id, digest, provider, provider_file_id, mime)
       VALUES ($1, $2, $3, 'rev-x', 'sha-x', 'openai', 'file-x', 'text/plain')`,
      [randomUUID(), ORG, artifactId],
    );

    const { kernelActorForRead } = await import("@/lib/authz/enforce-resource-access");
    const { tombstoneArtifact, getArtifact } = await import(
      "@/lib/artifacts/artifact-service"
    );
    const adminActor = kernelActorForRead(
      primitiveActors.orgAdmin as never,
      ORG,
    );

    const res = tombstoneArtifact({
      orgId: ORG,
      artifactId,
      actor: adminActor,
      auditActor: ADMIN,
    });
    expect(res.changeSetId).toBeTruthy();

    // Row soft-deleted with a version bump (canonical CTE, not the raw UPDATE).
    const obj = await client.query(
      `SELECT deleted_at, version FROM "${TEST_SCHEMA}"."objects" WHERE id = $1`,
      [artifactId],
    );
    expect(obj.rows[0].deleted_at).not.toBeNull();
    expect(Number(obj.rows[0].version)).toBe(2);

    // Outbox delete projection.
    const outbox = await client.query(
      `SELECT operation, status FROM "${TEST_SCHEMA}"."graphiti_projection_outbox" WHERE object_id = $1`,
      [artifactId],
    );
    expect(outbox.rows.map((r: { operation: string }) => r.operation)).toContain("delete");

    // Change event with truthful actor attribution.
    const ev = await client.query(
      `SELECT operation, actor_id, actor_kind, restore_eligible, change_set_id
       FROM "${TEST_SCHEMA}"."object_change_event" WHERE object_id = $1`,
      [artifactId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].operation).toBe("soft-delete");
    expect(ev.rows[0].actor_id).toBe(ADMIN);
    expect(ev.rows[0].actor_kind).toBe("user");
    expect(ev.rows[0].restore_eligible).toBe(true);
    expect(ev.rows[0].change_set_id).toBe(res.changeSetId);

    // Provider cache invalidated atomically.
    const cache = await client.query(
      `SELECT 1 FROM "${TEST_SCHEMA}"."artifact_provider_cache" WHERE artifact_id = $1`,
      [artifactId],
    );
    expect(cache.rowCount).toBe(0);

    // Tombstoned row is hidden from the read surface.
    expect(
      getArtifact({ artifactId, orgId: ORG, actor: adminActor }),
    ).toBeNull();

    // UNDO through the standard object-history restore engine.
    const { restoreChangeSet } = await import("@/lib/object-history/restore-engine");
    const restored = restoreChangeSet({
      changeSetId: res.changeSetId!,
      actor: { actorId: ADMIN, actorKind: "user", orgId: ORG },
    });
    expect(restored.appliedEventCount).toBeGreaterThan(0);

    const after = await client.query(
      `SELECT deleted_at FROM "${TEST_SCHEMA}"."objects" WHERE id = $1`,
      [artifactId],
    );
    expect(after.rows[0].deleted_at).toBeNull();

    // Visible again through the artifact surface.
    expect(
      getArtifact({ artifactId, orgId: ORG, actor: adminActor }),
    ).not.toBeNull();
  });

  it("AC3: tombstone denies a plain member object.delete on the org-owned row (canonical governance)", async () => {
    const artifactId = `deny-${randomUUID()}`;
    await client.query(
      `INSERT INTO "${TEST_SCHEMA}"."objects"
         (id, type, data, org_id, owner_level, owner_id, visibility, version)
       VALUES ($1, $2, '{}', $3, 'organization', $3, 'org', 1)`,
      [artifactId, ARTIFACT_TYPE, ORG],
    );
    const { kernelActorForRead } = await import("@/lib/authz/enforce-resource-access");
    const { tombstoneArtifact } = await import("@/lib/artifacts/artifact-service");
    const memberActor = kernelActorForRead(primitiveActors.ownerMember as never, ORG);
    expect(() =>
      tombstoneArtifact({ orgId: ORG, artifactId, actor: memberActor, auditActor: U1 }),
    ).toThrow();
    const obj = await client.query(
      `SELECT deleted_at FROM "${TEST_SCHEMA}"."objects" WHERE id = $1`,
      [artifactId],
    );
    expect(obj.rows[0].deleted_at).toBeNull();
  });
});
