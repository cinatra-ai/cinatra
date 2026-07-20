/**
 * epic #1785 wave A4 (READERS) — REAL-DB integration proof that the three
 * artifact reader gates admit a PACK-typed row created by the A3 writer.
 *
 * A3 retired the generic artifact base: `createSemanticArtifact` now stamps a
 * row's EXACT declared pack type into `objects.type` (never the generic
 * catch-all), keeps the producer-CLASSIC assertion for a RUN-PRODUCED row, and
 * writes NO binding + NO floor. The three readers historically gated on
 * `o.type = GENERIC`, so every pack-typed row was stranded (serve 404,
 * context-resolve miss, selection-finalize incoherent). A4 broadens each gate
 * to admit `objectTypeRegistry.listArtifacts()` type ids while preserving the
 * cinatra#1430 claimant-isolation invariant (a CLAIMED row serves ONLY its
 * content-snapshot representation, never its latest/direct one).
 *
 * Proves, against real DDL + constraints (no mocks on the DB path):
 *   - artifact-read serves a pack-typed DIRECT (uploaded, assertion-less) rep
 *     AND a run-produced (producer-classic) pack row's direct rep;
 *   - the serve gate is SCOPED to registered artifact types — an UNREGISTERED
 *     typed row's direct rep still 404s;
 *   - claimant-isolation preserved — a CLAIMED pack row (eligible binding) does
 *     NOT serve its direct (non-snapshot) rep;
 *   - context-resolver returns the run-produced (classic-assertion) pack row and
 *     EXCLUDES the uploaded assertion-less pack row (parity with an
 *     assertion-less generic row — not a regression);
 *   - context-selection-finalize commits the resolved run-produced triple
 *     (coherent + real retention pin).
 *
 * ISOLATION (the object-content-snapshot.integration.test.ts pattern): fresh
 * schema per file from the CANONICAL `buildCreateStoreSchemaQueries` DDL; every
 * app module dynamically imported in `beforeAll` AFTER the env is set
 * (postgresSchema is a module-load const).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

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
// The reader gates warm the registry via `ensureArtifactTypesRegistered`, which
// runs the heavy app-boot registrar. No-op it (the context-mcp integration
// pattern): this suite registers the ONE pack type it needs directly, so the
// warm must not clobber that with the real registrar graph.
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_pack_readers_1785_a4";
const ORG = "org-a4";
const PACK_TYPE = "@cinatra-ai/pdf-artifact:document";
const PACK_EXT = "@cinatra-ai/pdf-artifact";
const UNREG_TYPE = "@cinatra-ai/not-installed:thing";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let readMod: typeof import("@/lib/artifacts/artifact-read");
let resolverMod: typeof import("@/lib/artifacts/context-resolver");
let finalizeMod: typeof import("@/lib/artifacts/context-selection-finalize");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function seedObject(id: string, type: string, data: unknown = {}) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
    [id, type, ORG, JSON.stringify(data)],
  );
}

/** Seed a DIRECT (revision-1, non-snapshot) file representation for `artifactId`
 *  through the real resource → artifact_blobs → representation model the serve
 *  resolver reads. Returns the representation revision id. */
function seedDirectRepresentation(artifactId: string): string {
  const blobId = nextId("blob");
  const resourceId = nextId("res");
  const repId = nextId("rep");
  const sha = nextId("sha");
  sql(
    `INSERT INTO "${S()}"."artifact_blobs"
       (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
     VALUES ($1,$2,'local-disk',$3,$4,$5,'application/pdf')`,
    [blobId, ORG, `key/${blobId}`, sha, 1234],
  );
  sql(
    `INSERT INTO "${S()}"."resource"
       (id, org_id, kind, substance_key, mime, size_bytes, metadata)
     VALUES ($1,$2,'blob',$3,'application/pdf',$4,$5::jsonb)`,
    [resourceId, ORG, `blob:${sha}`, 1234, JSON.stringify({ blobId })],
  );
  sql(
    `INSERT INTO "${S()}"."representation"
       (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,1,'file')`,
    [repId, ORG, artifactId, resourceId],
  );
  return repId;
}

/** A producer-CLASSIC assertion (the A3 writer's run-produced row shape). */
function seedClassicAssertion(artifactId: string, extension: string): string {
  const id = nextId("sa");
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis)
     VALUES ($1,$2,$3,$4,'agent','eligible','classic')`,
    [id, ORG, artifactId, extension],
  );
  return id;
}

/** An eligible BINDING assertion — makes a row "claimed" for the reader gates. */
function seedBindingAssertion(artifactId: string, extension: string): string {
  const id = nextId("sab");
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
     VALUES ($1,$2,$3,$4,'agent','eligible','binding',$5,1)`,
    [id, ORG, artifactId, extension, nextId("claim")],
  );
  return id;
}

const ACTOR = {
  principalType: "HumanUser",
  principalId: "user-a4",
  organizationId: ORG,
  authSource: "agent",
  projectIds: [],
} as never;
const SLOT = {
  slotId: "slot-a4",
  acceptedArtifactExtensions: [PACK_EXT],
  selectionMode: "autonomous" as const,
  resolutionMode: "accumulate" as const,
};
const INSTALLED = [{ extension: PACK_EXT, satisfies: [] as string[] }];

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

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
  readMod = await import("@/lib/artifacts/artifact-read");
  resolverMod = await import("@/lib/artifacts/context-resolver");
  finalizeMod = await import("@/lib/artifacts/context-selection-finalize");

  // Register the pack type so `objectTypeRegistry.listArtifacts()` (which each
  // reader reads at query-build time) admits it — the A3 base-pack shape.
  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    {
      type: PACK_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["application/pdf"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    PACK_EXT,
  );
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("epic #1785 A4 — pack-typed reader gates (real DB)", () => {
  it("recall-detectable (unit): a registered isArtifact pack type with an artifact-safe disposition is disposition-governed", async () => {
    const { isDispositionGovernedType, resolveTypeProjectionDisposition } = await import(
      "@cinatra-ai/objects/registry"
    );
    expect(isDispositionGovernedType(PACK_TYPE)).toBe(true);
    expect(resolveTypeProjectionDisposition(PACK_TYPE)).toBe("artifact-safe");
    expect(objectTypeRegistry.listArtifacts().map((d) => d.type)).toContain(PACK_TYPE);
  });

  it("artifact-read serves an UPLOADED (assertion-less) pack-typed DIRECT representation", () => {
    const objectId = nextId("obj-upload");
    seedObject(objectId, PACK_TYPE, { title: "uploaded.pdf" });
    const repId = seedDirectRepresentation(objectId);
    const resolved = readMod.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: objectId,
      representationRevisionId: repId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.mime).toBe("application/pdf");
    expect(resolved!.storageKey).toContain("key/");
  });

  it("artifact-read serves a RUN-PRODUCED (producer-classic) pack-typed direct representation", () => {
    const objectId = nextId("obj-run");
    seedObject(objectId, PACK_TYPE, { title: "generated.pdf" });
    const repId = seedDirectRepresentation(objectId);
    seedClassicAssertion(objectId, PACK_EXT);
    const resolved = readMod.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: objectId,
      representationRevisionId: repId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved!.storageKey).toContain("key/");
  });

  it("artifact-read 404s an UNREGISTERED typed row's direct representation (gate scoped to registered artifact types)", () => {
    const objectId = nextId("obj-unreg");
    seedObject(objectId, UNREG_TYPE, { title: "not-an-artifact" });
    const repId = seedDirectRepresentation(objectId);
    const resolved = readMod.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: objectId,
      representationRevisionId: repId,
    });
    expect(resolved).toBeNull();
  });

  it("artifact-read preserves cinatra#1430 claimant-isolation — a CLAIMED pack row does NOT serve its direct (non-snapshot) rep", () => {
    const objectId = nextId("obj-claimed");
    seedObject(objectId, PACK_TYPE, { title: "claimed.pdf" });
    const repId = seedDirectRepresentation(objectId);
    // An eligible binding makes the row "claimed"; there is NO content snapshot
    // keyed to this direct representation, so the serve gate must refuse it (a
    // claimed row serves ONLY through its snapshot representation).
    seedBindingAssertion(objectId, PACK_EXT);
    const resolved = readMod.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: objectId,
      representationRevisionId: repId,
    });
    expect(resolved).toBeNull();
  });

  it("context-resolver resolves a run-produced pack row and EXCLUDES an uploaded assertion-less pack row", () => {
    const runRow = nextId("obj-ctx-run");
    seedObject(runRow, PACK_TYPE, { title: "resolvable.pdf" });
    seedDirectRepresentation(runRow);
    const saId = seedClassicAssertion(runRow, PACK_EXT);

    const uploadRow = nextId("obj-ctx-upload");
    seedObject(uploadRow, PACK_TYPE, { title: "unresolvable.pdf" });
    seedDirectRepresentation(uploadRow);
    // no assertion → no eligible extension a slot can accept.

    const refs = resolverMod.resolveContextSlot({
      actor: ACTOR,
      slot: SLOT,
      installedExtensions: INSTALLED,
    });
    const ids = refs.map((r) => r.artifactId);
    expect(ids).toContain(runRow);
    expect(ids).not.toContain(uploadRow);
    const ref = refs.find((r) => r.artifactId === runRow)!;
    expect(ref.extension).toBe(PACK_EXT);
    expect(ref.semanticAssertionId).toBe(saId);
  });

  it("context-selection-finalize commits the resolved run-produced pack triple (coherent + real pin)", () => {
    const objectId = nextId("obj-fin");
    seedObject(objectId, PACK_TYPE, { title: "finalizable.pdf" });
    const repId = seedDirectRepresentation(objectId);
    const saId = seedClassicAssertion(objectId, PACK_EXT);

    const fin = finalizeMod.finalizeContextSelectionPin({
      selection: {
        orgId: ORG,
        parentRunId: nextId("run"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: SLOT.slotId,
        artifactId: objectId,
        representationRevisionId: repId,
        semanticAssertionId: saId,
        extension: PACK_EXT,
        sourceScope: "organization",
        selectedBy: "autonomous",
        selectionMode: "autonomous",
      },
      referrerKind: "agent_run",
      referrerId: nextId("ref"),
    });
    expect(fin.selectionWritten).toBe(true);
    expect(fin.pinWritten).toBe(true);
  });

  it("context-selection-finalize preserves claimant-isolation — a CLAIMED pack row's direct rep is INCOHERENT (never finalizes off the bare type branch)", () => {
    const objectId = nextId("obj-fin-claimed");
    seedObject(objectId, PACK_TYPE, { title: "claimed-finalize.pdf" });
    const repId = seedDirectRepresentation(objectId);
    const saId = seedClassicAssertion(objectId, PACK_EXT);
    // Make it claimed: an eligible binding exists (under a DISTINCT extension so
    // the per-(artifact,extension) active-assertion unique index does not
    // collide with the classic assertion above — the not-claimed guard checks
    // for ANY eligible binding on the artifact, extension-agnostic). With NO
    // content snapshot on the direct rep and no pinnable/content claim, the
    // finalize coherence gate must refuse — the pack branch is
    // NOT-claimed-guarded and the binding-snapshot branch has no matching
    // snapshot.
    seedBindingAssertion(objectId, "@cinatra-ai/other-pack");
    expect(() =>
      finalizeMod.finalizeContextSelectionPin({
        selection: {
          orgId: ORG,
          parentRunId: nextId("run"),
          parentPackageName: "@cinatra-ai/agent",
          slotId: SLOT.slotId,
          artifactId: objectId,
          representationRevisionId: repId,
          semanticAssertionId: saId,
          extension: PACK_EXT,
          sourceScope: "organization",
          selectedBy: "autonomous",
          selectionMode: "autonomous",
        },
        referrerKind: "agent_run",
        referrerId: nextId("ref"),
      }),
    ).toThrow();
  });
});
