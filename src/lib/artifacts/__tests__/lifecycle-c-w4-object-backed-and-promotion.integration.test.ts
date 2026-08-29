/**
 * cinatra#3028 (epic #3023, lifecycle-c W4) — ENABLERS 0.13 and 0.14 against a
 * REAL Postgres, on the real substrate DDL.
 *
 * THIS IS ACCEPTANCE ITEM 1 — "An object-backed artifact opens a review on a
 * minted snapshot" — and ACCEPTANCE ITEM 2 — "A matched upload is promoted into
 * the extension's type on the person's confirmation."
 *
 * WHAT ONLY A REAL DATABASE CAN SHOW HERE:
 *   0.13  the mint's produced event commits INSIDE the capture's own
 *         transaction, survives the outbox's `emitter` CHECK (the constraint
 *         core__0099 widens), is guarded so a REUSE emits nothing, and names the
 *         minted revision the review target binds.
 *   0.14  the promotion's compare-and-set actually retypes under contention, the
 *         appended revision points at the SAME resource row (the content is
 *         shared, not copied), and the append-only trigger leaves the base row's
 *         earlier revisions exactly where they were.
 *
 * ISOLATION: a fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` DDL and a temp blob root — never the
 * worktree's shared schema and never hand-rolled DDL, so every constraint is the
 * production one. Because `postgresSchema` is a module-load const, every app
 * module is dynamically imported in `beforeAll` AFTER the env is set.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import * as zod from "zod";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    // The object read this suite exercises reaches the ownership filter, whose
    // module graph pulls the boot settings reader. Stubbed to nothing: this tier
    // provisions its own schema and reads no connector configuration.
    readConnectorConfigFromDatabase: () => null,
    writeConnectorConfigToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The object-type registrar drags the whole boot graph (auth, every connector)
// into a node tier that needs none of it — the sibling artifact integration
// suites stub it for exactly this reason.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_w4_object_backed_3028";
const ORG = "org-3028-w4";
const EXT = "@cinatra-ai/campaigns-artifact";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let snapshotMod: typeof import("@/lib/artifacts/object-content-snapshot");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let contractMod: typeof import("@/lib/artifacts/object-backed-contract");
let promotionStore: typeof import("@/lib/artifacts/typed-promotion-store");
let producedEvent: typeof import("@/lib/lifecycle/lifecycle-produced-event");
let registry: typeof import("@cinatra-ai/objects/registry");

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

function outboxRowsFor(artifactId: string) {
  return (
    sql(
      `SELECT event_id, emitter, representation_revision_id, origin_kind, status
       FROM "${S()}"."artifact_produced_outbox" WHERE org_id=$1 AND artifact_id=$2`,
      [ORG, artifactId],
    ).rows ?? []
  ) as Array<{
    event_id: string;
    emitter: string;
    representation_revision_id: string;
    origin_kind: string;
    status: string;
  }>;
}

/** Seed a base-typed row with ONE content revision over a real resource. */
function seedRepresentedRow(input: { objectId: string; type: string; mime: string }) {
  const resourceId = nextId("res");
  const blobId = nextId("blob");
  seedObject(input.objectId, input.type, { title: "an upload" });
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
     VALUES ($1,$2,'blob',$3,$4,10,NULL, jsonb_build_object('storageKey','k','blobId',$5::text))`,
    [resourceId, ORG, nextId("sub"), input.mime, blobId],
  );
  sql(
    `INSERT INTO "${S()}"."artifact_blobs"
       (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
     VALUES ($1,$2,'local-disk',$3,$4,10,$5,NULL)`,
    [blobId, ORG, nextId("key"), nextId("sha"), input.mime],
  );
  const revisionId = nextId("rev");
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by)
     VALUES ($1,$2,$3,$4,1,'file',NULL)`,
    [revisionId, ORG, input.objectId, resourceId],
  );
  return { resourceId, revisionId, blobId };
}

function seedMatcherAssertion(input: { objectId: string; extension: string; confidence: number }) {
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, confidence)
     VALUES ($1,$2,$3,$4,'matcher','draft',$5)`,
    [nextId("assert"), ORG, input.objectId, input.extension, input.confidence],
  );
}

function representationsOf(objectId: string) {
  return (
    sql(
      `SELECT id, resource_id, revision FROM "${S()}"."representation"
       WHERE org_id=$1 AND artifact_id=$2 ORDER BY revision ASC`,
      [ORG, objectId],
    ).rows ?? []
  ) as Array<{ id: string; resource_id: string; revision: number }>;
}

function typeOf(objectId: string): string {
  return String(
    (sql(`SELECT type FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`, [objectId, ORG])
      .rows[0] as { type: string }).type,
  );
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3028-"));

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
  snapshotMod = await import("@/lib/artifacts/object-content-snapshot");
  bindingMod = await import("@/lib/objects/binding-write-path");
  contractMod = await import("@/lib/artifacts/object-backed-contract");
  promotionStore = await import("@/lib/artifacts/typed-promotion-store");
  producedEvent = await import("@/lib/lifecycle/lifecycle-produced-event");
  registry = await import("@cinatra-ai/objects/registry");
}, 120_000);

/**
 * Register an OBJECT-BACKED artifact type in the process registry — a type whose
 * substance is the entry's own structured data, so it declares NO file form.
 * That absence is what makes it object-backed, and it is what the road's
 * `isObjectBackedType` port reads.
 */
function registerObjectBackedType(typeId: string) {
  const { z } = zod;
  registry.objectTypeRegistry.register(
    {
      type: typeId,
      category: "artifact",
      schema: z.object({}).passthrough(),
      lifecycle: { states: [], initial: "" } as never,
      renderers: {} as never,
      isArtifact: { accepts: {} } as never,
      dispositions: { projection: "artifact-safe" } as never,
    } as never,
    EXT,
  );
}

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

describe.skipIf(!HAS_REAL_DB)("cinatra#3028 W4 — 0.13 the object-backed contract (real DB + disk)", () => {
  /** Seed a claimed, object-backed row the capture can snapshot. */
  function seedSnapshottable(type: string) {
    const objectId = nextId("obj");
    seedInstalledExtension(EXT);
    seedDedicatedClaim({ id: nextId("claim"), type, ext: EXT });
    seedObject(objectId, type, { subject: "Launch", body: "hello" });
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    registerObjectBackedType(type);
    return objectId;
  }

  it("THE PRODUCED EVENT IS EMITTED AT THE MINT — in the capture's own transaction, under the new emitter", async () => {
    const type = "@cinatra-ai/campaigns:email-mint";
    const objectId = seedSnapshottable(type);

    const minted = await snapshotMod.captureObjectContentSnapshot({
      orgId: ORG,
      objectId,
      emitProducedEventAtMint: { originKind: "upload" },
    });
    expect(minted).not.toBeNull();
    expect(minted!.reused).toBe(false);

    const rows = outboxRowsFor(objectId);
    expect(rows).toHaveLength(1);
    // The emitter the outbox CHECK had to be widened for (core__0099).
    expect(rows[0]!.emitter).toBe("object_snapshot_mint");
    // The event names the MINTED revision, which is what the gate will pin.
    expect(rows[0]!.representation_revision_id).toBe(minted!.representationRevisionId);
    expect(rows[0]!.event_id).toBe(
      producedEvent.producedEventId(objectId, minted!.representationRevisionId),
    );
    expect(rows[0]!.status).toBe("pending");
  });

  it("A REUSE EMITS NOTHING — the guard holds, because a reuse is not a mint", async () => {
    const type = "@cinatra-ai/campaigns:email-reuse";
    const objectId = seedSnapshottable(type);

    const first = await snapshotMod.captureObjectContentSnapshot({
      orgId: ORG,
      objectId,
      emitProducedEventAtMint: { originKind: "upload" },
    });
    const again = await snapshotMod.captureObjectContentSnapshot({
      orgId: ORG,
      objectId,
      emitProducedEventAtMint: { originKind: "upload" },
    });
    expect(again!.reused).toBe(true);
    expect(again!.representationRevisionId).toBe(first!.representationRevisionId);
    // ONE row, not two: the guarded insert did not fire on the reuse arm, and
    // the deterministic id would have collided harmlessly anyway.
    expect(outboxRowsFor(objectId)).toHaveLength(1);
  });

  it("A CONTEXT PIN MINTS NOTHING TO REVIEW — the default is off, so pinning opens no review", async () => {
    const type = "@cinatra-ai/campaigns:email-pin";
    const objectId = seedSnapshottable(type);
    const pinned = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(pinned!.reused).toBe(false);
    // "pinning a row as CONTEXT is not asking anyone to decide about it".
    expect(outboxRowsFor(objectId)).toHaveLength(0);
  });

  it("THE ROAD BINDS THE MINTED REVISION INTO THE REVIEW TARGET, and a reuse still gets its trigger", async () => {
    const type = "@cinatra-ai/campaigns:email-road";
    const objectId = seedSnapshottable(type);

    // A snapshot minted earlier FOR CONTEXT carries no produced event.
    const pinned = await snapshotMod.captureObjectContentSnapshot({ orgId: ORG, objectId });
    expect(outboxRowsFor(objectId)).toHaveLength(0);

    const ports = await contractMod.serverObjectBackedReviewPorts({
      originKind: "upload",
      authorizeRead: () => true,
    });
    const opened = await contractMod.openObjectBackedReview({ orgId: ORG, objectId }, ports);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    // The road REUSED the context snapshot rather than minting a twin …
    expect(opened.minted).toBe(false);
    expect(opened.target).toEqual({
      artifactId: objectId,
      representationRevisionId: pinned!.representationRevisionId,
    });
    // … and made sure the review-request trigger exists for exactly it.
    const rows = outboxRowsFor(objectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_id).toBe(opened.producedEventId);
    expect(rows[0]!.representation_revision_id).toBe(pinned!.representationRevisionId);
    expect(rows[0]!.emitter).toBe("object_snapshot_mint");
  });

  it("AN UNAUTHORIZED READ MINTS NOTHING", async () => {
    const type = "@cinatra-ai/campaigns:email-denied";
    const objectId = seedSnapshottable(type);
    const ports = await contractMod.serverObjectBackedReviewPorts({ originKind: "upload" });
    const opened = await contractMod.openObjectBackedReview({ orgId: ORG, objectId }, ports);
    expect(opened).toEqual({ ok: false, reason: "denied" });
    expect(outboxRowsFor(objectId)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_REAL_DB)("cinatra#3028 W4 — 0.14 the typed promotion road (real DB)", () => {
  const BASE_TYPE = "@cinatra-ai/text-artifact:text";
  const OWN_TYPE = "@cinatra-ai/campaigns:voice";

  it("PROMOTES a matched upload into the extension's own type as a NEW revision SHARING the content", () => {
    const objectId = nextId("obj-promote");
    const seeded = seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.9 });

    const before = representationsOf(objectId);
    expect(before).toHaveLength(1);

    const out = promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      createdBy: "user-1",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The row now carries the EXTENSION'S OWN TYPE.
    expect(typeOf(objectId)).toBe(OWN_TYPE);

    const after = representationsOf(objectId);
    expect(after).toHaveLength(2);
    // THE BASE ROW KEEPS ITS HISTORY: revision 1 is byte-for-byte where it was.
    expect(after[0]).toEqual(before[0]);
    // A NEW REVISION SHARING THE CONTENT: same resource row, no bytes copied.
    expect(after[1]!.id).toBe(out.representationRevisionId);
    expect(after[1]!.revision).toBe(2);
    expect(after[1]!.resource_id).toBe(seeded.resourceId);
  });

  it("REFUSES a confirmation the matcher never backed — and writes nothing", () => {
    const objectId = nextId("obj-nomatch");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    const out = promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
    });
    expect(out).toEqual({ ok: false, reason: "no-matcher-assertion" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  it("REFUSES a match below the extension's own threshold", () => {
    const objectId = nextId("obj-lowconf");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.4 });
    const out = promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
    });
    expect(out).toEqual({ ok: false, reason: "below-threshold" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });

  it("RE-VALIDATES the shared content against the target type's accepted forms, off the sniffer's own verdict", () => {
    const objectId = nextId("obj-wrongform");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "application/pdf" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.95 });
    const out = promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
    });
    expect(out).toEqual({ ok: false, reason: "form-not-accepted" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });

  it("A SECOND PROMOTION of the same row is refused as already-promoted, never stacked", () => {
    const objectId = nextId("obj-twice");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.9 });
    const args = {
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
    };
    expect(promotionStore.promoteMatchedArtifactType(args).ok).toBe(true);
    expect(promotionStore.promoteMatchedArtifactType(args)).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toHaveLength(2);
  });

  it("REFUSES without the person's confirmation, however confident the match", () => {
    const objectId = nextId("obj-unconfirmed");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 1 });
    const out = promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: false,
    });
    expect(out).toEqual({ ok: false, reason: "not-confirmed" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });
});
