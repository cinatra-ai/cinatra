/**
 * cinatra#1430 follow-up — the public MCP `context_resolve` path captures
 * content snapshots at resolution time (the PR #1530 round-3 deferral).
 *
 * REAL-DB integration proof driving the ACTUAL `registerContextPrimitives`
 * `context_resolve` tool handler end-to-end (not the bare `resolveContextSlot`
 * unit, which context-resolver.test.ts already covers for `snapshotPins`):
 *
 *   - a CLAIMED typed row (eligible BINDING; dispositions pinnable:true +
 *     snapshotPolicy:'content') appears in the MCP tool's returned `refs`
 *     with a concrete representationRevisionId backed by a REAL
 *     `object_content_snapshots` keying row (captured-or-reused);
 *   - a second MCP resolve keyed-REUSES (idempotent — no second snapshot);
 *   - generic (unclaimed) artifact resolution is unchanged: latest-revision
 *     join, `capture.pins` empty, ZERO snapshot rows minted;
 *   - denial / fail-closed: no orgId in the MCP context; unknown + duplicate
 *     slotId; a foreign-org actor resolves [] and mints nothing; a projectId
 *     outside the actor's grants resolves [] and mints nothing.
 *
 * ISOLATION (the object-content-snapshot.integration.test.ts pattern): fresh
 * schema per file from the CANONICAL `buildCreateStoreSchemaQueries` DDL;
 * blob root in a temp dir; every app module dynamically imported in
 * `beforeAll` AFTER the env is set (postgresSchema is a module-load const).
 *
 * Two deliberate seams (everything else is the real path):
 *   - `@cinatra-ai/mcp-server` is replaced with a REAL AsyncLocalStorage —
 *     the identical run/getStore contract — because the package facade drags
 *     the MCP SDK transport graph this suite doesn't exercise;
 *   - `registerAllObjectTypes` is a no-op — the app-boot registrar graph
 *     (blog/agents/workflows/extension registrars) is irrelevant here:
 *     `getInstalledExtensionDescriptors()` still runs for real over the
 *     registry, and descriptors only feed satisfies-EXPANSION (unit-covered
 *     in context-resolver.test.ts); the slots below accept their extensions
 *     DIRECTLY.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// Same @/lib/database surface as the sibling #1430 integration suite: the
// root vitest alias lacks the named exports the artifact graph imports.
vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// See header — a real AsyncLocalStorage with the identical contract.
vi.mock("@cinatra-ai/mcp-server", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return { mcpRequestContextStorage: new AsyncLocalStorage() };
});
// See header — registry warm no-op'd; descriptor derivation stays real.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_context_mcp_1430";
const ORG = "org-mcp-1430";
const USER = "user-mcp-1430";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

// Dynamically-bound app modules (assigned in beforeAll AFTER env set).
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let contextMcpMod: typeof import("@/lib/artifacts/context-mcp");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let mcpStorage: {
  run<T>(store: unknown, cb: () => T): T;
  getStore(): unknown;
};

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function seedObject(id: string, type: string, data: unknown) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
    [id, type, ORG, JSON.stringify(data)],
  );
}

function seedDedicatedClaim(input: { id: string; type: string; ext: string }) {
  sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [
      input.id,
      `org:${ORG}`,
      input.type,
      input.ext,
      JSON.stringify({ projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" }),
    ],
  );
}

function seedInstalledExtension(pkg: string) {
  sql(
    `INSERT INTO "${S()}"."installed_extension"
       (id, package_name, owner_level, owner_id, organization_id, kind, status, source, version)
     VALUES ($1,$2,'organization',$3,$3,'artifact','active','{}'::jsonb,'1.0.0')
     ON CONFLICT DO NOTHING`,
    [nextId("inst"), pkg, ORG],
  );
}

function snapshotRowCount(objectId: string): number {
  const r = sql(
    `SELECT count(*)::int AS n FROM "${S()}"."object_content_snapshots" WHERE org_id=$1 AND object_id=$2`,
    [ORG, objectId],
  );
  return Number(r.rows[0].n);
}

function snapshotRepIds(objectId: string): string[] {
  const r = sql(
    `SELECT representation_revision_id FROM "${S()}"."object_content_snapshots" WHERE org_id=$1 AND object_id=$2`,
    [ORG, objectId],
  );
  return (r.rows ?? []).map((row) => String((row as { representation_revision_id: string }).representation_revision_id));
}

// ---------------------------------------------------------------------------
// MCP harness — the authoring-mcp-primitives.test.ts captureTools pattern.
// ---------------------------------------------------------------------------

type Tool = { name: string; handler: (input: unknown) => Promise<unknown> };

function captureContextTools(): Tool[] {
  const tools: Tool[] = [];
  const server = {
    registerTool: (name: string, _meta: unknown, handler: Tool["handler"]) => {
      tools.push({ name, handler });
    },
  };
  contextMcpMod.registerContextPrimitives(server as never);
  return tools;
}

function resolveTool(): Tool {
  const t = captureContextTools().find((x) => x.name === "context_resolve");
  if (!t) throw new Error("context_resolve not registered");
  return t;
}

/** Drive the REAL handler inside an authenticated MCP request frame. */
function callResolve(
  input: unknown,
  ctx: Record<string, unknown> = { orgId: ORG, userId: USER },
): Promise<{ refs: Array<Record<string, string>> } & Record<string, unknown>> {
  const tool = resolveTool();
  return mcpStorage.run(ctx, () => tool.handler(input)).then((raw) => {
    const env = raw as { structuredContent?: Record<string, unknown> };
    return (env.structuredContent ?? {}) as { refs: Array<Record<string, string>> } & Record<string, unknown>;
  });
}

function oasWithSlots(slots: unknown[]): unknown {
  return { metadata: { cinatra: { contextSlots: slots } } };
}

const slotFor = (slotId: string, ext: string) => ({
  slotId,
  acceptedArtifactExtensions: [ext],
  selectionMode: "autonomous",
  resolutionMode: "accumulate",
});

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-mcp-1430-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  contextMcpMod = await import("@/lib/artifacts/context-mcp");
  bindingMod = await import("@/lib/objects/binding-write-path");
  ({ mcpRequestContextStorage: mcpStorage } = (await import(
    "@cinatra-ai/mcp-server"
  )) as unknown as { mcpRequestContextStorage: typeof mcpStorage });
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#1430 follow-up: MCP context_resolve captures snapshots (real DB + disk)", () => {
  it("a claimed typed row resolves through the MCP tool with a capture-time snapshot pin; a second resolve keyed-REUSES", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-mcp";
    const EXT = "@cinatra-ai/campaigns-mcp-artifact";
    const objectId = nextId("obj-mcp");
    seedInstalledExtension(EXT);
    seedDedicatedClaim({ id: nextId("claim-mcp"), type: TYPE, ext: EXT });
    seedObject(objectId, TYPE, { subject: "resolve-via-mcp", body: "candidate" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    const binding = bindingMod.readActiveBinding(ORG, objectId);
    expect(binding).not.toBeNull();
    expect(snapshotRowCount(objectId)).toBe(0); // nothing pre-minted.

    const out = await callResolve({
      parentAgentOas: oasWithSlots([slotFor("slot-mcp", EXT)]),
      slotId: "slot-mcp",
    });
    expect(out.slotId).toBe("slot-mcp");
    expect(out.refs.length).toBe(1);
    const ref = out.refs[0];
    expect(ref.artifactId).toBe(objectId);
    expect(ref.extension).toBe(EXT);
    // The claimed row's context identity is its BINDING assertion …
    expect(ref.semanticAssertionId).toBe(binding!.id);
    // … and its representation is the snapshot CAPTURED BY THIS RESOLVE:
    // a real object_content_snapshots keying row backs the returned id.
    expect(snapshotRowCount(objectId)).toBe(1);
    expect(snapshotRepIds(objectId)).toEqual([ref.representationRevisionId]);

    // Second resolve through the SAME MCP surface: keyed reuse — the pin is
    // stable and no second snapshot is minted.
    const out2 = await callResolve({
      parentAgentOas: oasWithSlots([slotFor("slot-mcp", EXT)]),
      slotId: "slot-mcp",
    });
    expect(out2.refs.length).toBe(1);
    expect(out2.refs[0].representationRevisionId).toBe(ref.representationRevisionId);
    expect(snapshotRowCount(objectId)).toBe(1);
  });

  it("generic (unclaimed) resolution is unchanged: latest-revision join, zero snapshots minted", async () => {
    const EXT_G = "@cinatra-ai/generic-mcp-artifact";
    const objectId = nextId("obj-gen");
    const assertionId = nextId("sa-gen");
    seedObject(objectId, "@cinatra-ai/artifact:object", { any: "payload" });
    sql(
      `INSERT INTO "${S()}"."semantic_assertion"
         (id, org_id, artifact_id, extension, asserted_by, eligibility)
       VALUES ($1,$2,$3,$4,'user','eligible')`,
      [assertionId, ORG, objectId, EXT_G],
    );
    const rep1 = nextId("rep-gen-1");
    const rep2 = nextId("rep-gen-2");
    for (const [id, rev] of [
      [rep1, 1],
      [rep2, 2],
    ] as const) {
      sql(
        `INSERT INTO "${S()}"."representation"
           (id, org_id, artifact_id, resource_id, revision, form)
         VALUES ($1,$2,$3,$4,$5,'file')`,
        [id, ORG, objectId, nextId("res-gen"), rev],
      );
    }

    const out = await callResolve({
      parentAgentOas: oasWithSlots([slotFor("slot-gen", EXT_G)]),
      slotId: "slot-gen",
    });
    expect(out.refs.length).toBe(1);
    const ref = out.refs[0];
    expect(ref.artifactId).toBe(objectId);
    expect(ref.semanticAssertionId).toBe(assertionId);
    // Latest revision — NOT a snapshot (pre-change behavior, byte-identical).
    expect(ref.representationRevisionId).toBe(rep2);
    // The capture composition minted NOTHING for an unclaimed slot match.
    expect(snapshotRowCount(objectId)).toBe(0);
  });

  it("fail-closed: no active organization in the MCP context rejects", async () => {
    await expect(
      callResolve(
        { parentAgentOas: oasWithSlots([slotFor("s", "@x/y")]), slotId: "s" },
        { userId: USER }, // no orgId
      ),
    ).rejects.toThrow(/no active organization/);
  });

  it("fail-closed: unknown slotId and duplicate slotId both reject", async () => {
    await expect(
      callResolve({
        parentAgentOas: oasWithSlots([slotFor("slot-a", "@x/y")]),
        slotId: "slot-missing",
      }),
    ).rejects.toThrow(/no contextSlot with slotId/);

    await expect(
      callResolve({
        parentAgentOas: oasWithSlots([slotFor("slot-dup", "@x/y"), slotFor("slot-dup", "@x/z")]),
        slotId: "slot-dup",
      }),
    ).rejects.toThrow(/duplicate slotId/);
  });

  it("denial: a foreign-org actor resolves [] and mints NO snapshot for another org's claimed row", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-mcp-xorg";
    const EXT = "@cinatra-ai/campaigns-mcp-xorg-artifact";
    const objectId = nextId("obj-xorg");
    seedInstalledExtension(EXT);
    seedDedicatedClaim({ id: nextId("claim-xorg"), type: TYPE, ext: EXT });
    seedObject(objectId, TYPE, { subject: "not-yours" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });

    const out = await callResolve(
      { parentAgentOas: oasWithSlots([slotFor("slot-xorg", EXT)]), slotId: "slot-xorg" },
      { orgId: "org-other-1430", userId: "user-other" },
    );
    expect(out.refs).toEqual([]);
    expect(snapshotRowCount(objectId)).toBe(0); // capture respected visibility.
  });

  it("denial: a delegated actor's OBO ceiling excludes out-of-ceiling rows and mints NO snapshot", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-mcp-obo";
    const EXT = "@cinatra-ai/campaigns-mcp-obo-artifact";
    const objectId = nextId("obj-obo");
    seedInstalledExtension(EXT);
    seedDedicatedClaim({ id: nextId("claim-obo"), type: TYPE, ext: EXT });
    // Org-visible row (owner_level 'organization') — visible to any org
    // member WITHOUT a ceiling; a user-anchored ceiling must exclude it.
    seedObject(objectId, TYPE, { subject: "outside-the-ceiling" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });

    const input = {
      parentAgentOas: oasWithSlots([slotFor("slot-obo", EXT)]),
      slotId: "slot-obo",
    };
    // The transport-verified agent-run OBO ceiling rides the MCP request
    // frame; the handler must carry it onto the actor so BOTH the capture
    // composition and the resolver stay inside it (satisfy-ALL, narrow-only).
    const ceilinged = await callResolve(input, {
      orgId: ORG,
      userId: USER,
      oboCeiling: [
        { tier: "organization", id: ORG },
        { tier: "user", id: "some-other-user" },
      ],
    });
    expect(ceilinged.refs).toEqual([]);
    expect(snapshotRowCount(objectId)).toBe(0); // capture stayed inside the ceiling.

    // Same actor WITHOUT a ceiling: the row resolves (proves the ceiling —
    // not visibility — excluded it above, i.e. the test is not vacuous).
    const unceilinged = await callResolve(input);
    expect(unceilinged.refs.length).toBe(1);
    expect(unceilinged.refs[0].artifactId).toBe(objectId);
    expect(snapshotRowCount(objectId)).toBe(1);
  });

  it("denial: a projectId outside the actor's grants resolves [] and mints NO snapshot", async () => {
    const TYPE = "@cinatra-ai/campaigns:email-mcp-proj";
    const EXT = "@cinatra-ai/campaigns-mcp-proj-artifact";
    const objectId = nextId("obj-proj");
    seedInstalledExtension(EXT);
    seedDedicatedClaim({ id: nextId("claim-proj"), type: TYPE, ext: EXT });
    seedObject(objectId, TYPE, { subject: "project-scoped" });
    // Tag the row to the requested project so a broken gate WOULD both mint
    // and resolve it (org-visible rows pass the ownership filter regardless
    // of project tag — the projectId gates are the only guard here).
    sql(`UPDATE "${S()}"."objects" SET project_id = $2 WHERE id = $1`, [objectId, "proj-x-1430"]);
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });

    const out = await callResolve({
      parentAgentOas: oasWithSlots([slotFor("slot-proj", EXT)]),
      slotId: "slot-proj",
      projectId: "proj-x-1430", // NOT in the actor's projectIds (none granted)
    });
    expect(out.refs).toEqual([]);
    expect(snapshotRowCount(objectId)).toBe(0);
  });
});
