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
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import type { TypedPromotionRetype } from "@/lib/artifacts/typed-promotion-store";

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
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
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
let promotionPlan: typeof import("@/lib/artifacts/typed-promotion");
let representationStore: typeof import("@/lib/artifacts/representation-store");
let producedEvent: typeof import("@/lib/lifecycle/lifecycle-produced-event");
let registry: typeof import("@cinatra-ai/objects/registry");

/** The acting principal the retype's history event records. */
const ACTOR = { userId: "user-3028", orgId: ORG };
/**
 * The org-write kernel authority the canonical writer verifies. Minted host-side
 * in production (`verifySessionAuthority`); this tier provisions no auth tables,
 * so the fixture supplies the same shape directly — the promotion road under
 * test never mints one and never inspects it beyond handing it on.
 */
const AUTHORITY = {
  userId: "user-3028",
  orgId: ORG,
  role: "owner",
  verifiedAt: new Date(0).toISOString(),
} as never;

/**
 * THE RETYPE, substituted.
 *
 * In production the road's retype is the canonical history-aware objects writer,
 * whose module graph reaches the application boot (the session module, the
 * connector registry) — which a node tier that provisions neither must not pull
 * in. What this tier is here to prove is the promotion's DATA effects, so it
 * substitutes the SAME compare-and-set the canonical writer performs — anchored
 * on the row's own version, writing nothing when it misses — and the road's use
 * of the canonical writer is pinned by the unit tier instead.
 */
const RETYPE = async (input: {
  orgId: string;
  artifactId: string;
  toType: string;
  expectedVersion: number;
}) => {
  const res = sql(
    `UPDATE "${S()}"."objects" SET type = $3, version = version + 1, updated_at = now()
     WHERE id = $1 AND org_id = $2 AND version = $4 AND deleted_at IS NULL
     RETURNING id`,
    [input.artifactId, input.orgId, input.toType, input.expectedVersion],
  );
  return (res?.rows?.length ?? 0) > 0
    ? ({ ok: true } as const)
    : ({ ok: false, reason: "row-moved" } as const);
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

/** A PERSON'S OWN classic assertion — the second road §XI.10 gives onto the
 *  promotion, seeded with the principal who is acting. */
function seedPersonAssertion(input: {
  objectId: string;
  extension: string;
  principal: string | null;
}) {
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, asserted_by_principal)
     VALUES ($1,$2,$3,$4,'user','eligible',$5)`,
    [nextId("assert"), ORG, input.objectId, input.extension, input.principal],
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
  promotionPlan = await import("@/lib/artifacts/typed-promotion");
  representationStore = await import("@/lib/artifacts/representation-store");
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

  it("PROMOTES a matched upload into the extension's own type as a NEW revision SHARING the content", async () => {
    const objectId = nextId("obj-promote");
    const seeded = seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.9 });

    const before = representationsOf(objectId);
    expect(before).toHaveLength(1);

    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      createdBy: "user-1",
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
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

  it("REFUSES a confirmation the matcher never backed — and writes nothing", async () => {
    const objectId = nextId("obj-nomatch");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "no-matcher-assertion" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  it("REFUSES a match below the extension's own threshold", async () => {
    const objectId = nextId("obj-lowconf");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.4 });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "below-threshold" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });

  it("RE-VALIDATES the shared content against the target type's accepted forms, off the sniffer's own verdict", async () => {
    const objectId = nextId("obj-wrongform");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "application/pdf" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.95 });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "form-not-accepted" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });

  it("A SECOND PROMOTION of the same row converges — it never stacks a second revision", async () => {
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
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    };
    expect((await promotionStore.promoteMatchedArtifactType(args)).ok).toBe(true);
    // The second call finds the row already retyped and the revision already
    // there, so the idempotent append lands nothing and the road refuses.
    expect(await promotionStore.promoteMatchedArtifactType(args)).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toHaveLength(2);
  });

  it("COMPLETES an interrupted promotion — the retype committed, the append did not", async () => {
    // The state an interruption between the road's two transactions leaves: the
    // row already carries the target type, its promotion revision is missing,
    // and the matcher's assertion is still on the row. A later confirmation
    // CONVERGES it rather than stranding it.
    const objectId = nextId("obj-interrupted");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.9 });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // It COMPLETED — it did not retype anything, because the retype had landed.
    expect(out.retyped).toBe(false);
    expect(representationsOf(objectId)).toHaveLength(2);
  });

  it("does NOT append to a row that merely CARRIES the target type — no matcher, no write", async () => {
    // A row written in that type from the start, or typed by some other road, is
    // not a half-finished promotion of THIS road: the converging branch carries
    // the same two authorities the promotion itself does, so a bare confirmation
    // appends nothing.
    const objectId = nextId("obj-carries");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: true,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "already-promoted" });
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  it("REFUSES the converging append to an unconfirmed caller", async () => {
    const objectId = nextId("obj-carries-unconfirmed");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 0.9 });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: false,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "already-promoted" });
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  // THE PERSON'S OWN ROAD, AT THE CONVERGING BRANCH (fix leg 2, convergence
  // round). It carries the same two conditions as the matcher's: the acting
  // person's own assertion, and the confirmation.
  it("REFUSES the converging append to an unconfirmed caller on the person's road too", async () => {
    const objectId = nextId("obj-carries-person-unconfirmed");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    seedPersonAssertion({ objectId, extension: EXT, principal: "principal-3143" });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: null,
      confirmed: false,
      principal: "principal-3143",
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "already-promoted" });
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  it("REFUSES the converging append to a person who is not the one who asserted", async () => {
    const objectId = nextId("obj-carries-other-person");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    seedPersonAssertion({ objectId, extension: EXT, principal: "principal-alice" });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: null,
      confirmed: true,
      principal: "principal-bob",
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "already-promoted" });
    expect(representationsOf(objectId)).toHaveLength(1);
  });

  it("COMPLETES the converging append for the person who asserted, once confirmed", async () => {
    const objectId = nextId("obj-carries-own-person");
    seedRepresentedRow({ objectId, type: OWN_TYPE, mime: "text/markdown" });
    seedPersonAssertion({ objectId, extension: EXT, principal: "principal-alice" });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: null,
      confirmed: true,
      principal: "principal-alice",
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out.ok).toBe(true);
    expect(representationsOf(objectId)).toHaveLength(2);
  });

  it("REFUSES without the person's confirmation, however confident the match", async () => {
    const objectId = nextId("obj-unconfirmed");
    seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedMatcherAssertion({ objectId, extension: EXT, confidence: 1 });
    const out = await promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: objectId,
      extension: EXT,
      ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
      threshold: 0.8,
      confirmed: false,
      actor: ACTOR,
      authority: AUTHORITY,
      retype: RETYPE,
    });
    expect(out).toEqual({ ok: false, reason: "not-confirmed" });
    expect(typeOf(objectId)).toBe(BASE_TYPE);
  });
});

describe.skipIf(!HAS_REAL_DB)("cinatra#3319 — the promotion intent survives the binding reconcile (real DB)", () => {
  const BASE_TYPE = "@cinatra-ai/text-artifact:text";
  const INTERRUPTED = "3319: interrupted after the retype committed";

  /** One wrong field on the retype's change event, for the forged-shape cases. */
  type Forge = { operation?: string; actorKind?: string; baseVersionOffset?: number };

  /**
   * THE RETYPE, then a stop. The canonical writer's compare-and-set and its
   * change event commit in ONE statement, so this port does the same — the type
   * change, `version + 1`, and the event carrying the key it is given — and then
   * throws: the state an interruption between the road's two transactions
   * leaves. A port given no key writes a random one, which is the writer's own
   * default (`canonical-writer.ts`, `options.idempotencyKey ?? newIdempotencyKey()`).
   */
  function interruptingRetype(forge: Forge = {}) {
    return async (input: {
      orgId: string;
      artifactId: string;
      toType: string;
      expectedVersion: number;
      idempotencyKey?: string;
      actor: { userId: string; orgId: string };
    }): Promise<{ ok: false; reason: "row-moved" }> => {
      const res = sql(
        `WITH updated AS (
           UPDATE "${S()}"."objects" SET type = $3, version = version + 1, updated_at = now()
           WHERE id = $1 AND org_id = $2 AND version = $4 AND deleted_at IS NULL
           RETURNING id, type, version, org_id
         )
         INSERT INTO "${S()}"."object_change_event"
           (id, change_set_id, sequence, object_id, object_type, operation, history_effect,
            base_version, result_version, actor_id, actor_kind, org_id, idempotency_key, event_checksum)
         SELECT $5::text, $6::text, 1, updated.id, updated.type, $7::text, 'reversible-internal',
                $8::int, updated.version, $9::text, $10::text, updated.org_id, $11::text, $12::text
         FROM updated
         RETURNING id`,
        [
          input.artifactId,
          input.orgId,
          input.toType,
          input.expectedVersion,
          nextId("evt-3319"),
          nextId("cs-3319"),
          forge.operation ?? "update",
          input.expectedVersion + (forge.baseVersionOffset ?? 0),
          input.actor.userId,
          forge.actorKind ?? "user",
          input.idempotencyKey ?? nextId("random-key-3319"),
          nextId("checksum-3319"),
        ],
      );
      if ((res?.rows?.length ?? 0) === 0) return { ok: false, reason: "row-moved" };
      throw new Error(INTERRUPTED);
    };
  }

  function promote(p: {
    objectId: string;
    ownType: string;
    actor: { userId: string; orgId: string };
    retype?: TypedPromotionRetype;
    beforeConvergingAppend?: () => Promise<void>;
  }) {
    return promotionStore.promoteMatchedArtifactType({
      orgId: ORG,
      artifactId: p.objectId,
      extension: EXT,
      ownType: { typeId: p.ownType, acceptsMimes: ["text/markdown"] },
      // The person's road only: the pack declares no matcher machinery.
      threshold: null,
      confirmed: true,
      createdBy: p.actor.userId,
      principal: p.actor.userId,
      actor: p.actor,
      authority: AUTHORITY,
      retype: p.retype ?? RETYPE,
      beforeConvergingAppend: p.beforeConvergingAppend,
    });
  }

  /** A markdown upload, the person's own assertion and an active dedicated
   *  claim for the target type, promoted by the person and interrupted after
   *  the retype committed. */
  async function seedInterruptedPromotion(label: string, forge: Forge = {}) {
    const ownType = `@cinatra-ai/campaigns:draft-3319-${label}`;
    const actor = { userId: `user-3319-${label}`, orgId: ORG };
    const objectId = nextId(`obj-3319-${label}`);
    const seeded = seedRepresentedRow({ objectId, type: BASE_TYPE, mime: "text/markdown" });
    seedPersonAssertion({ objectId, extension: EXT, principal: actor.userId });
    seedDedicatedClaim({ id: nextId(`claim-3319-${label}`), type: ownType, ext: EXT });
    await expect(
      promote({ objectId, ownType, actor, retype: interruptingRetype(forge) }),
    ).rejects.toThrow(INTERRUPTED);
    // The retype landed; the append never ran.
    expect(typeOf(objectId)).toBe(ownType);
    expect(representationsOf(objectId)).toHaveLength(1);
    return { ownType, actor, objectId, seeded };
  }

  function personAssertionsOf(objectId: string): string[] {
    return (
      (sql(
        `SELECT eligibility FROM "${S()}"."semantic_assertion"
         WHERE org_id=$1 AND artifact_id=$2 AND asserted_by='user'`,
        [ORG, objectId],
      ).rows ?? []) as Array<{ eligibility: string }>
    ).map((r) => r.eligibility);
  }

  /** The binding reconcile the retype queues, run for real: it archives the
   *  winner extension's classic assertion, the person's own. */
  function reconcile(objectId: string) {
    bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
    expect(personAssertionsOf(objectId)).toEqual(["archived"]);
  }

  function witnessCount(objectId: string, representationRevisionId: string): number {
    return (
      sql(
        `SELECT 1 FROM "${S()}"."artifact_audit"
         WHERE org_id=$1 AND artifact_id=$2 AND representation_revision_id=$3 AND action='create'`,
        [ORG, objectId, representationRevisionId],
      ).rows ?? []
    ).length;
  }

  /** A second markdown resource, for an edit save over the same row. */
  function seedEditResource(): string {
    const resourceId = nextId("res-edit-3319");
    const blobId = nextId("blob-edit-3319");
    sql(
      `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
       VALUES ($1,$2,'blob',$3,'text/markdown',10,NULL, jsonb_build_object('storageKey','k','blobId',$4::text))`,
      [resourceId, ORG, nextId("sub-edit-3319"), blobId],
    );
    sql(
      `INSERT INTO "${S()}"."artifact_blobs"
         (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
       VALUES ($1,$2,'local-disk',$3,$4,10,'text/markdown',NULL)`,
      [blobId, ORG, nextId("key-edit-3319"), nextId("sha-edit-3319")],
    );
    return resourceId;
  }

  /** An edit save through the expected-base road, on the seeded revision. */
  async function appendEdit(objectId: string, baseRevisionId: string, userId: string) {
    const edit = await representationStore.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: objectId,
      baseRevisionId,
      resourceId: seedEditResource(),
      form: "file",
      createdBy: userId,
    });
    expect(edit.kind).toBe("appended");
    if (edit.kind !== "appended") throw new Error("the edit save did not append");
    return edit.record.id;
  }

  it("3319 T8 the person who promoted completes an interrupted promotion after the reconcile archived their assertion", async () => {
    const { ownType, actor, objectId, seeded } = await seedInterruptedPromotion("t8");
    reconcile(objectId);

    // Another person has no event of their own on the row.
    const other = { userId: "user-3319-t8-other", orgId: ORG };
    expect(await promote({ objectId, ownType, actor: other })).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toHaveLength(1);

    const out = await promote({ objectId, ownType, actor });
    expect(out).toMatchObject({ ok: true, retyped: false, revision: 2, toType: ownType });
    if (!out.ok) return;
    const after = representationsOf(objectId);
    expect(after).toHaveLength(2);
    expect(after[1]!.id).toBe(out.representationRevisionId);
    // The promotion shares the seeded revision's content.
    expect(after[1]!.resource_id).toBe(seeded.resourceId);
    expect(witnessCount(objectId, out.representationRevisionId)).toBe(1);
  });

  it("3319 T9 an edit appended after the reconcile is not promoted by the old intent", async () => {
    const { ownType, actor, objectId, seeded } = await seedInterruptedPromotion("t9");
    reconcile(objectId);
    // An edit save moves the head; the row's version does not move.
    const editId = await appendEdit(objectId, seeded.revisionId, actor.userId);

    expect(await promote({ objectId, ownType, actor })).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId).map((r) => r.id)).toEqual([seeded.revisionId, editId]);
  });

  const FORGED: Array<{ label: string; field: string; forge: Forge }> = [
    { label: "t10-actor-kind", field: "actor_kind 'agent'", forge: { actorKind: "agent" } },
    { label: "t10-operation", field: "operation 'create'", forge: { operation: "create" } },
    {
      label: "t10-base-version",
      field: "base_version two below the row's version",
      forge: { baseVersionOffset: -1 },
    },
  ];
  for (const forged of FORGED) {
    it(`3319 T10 a retype event with the right key and ${forged.field} does not converge`, async () => {
      const { ownType, actor, objectId } = await seedInterruptedPromotion(forged.label, forged.forge);
      // The one event on the row carries the forged field.
      const events = (sql(
        `SELECT operation, actor_kind, base_version, result_version FROM "${S()}"."object_change_event"
         WHERE org_id=$1 AND object_id=$2`,
        [ORG, objectId],
      ).rows ?? []) as Array<{ operation: string; actor_kind: string; base_version: number; result_version: number }>;
      expect(events).toHaveLength(1);
      expect(Number(events[0]!.result_version)).toBe(2);
      reconcile(objectId);

      expect(await promote({ objectId, ownType, actor })).toEqual({
        ok: false,
        reason: "already-promoted",
      });
      expect(representationsOf(objectId)).toHaveLength(1);
    });
  }

  for (const phase of ["pre-reconciliation", "post-reconciliation"] as const) {
    it(`3319 T11 an edit that commits between the converging read and its append refuses the append (${phase})`, async () => {
      const label = phase === "pre-reconciliation" ? "t11-pre" : "t11-post";
      const { ownType, actor, objectId, seeded } = await seedInterruptedPromotion(label);
      // Pre-reconciliation the authority is the person's still-active assertion;
      // post-reconciliation it is the retype's own event.
      if (phase === "post-reconciliation") reconcile(objectId);
      else expect(personAssertionsOf(objectId)).toEqual(["eligible"]);

      let editId: string | null = null;
      const out = await promote({
        objectId,
        ownType,
        actor,
        // THE BARRIER: the edit commits after the branch's read and before its
        // append transaction takes the lock.
        beforeConvergingAppend: async () => {
          editId = await appendEdit(objectId, seeded.revisionId, actor.userId);
        },
      });
      expect(out).toEqual({ ok: false, reason: "row-moved" });
      expect(editId).not.toBeNull();

      const promotionId = promotionPlan.promotionRevisionId({
        artifactId: objectId,
        sharedResourceId: seeded.resourceId,
        toType: ownType,
      });
      const ids = representationsOf(objectId).map((r) => r.id);
      // The head is the edit, and the promotion wrote neither its revision nor
      // its witness.
      expect(ids).toEqual([seeded.revisionId, editId]);
      expect(ids).not.toContain(promotionId);
      expect(witnessCount(objectId, promotionId)).toBe(0);
    });
  }
});
