/**
 * cinatra#2139 — the two recorded residuals of the D-8 + OBS-1 change, proven on
 * a REAL Postgres with real DDL, real constraints and real blob IO.
 *
 * RESIDUAL (a) — CLAIMED-ROW CONTEXT-PINNABILITY.
 * cinatra#1868 made the artifact writer compose the binding reconcile into its
 * creation transaction, so a GENUINE FILE artifact produced on an org that HOLDS
 * the pack's claim carries an eligible binding. cinatra#2047 OBS-1 taught the
 * SERVE arm to admit such a representation on its writer-provenance witness — but
 * the CONTEXT/PIN path still routed every claimed row through the content-snapshot
 * branch alone, where a file artifact has no snapshot and can get none worth
 * having (a snapshot of `objects.data` is the metadata envelope, not the authored
 * work). Net: a run's own produced artifact was NOT selectable as agent context on
 * exactly the orgs that installed the pack. Closing it needed the three sites of
 * that path to move TOGETHER, which is what this suite drives:
 *   1. the snapshot-CANDIDATE rule (`captureSnapshotsForContextSlot`),
 *   2. the RESOLVER's claimed-row join (`resolveContextSlot`),
 *   3. BOTH `context-selection-finalize` statements (the finalize CTE and the
 *      batch-abort probe).
 * A change to any one alone is a dead end: a pin the resolver drops, a candidate
 * finalization rejects, or a selection whose bytes never serve.
 *
 * RESIDUAL (b) — THE WITNESS INVARIANT COVERS EVERY HOST FILE WRITER.
 * `captureCmsContentSnapshot` and `writePinnedPreviewCapture` minted `form='file'`
 * representations WITHOUT the witness. Both of their object types register an
 * `isArtifact` descriptor — which is exactly what puts them under the pack-typed
 * serve arm — so a claim reserved over either type would have stranded the
 * capture on its own review surface. Both now emit the witness from the shared
 * builder inside their own capture transaction, and the proof below is not "the
 * row exists" but the end-to-end consequence: a CLAIMED capture still serves.
 *
 * ISOLATION (the #1868 / #1430 / #2047 integration pattern): a FRESH schema per
 * file from the CANONICAL `buildCreateStoreSchemaQueries` DDL; the blob root is a
 * temp dir; every app module is dynamically imported in `beforeAll` AFTER the env
 * is set (postgresSchema is a module-load const). The heavy app-boot registrar is
 * no-op'd so this suite's directly-registered types survive the reader gates' warm.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
vi.mock("@/lib/register-all-object-types", () => ({
  registerAllObjectTypes: () => {},
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_claimed_pinnability_2139";
const ORG = "org-2139";

/** A registered isArtifact PACK type whose OWN pack holds the dedicated claim
 * over it — what a real marketplace install produces. */
const PACK_TYPE = "@cinatra-ai/blog-post-artifact:post";
const PACK_EXT = "@cinatra-ai/blog-post-artifact";
/** A SECOND pack type + claim, used only by the claim-status rung so retiring
 * its claim cannot disturb the rungs that share the primary one. */
const PACK_TYPE_2 = "@cinatra-ai/blog-idea-artifact:idea";
const PACK_EXT_2 = "@cinatra-ai/blog-idea-artifact";
const CLAIM_ID_2 = "claim-pack-2-2139";
/** A claimed TYPED-DATA type: claim-backed, NO isArtifact descriptor — the row
 * class cinatra#1430's claimant isolation governs. */
const DATA_TYPE = "@cinatra-ai/campaigns:campaign";
const DATA_EXT = "@cinatra-ai/campaigns";
/** The CMS capture types, both registered isArtifact (residual (b)). */
const CMS_SNAPSHOT_TYPE = "@cinatra-ai/objects:cms-content-snapshot";
const CMS_SNAPSHOT_EXT = "@cinatra-ai/cms-snapshot-artifact";
const CMS_CAPTURE_TYPE = "@cinatra-ai/objects:cms-preview-capture";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

async function* bytesOf(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

/** A tiny but real PNG (1x1) so the blob store sees genuine image bytes. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let creationMod: typeof import("@/lib/artifacts/artifact-creation");
let assertionMod: typeof import("@/lib/artifacts/semantic-assertion-store");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let snapshotMod: typeof import("@/lib/artifacts/object-content-snapshot");
let resolverMod: typeof import("@/lib/artifacts/context-resolver");
let finalizeMod: typeof import("@/lib/artifacts/context-selection-finalize");
let readMod: typeof import("@/lib/artifacts/artifact-read");
let cmsCaptureMod: typeof import("@/lib/artifacts/cms-content-snapshot-capture");
let previewStoreMod: typeof import("@/lib/artifacts/cms-preview-capture-store");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function count(table: string, where: string, values: unknown[]): number {
  const r = sql(`SELECT count(*)::int AS n FROM "${S()}"."${table}" WHERE ${where}`, values);
  return Number((r.rows?.[0] as { n: number }).n);
}

/** The writer-provenance witness rows for one representation. */
function witnessCount(artifactId: string, representationRevisionId: string): number {
  return count(
    "artifact_audit",
    "org_id=$1 AND artifact_id=$2 AND representation_revision_id=$3 AND action='create'",
    [ORG, artifactId, representationRevisionId],
  );
}

/** Seed an ACTIVE dedicated claim (org scope) — the state the shipped claim
 * activation leaves behind after a marketplace install. */
function seedDedicatedClaim(input: {
  id: string;
  type: string;
  ext: string;
  dispositions?: Record<string, unknown>;
}) {
  sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [
      input.id,
      `org:${ORG}`,
      input.type,
      input.ext,
      JSON.stringify(
        input.dispositions ?? {
          projection: "artifact-safe",
          pinnable: true,
          snapshotPolicy: "content",
        },
      ),
    ],
  );
}

/** The SHIPPED producer call pair — what every materializer does around the
 * artifact write choke point. */
async function produce(
  body: string,
  type: string = PACK_TYPE,
  ext: string = PACK_EXT,
): Promise<{
  artifactId: string;
  representationRevisionId: string;
}> {
  const created = await creationMod.createSemanticArtifact({
    orgId: ORG,
    objectType: type,
    expectedAcceptMimes: ["text/markdown"],
    createdBy: null,
    ownerLevel: "organization",
    ownerId: ORG,
    title: "blog post body",
    declaredMime: "text/markdown",
    originKind: "agent_generated",
    stream: bytesOf(body),
    createdByRunId: null,
    skipFallbackClassification: true,
  });
  assertionMod.assertSemanticType({
    orgId: ORG,
    artifactId: created.artifactId,
    extension: ext,
    assertedBy: "agent",
    principal: null,
  });
  return created;
}

const actor = {
  principalType: "HumanUser",
  principalId: "user-2139",
  organizationId: ORG,
  authSource: "agent",
  projectIds: [],
} as never;

const slotFor = (slotId: string, exts: string[]) => ({
  slotId,
  acceptedArtifactExtensions: exts,
  selectionMode: "autonomous" as const,
  resolutionMode: "accumulate" as const,
});

const installedFor = (exts: string[]) => exts.map((extension) => ({ extension, satisfies: [] }));

/** Hand-seed a representation over real resource + blob rows WITHOUT going
 * through a host writer — i.e. with NO witness. The shape a forgery would have. */
function seedUnwitnessedRepresentation(artifactId: string): string {
  const resourceId = nextId("res");
  const blobId = nextId("blob");
  const repId = nextId("rep");
  const sha = nextId("sha");
  sql(
    `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
     VALUES ($1,$2,'local-disk',$3,$4,$5,'text/markdown')`,
    [blobId, ORG, `key/${blobId}`, sha, 12],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata)
     VALUES ($1,$2,'blob',$3,'text/markdown',$4,$5::jsonb)`,
    [resourceId, ORG, `blob:${sha}`, 12, JSON.stringify({ blobId, storageKey: `key/${blobId}` })],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     SELECT $1,$2,$3,$4,
       COALESCE((SELECT MAX(r.revision) FROM "${S()}"."representation" r
                 WHERE r.org_id=$2 AND r.artifact_id=$3), 0) + 1,
       'file'`,
    [repId, ORG, artifactId, resourceId],
  );
  return repId;
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-2139-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  creationMod = await import("@/lib/artifacts/artifact-creation");
  assertionMod = await import("@/lib/artifacts/semantic-assertion-store");
  bindingMod = await import("@/lib/objects/binding-write-path");
  snapshotMod = await import("@/lib/artifacts/object-content-snapshot");
  resolverMod = await import("@/lib/artifacts/context-resolver");
  finalizeMod = await import("@/lib/artifacts/context-selection-finalize");
  readMod = await import("@/lib/artifacts/artifact-read");
  cmsCaptureMod = await import("@/lib/artifacts/cms-content-snapshot-capture");
  previewStoreMod = await import("@/lib/artifacts/cms-preview-capture-store");

  objectTypeRegistry._clearForTests();
  const artifactType = (type: string, mimes: string[], ext: string) =>
    objectTypeRegistry.register(
      {
        type,
        category: "report",
        schema: z.record(z.string(), z.unknown()),
        lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
        renderers: { listRow: null, card: null, detail: null },
        isArtifact: { accepts: { file: { mimeTypes: mimes } } },
        dispositions: { projection: "artifact-safe" },
      } as never,
      ext,
    );
  artifactType(PACK_TYPE, ["text/markdown"], PACK_EXT);
  artifactType(PACK_TYPE_2, ["text/markdown"], PACK_EXT_2);
  artifactType(CMS_SNAPSHOT_TYPE, ["application/vnd.cinatra.cms-fields+json"], CMS_SNAPSHOT_EXT);
  artifactType(CMS_CAPTURE_TYPE, ["image/png"], CMS_SNAPSHOT_EXT);
  // The typed-DATA type: claim-backed but NOT an artifact descriptor.
  objectTypeRegistry.register(
    {
      type: DATA_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      dispositions: { projection: "artifact-safe" },
    } as never,
    DATA_EXT,
  );

  // The org HOLDS both claims.
  seedDedicatedClaim({ id: nextId("claim-pack"), type: PACK_TYPE, ext: PACK_EXT });
  // snapshotPolicy 'none' — a real file-artifact pack's claim: its rows carry
  // authored bytes, so serializing the mutable object row is forbidden. The
  // DIRECT arm must pin such a row anyway (it snapshots nothing), and when the
  // claim stops being active the row must fall out entirely, with no snapshot
  // arm to fall back to.
  seedDedicatedClaim({
    id: CLAIM_ID_2,
    type: PACK_TYPE_2,
    ext: PACK_EXT_2,
    dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "none" },
  });
  seedDedicatedClaim({ id: nextId("claim-data"), type: DATA_TYPE, ext: DATA_EXT });
}, 120_000);

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

// ---------------------------------------------------------------------------
// RESIDUAL (a)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2139 residual (a) — a claim-holding org's produced artifact is context-pinnable (real DB + disk)",
  () => {
    it("CANDIDATE: the produced FILE artifact is pinned at its AUTHORED representation, and no data snapshot is minted for it", async () => {
      const produced = await produce("# Pin me\n\nauthored bytes.\n");
      const binding = bindingMod.readActiveBinding(ORG, produced.artifactId);
      expect(binding!.extension).toBe(PACK_EXT);
      // The writer emitted the provenance witness for this exact representation.
      expect(witnessCount(produced.artifactId, produced.representationRevisionId)).toBe(1);

      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-direct", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
      });

      // The DIRECT arm took it: pinned, nothing captured, nothing attempted on
      // the snapshot arm.
      expect(cap.directPinned).toBe(1);
      expect(cap.captured).toBe(0);
      expect(cap.attempted).toBe(0);
      const pin = cap.pins.find((p) => p.objectId === produced.artifactId);
      expect(pin).toBeDefined();
      // Pinned at the AUTHORED representation — not at a manufactured snapshot
      // of the row's metadata envelope.
      expect(pin!.representationRevisionId).toBe(produced.representationRevisionId);
      expect(pin!.semanticAssertionId).toBe(binding!.id);
      // And nothing was written: a file artifact has no content snapshot.
      expect(count("object_content_snapshots", "org_id=$1 AND object_id=$2", [ORG, produced.artifactId])).toBe(0);
    });

    it("RESOLVE: the pinned candidate resolves with the triple intact; without pins the claimed row stays fail-closed EXCLUDED", async () => {
      const produced = await produce("# Resolve me\n");
      const binding = bindingMod.readActiveBinding(ORG, produced.artifactId);
      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-resolve", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
      });

      const refs = resolverMod.resolveContextSlot({
        actor,
        slot: slotFor("slot-resolve", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
        snapshotPins: cap.pins,
      });
      const ref = refs.find((r) => r.artifactId === produced.artifactId);
      expect(ref).toBeDefined();
      expect(ref!.representationRevisionId).toBe(produced.representationRevisionId);
      expect(ref!.semanticAssertionId).toBe(binding!.id);
      expect(ref!.extension).toBe(PACK_EXT);

      // The #1430 fail-closed rule is untouched: no pins, no claimed candidate.
      expect(
        resolverMod.resolveContextSlot({
          actor,
          slot: slotFor("slot-resolve", [PACK_EXT]),
          installedExtensions: installedFor([PACK_EXT]),
        }),
      ).toHaveLength(0);
    });

    it("FINALIZE: the resolved triple finalizes — audit row + REAL retention pin, both keyed to the authored representation", async () => {
      const produced = await produce("# Finalize me\n");
      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-final", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
      });
      const refs = resolverMod.resolveContextSlot({
        actor,
        slot: slotFor("slot-final", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
        snapshotPins: cap.pins,
      });
      const ref = refs.find((r) => r.artifactId === produced.artifactId)!;

      const referrerId = nextId("ref");
      const fin = finalizeMod.finalizeContextSelectionPin({
        selection: {
          orgId: ORG,
          parentRunId: nextId("run"),
          parentPackageName: "@cinatra-ai/agent",
          slotId: "slot-final",
          artifactId: ref.artifactId,
          representationRevisionId: ref.representationRevisionId,
          semanticAssertionId: ref.semanticAssertionId,
          extension: ref.extension,
          sourceScope: ref.sourceScope,
          selectedBy: "autonomous",
          selectionMode: "autonomous",
        },
        referrerKind: "agent_run",
        referrerId,
      });
      expect(fin.selectionWritten).toBe(true);
      expect(fin.pinWritten).toBe(true);

      const selRow = sql(
        `SELECT artifact_id, representation_revision_id, semantic_assertion_id, extension
         FROM "${S()}"."run_context_selections" WHERE id = $1`,
        [fin.selectionId],
      ).rows[0] as Record<string, string>;
      expect(selRow.representation_revision_id).toBe(produced.representationRevisionId);
      expect(selRow.extension).toBe(PACK_EXT);
      // The REAL retention pin (what keeps the resource alive against GC).
      expect(
        count("artifact_refs", "org_id=$1 AND artifact_id=$2 AND representation_revision_id=$3 AND referrer_id=$4", [
          ORG,
          produced.artifactId,
          produced.representationRevisionId,
          referrerId,
        ]),
      ).toBe(1);
    });

    it("COHERENCE: a pinned candidate is never a DOOMED candidate — the same representation serves its real bytes", async () => {
      const produced = await produce("# Serve me\n\nreal bytes.\n");
      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-serve", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
      });
      const pin = cap.pins.find((p) => p.objectId === produced.artifactId)!;
      // The context path admits exactly the type set the serve arm admits, so a
      // pin can never point at bytes the byte route would refuse to hand back.
      const served = readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: produced.artifactId,
        representationRevisionId: pin.representationRevisionId,
        liveOnly: true,
      });
      expect(served).not.toBeNull();
      expect(served!.mime).toBe("text/markdown");
      expect(served!.sizeBytes).toBeGreaterThan(0);
    });

    it("ISOLATION: a claimed TYPED-DATA row keeps the SNAPSHOT arm — never a direct pin (cinatra#1430 preserved)", async () => {
      const objectId = nextId("obj-data");
      sql(
        `INSERT INTO "${S()}"."objects"
           (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
         VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
        [objectId, DATA_TYPE, ORG, JSON.stringify({ name: "a campaign", body: "row content" })],
      );
      bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
      const binding = bindingMod.readActiveBinding(ORG, objectId);
      expect(binding).not.toBeNull();

      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-data", [DATA_EXT]),
        installedExtensions: installedFor([DATA_EXT]),
      });
      // The DIRECT arm never touches it (no isArtifact descriptor, no witness);
      // the row is snapshotted exactly as before.
      expect(cap.directPinned).toBe(0);
      expect(cap.captured).toBe(1);
      const pin = cap.pins.find((p) => p.objectId === objectId)!;
      expect(
        count(
          "object_content_snapshots",
          "org_id=$1 AND object_id=$2 AND representation_revision_id=$3",
          [ORG, objectId, pin.representationRevisionId],
        ),
      ).toBe(1);

      // And a HAND-BUILT pin at a raw, unwitnessed representation of that same
      // claimed row is refused by the resolver AND by the finalizer — the row's
      // only exposable content stays its policy-keyed snapshot.
      const rawRep = seedUnwitnessedRepresentation(objectId);
      expect(
        resolverMod.resolveContextSlot({
          actor,
          slot: slotFor("slot-data", [DATA_EXT]),
          installedExtensions: installedFor([DATA_EXT]),
          snapshotPins: [
            { objectId, representationRevisionId: rawRep, semanticAssertionId: binding!.id },
          ],
        }),
      ).toHaveLength(0);
      expect(() =>
        finalizeMod.finalizeContextSelectionPin({
          selection: {
            orgId: ORG,
            parentRunId: nextId("run"),
            parentPackageName: "@cinatra-ai/agent",
            slotId: "slot-data",
            artifactId: objectId,
            representationRevisionId: rawRep,
            semanticAssertionId: binding!.id,
            extension: DATA_EXT,
            sourceScope: "organization",
            selectedBy: "autonomous",
            selectionMode: "autonomous",
          },
          referrerKind: "agent_run",
          referrerId: nextId("ref"),
        }),
      ).toThrow(finalizeMod.SelectionCoherenceError);
    });

    it("FORGERY: a claimed PACK-typed row with a representation NO host writer authored is refused at all three sites — and the real witness flips every one of them", async () => {
      // The dangerous shape: the type IS a registered isArtifact pack type, the
      // row IS claimed, and a representation exists over real resource/blob rows
      // — everything except the append-only writer-provenance row, which no
      // objects/MCP write path can reach.
      const objectId = nextId("obj-forged");
      sql(
        `INSERT INTO "${S()}"."objects"
           (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
         VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
        [
          objectId,
          PACK_TYPE,
          ORG,
          JSON.stringify({ artifactType: "file", secretish: "claimant-private row content" }),
        ],
      );
      bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: objectId });
      const binding = bindingMod.readActiveBinding(ORG, objectId);
      const rawRep = seedUnwitnessedRepresentation(objectId);

      const slot = slotFor("slot-forged", [PACK_EXT]);
      const installed = installedFor([PACK_EXT]);
      const forgedPin = [
        { objectId, representationRevisionId: rawRep, semanticAssertionId: binding!.id },
      ];
      const selection = {
        orgId: ORG,
        parentRunId: nextId("run"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-forged",
        artifactId: objectId,
        representationRevisionId: rawRep,
        semanticAssertionId: binding!.id,
        extension: PACK_EXT,
        sourceScope: "organization" as const,
        selectedBy: "autonomous" as const,
        selectionMode: "autonomous" as const,
      };

      // SITE 1 — the DIRECT arm mints no pin for it. (The row still takes the
      // ordinary #1430 snapshot arm, because its claim permits content
      // snapshots: that path is redaction-gated and unchanged by this work. What
      // must never happen is the row being pinned at its UNWITNESSED bytes.)
      const capBefore = await snapshotMod.captureSnapshotsForContextSlot({ actor, slot, installedExtensions: installed });
      expect(capBefore.pins.some((p) => p.representationRevisionId === rawRep)).toBe(false);
      const pinBefore = capBefore.pins.find((p) => p.objectId === objectId);
      expect(
        count("object_content_snapshots", "org_id=$1 AND object_id=$2 AND representation_revision_id=$3", [
          ORG,
          objectId,
          pinBefore!.representationRevisionId,
        ]),
      ).toBe(1);
      // SITE 2 — even handed the pin directly, the resolver drops it.
      expect(
        resolverMod.resolveContextSlot({ actor, slot, installedExtensions: installed, snapshotPins: forgedPin })
          .some((r) => r.artifactId === objectId),
      ).toBe(false);
      // SITE 3 — the finalizer refuses the triple.
      expect(() =>
        finalizeMod.finalizeContextSelectionPin({
          selection,
          referrerKind: "agent_run",
          referrerId: nextId("ref"),
        }),
      ).toThrow(finalizeMod.SelectionCoherenceError);
      // …and the batch finalizer refuses it too (the second SQL site).
      expect(() =>
        finalizeMod.finalizeContextSelectionPinsAtomic([
          { selection, referrerKind: "agent_run", referrerId: nextId("ref") },
        ]),
      ).toThrow(finalizeMod.SelectionCoherenceError);

      // CONTROL ON THE CONTROL: mint the REAL provenance row for that exact
      // representation and all three sites admit it — proving each refusal above
      // is the witness predicate, not an unrelated mismatch.
      sql(
        `INSERT INTO "${S()}"."artifact_audit"
           (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
         VALUES ($1,$2,$3,$4,'create',NULL,'{}'::jsonb)`,
        [nextId("aud"), ORG, objectId, rawRep],
      );
      const capAfter = await snapshotMod.captureSnapshotsForContextSlot({ actor, slot, installedExtensions: installed });
      const pin = capAfter.pins.find((p) => p.objectId === objectId);
      expect(pin?.representationRevisionId).toBe(rawRep);
      expect(
        resolverMod.resolveContextSlot({ actor, slot, installedExtensions: installed, snapshotPins: capAfter.pins })
          .some((r) => r.artifactId === objectId),
      ).toBe(true);
      expect(
        finalizeMod.finalizeContextSelectionPin({
          selection,
          referrerKind: "agent_run",
          referrerId: nextId("ref"),
        }).pinWritten,
      ).toBe(true);
    });

    it("WINNER IDENTITY: a RETIRING claim is still the winner and still pins; a claim SUPERSEDED by a narrower-scope one stops pinning before the queue drains", async () => {
      const produced = await produce("# Winner change\n", PACK_TYPE_2, PACK_EXT_2);
      const slot = slotFor("slot-winner", [PACK_EXT_2]);
      const installed = installedFor([PACK_EXT_2]);
      const pinned = async () =>
        (await snapshotMod.captureSnapshotsForContextSlot({ actor, slot, installedExtensions: installed }))
          .pins.find((p) => p.objectId === produced.artifactId) ?? null;

      const first = await pinned();
      // The claim's snapshotPolicy is 'none' and the row is pinned anyway: the
      // direct arm snapshots nothing, so that policy has nothing to say about it.
      expect(first!.representationRevisionId).toBe(produced.representationRevisionId);
      expect(count("object_content_snapshots", "org_id=$1 AND object_id=$2", [ORG, produced.artifactId])).toBe(0);

      // RETIRING is still the winner — the direct arm must NOT reject it. (A bare
      // status='active' gate would, which is why the gate is winner identity.)
      sql(`UPDATE "${S()}"."artifact_type_claims" SET status='retiring' WHERE id=$1`, [CLAIM_ID_2]);
      expect((await pinned())?.representationRevisionId).toBe(produced.representationRevisionId);
      sql(`UPDATE "${S()}"."artifact_type_claims" SET status='active' WHERE id=$1`, [CLAIM_ID_2]);

      // Now the real window: the org claim is superseded by a HIGHER-precedence
      // one for the same type, both rows 'active' (claim uniqueness is per
      // scope), and the reconcile queue has NOT drained — so the artifact's sole
      // eligible binding still names the OLD claim. No status check can see this;
      // winner identity can.
      const pinBefore = (await pinned())!;
      sql(
        `UPDATE "${S()}"."artifact_type_claims" SET scope='platform' WHERE id=$1`,
        [CLAIM_ID_2],
      );
      sql(
        `INSERT INTO "${S()}"."artifact_type_claims"
           (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
         VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
        [
          nextId("claim-pack-2-org"),
          `org:${ORG}`,
          PACK_TYPE_2,
          PACK_EXT_2,
          JSON.stringify({ projection: "artifact-safe", pinnable: true, snapshotPolicy: "none" }),
        ],
      );
      // The binding is deliberately LEFT eligible and its claim left active.
      expect(bindingMod.readActiveBinding(ORG, produced.artifactId)).not.toBeNull();

      expect(await pinned()).toBeNull();
      // The RESOLVER's own winner gate, exercised directly: handed the
      // pre-transition pin (as a stale caller would), it drops the candidate
      // rather than resolving an identity the finalizer would then refuse.
      expect(
        resolverMod
          .resolveContextSlot({ actor, slot, installedExtensions: installed, snapshotPins: [pinBefore] })
          .some((r) => r.artifactId === produced.artifactId),
      ).toBe(false);
      // …and the selection resolved under the superseded claimant no longer
      // finalizes, at either finalizer statement.
      const selection = {
        orgId: ORG,
        parentRunId: nextId("run"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-winner",
        artifactId: produced.artifactId,
        representationRevisionId: pinBefore.representationRevisionId,
        semanticAssertionId: pinBefore.semanticAssertionId,
        extension: PACK_EXT_2,
        sourceScope: "organization" as const,
        selectedBy: "autonomous" as const,
        selectionMode: "autonomous" as const,
      };
      expect(() =>
        finalizeMod.finalizeContextSelectionPin({
          selection,
          referrerKind: "agent_run",
          referrerId: nextId("ref"),
        }),
      ).toThrow(finalizeMod.SelectionCoherenceError);
      expect(() =>
        finalizeMod.finalizeContextSelectionPinsAtomic([
          { selection, referrerKind: "agent_run", referrerId: nextId("ref") },
        ]),
      ).toThrow(finalizeMod.SelectionCoherenceError);

      // Draining the reconcile (the shipped write path) re-binds the row to the
      // NEW winner and the direct arm admits it again — under the new identity.
      bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: produced.artifactId });
      const after = await pinned();
      expect(after?.representationRevisionId).toBe(produced.representationRevisionId);
      expect(after?.semanticAssertionId).not.toBe(pinBefore.semanticAssertionId);
    });

    it("TYPE CHANGE: a row that stops being a registered artifact type stops resolving through the witness arm", async () => {
      // The resolver is handed HOST-computed pins, but its witness arm carries
      // the same pack-type predicate the candidate rule, the serve arm and the
      // finalizer carry — so a type change between capture and resolve yields NO
      // candidate rather than one every later gate would refuse.
      const produced = await produce("# Retyped\n");
      const slot = slotFor("slot-retype", [PACK_EXT]);
      const installed = installedFor([PACK_EXT]);
      const cap = await snapshotMod.captureSnapshotsForContextSlot({ actor, slot, installedExtensions: installed });
      const pins = cap.pins.filter((p) => p.objectId === produced.artifactId);
      expect(pins).toHaveLength(1);
      expect(
        resolverMod
          .resolveContextSlot({ actor, slot, installedExtensions: installed, snapshotPins: pins })
          .some((r) => r.artifactId === produced.artifactId),
      ).toBe(true);

      sql(`UPDATE "${S()}"."objects" SET type=$2 WHERE id=$1 AND org_id=$3`, [
        produced.artifactId,
        DATA_TYPE,
        ORG,
      ]);
      expect(
        resolverMod
          .resolveContextSlot({ actor, slot, installedExtensions: installed, snapshotPins: pins })
          .some((r) => r.artifactId === produced.artifactId),
      ).toBe(false);
    });

    it("CLAIMANT TRANSITION: archiving the binding between resolve and finalize REJECTS the selection (fail-closed, no fingerprint needed)", async () => {
      const produced = await produce("# Transitional\n");
      const cap = await snapshotMod.captureSnapshotsForContextSlot({
        actor,
        slot: slotFor("slot-trans", [PACK_EXT]),
        installedExtensions: installedFor([PACK_EXT]),
      });
      const pin = cap.pins.find((p) => p.objectId === produced.artifactId)!;
      const selection = {
        orgId: ORG,
        parentRunId: nextId("run"),
        parentPackageName: "@cinatra-ai/agent",
        slotId: "slot-trans",
        artifactId: produced.artifactId,
        representationRevisionId: pin.representationRevisionId,
        semanticAssertionId: pin.semanticAssertionId,
        extension: PACK_EXT,
        sourceScope: "organization" as const,
        selectedBy: "autonomous" as const,
        selectionMode: "autonomous" as const,
      };

      // The claimant goes away between resolution and finalization.
      sql(
        `UPDATE "${S()}"."semantic_assertion" SET eligibility='archived' WHERE id=$1 AND org_id=$2`,
        [pin.semanticAssertionId, ORG],
      );
      expect(() =>
        finalizeMod.finalizeContextSelectionPin({
          selection,
          referrerKind: "agent_run",
          referrerId: nextId("ref"),
        }),
      ).toThrow(finalizeMod.SelectionCoherenceError);
    });
  },
);

// ---------------------------------------------------------------------------
// RESIDUAL (b)
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2139 residual (b) — every host FILE writer rides the provenance witness (real DB + disk)",
  () => {
    it("captureCmsContentSnapshot emits the witness for its snapshot representation, in the SAME transaction", async () => {
      const res = await cmsCaptureMod.captureCmsContentSnapshot({
        orgId: ORG,
        pointer: {
          url: "https://blog.example.com/?p=42",
          connectorId: "wordpress-mcp-connector",
          externalId: "42",
          state: "linked",
          title: "Hello Post",
        },
        resolved: { mime: "text/html", text: "<h1>Original</h1><p>body</p>" },
        capturedAt: new Date().toISOString(),
        scopeManifest: { paths: ["title", "body"] },
        connectorInstance: "wordpress-mcp-connector:inst-1",
        resourceType: "post",
        cmsResourceId: "42",
        baseRemoteRevisionRef: "etag-1",
        operationId: nextId("op"),
        emitProducedEvent: false,
      });
      expect(witnessCount(res.artifactId, res.snapshotRevisionId)).toBe(1);
    });

    it("a CLAIMED captured CMS snapshot still SERVES — the consequence the missing witness would have cost", async () => {
      const res = await cmsCaptureMod.captureCmsContentSnapshot({
        orgId: ORG,
        pointer: {
          url: "https://blog.example.com/?p=77",
          connectorId: "wordpress-mcp-connector",
          externalId: "77",
          state: "linked",
          title: "Claimed Post",
        },
        resolved: { mime: "text/html", text: "<h1>Claimed</h1>" },
        capturedAt: new Date().toISOString(),
        scopeManifest: { paths: ["title"] },
        connectorInstance: "wordpress-mcp-connector:inst-1",
        resourceType: "post",
        cmsResourceId: "77",
        operationId: nextId("op"),
        emitProducedEvent: false,
      });

      // Reserve a claim over the capture type and bind the row — the future the
      // KNOWN GAP described. Before the witness, this is exactly the state that
      // made the capture stop serving on its own review surface.
      seedDedicatedClaim({
        id: nextId("claim-cms"),
        type: CMS_SNAPSHOT_TYPE,
        ext: CMS_SNAPSHOT_EXT,
        dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "none" },
      });
      bindingMod.reconcileArtifactBinding({ orgId: ORG, artifactId: res.artifactId });
      expect(bindingMod.readActiveBinding(ORG, res.artifactId)).not.toBeNull();

      const served = readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: res.artifactId,
        representationRevisionId: res.snapshotRevisionId,
        liveOnly: true,
      });
      expect(served).not.toBeNull();
      expect(served!.storageKey).toBeTruthy();
      expect(served!.sizeBytes).toBeGreaterThan(0);
    });

    it("writePinnedPreviewCapture emits the witness for its PNG — and a DEGRADED capture emits none (no representation to vouch for)", async () => {
      const captured = await previewStoreMod.writePinnedPreviewCapture({
        orgId: ORG,
        createdBy: "user-1",
        producerRunId: nextId("run"),
        screenshot: PNG,
        data: {
          role: "before",
          status: "captured",
          degradedReason: null,
          boundArtifactId: "bound-art-2139",
          boundSnapshotRevisionId: "bound-rev-2139",
          sourceOrigin: "https://blog.example.com",
          postId: 42,
          capturedAt: "2026-07-27T10:00:00.000Z",
          geometry: null,
          sanitization: null,
          network: null,
          captureDigest: null,
          title: "Hello Post",
        },
      });
      expect(captured.representationRevisionId).not.toBeNull();
      expect(witnessCount(captured.captureArtifactId, captured.representationRevisionId!)).toBe(1);

      const degraded = await previewStoreMod.writePinnedPreviewCapture({
        orgId: ORG,
        data: {
          role: "applied",
          status: "degraded",
          degradedReason: "preview-unreachable",
          boundArtifactId: "bound-art-2139",
          boundSnapshotRevisionId: "bound-rev-2139",
          sourceOrigin: null,
          postId: null,
          capturedAt: "2026-07-27T10:05:00.000Z",
          geometry: null,
          sanitization: null,
          network: null,
          captureDigest: null,
          title: "Hello Post",
        },
      });
      expect(degraded.representationRevisionId).toBeNull();
      expect(
        count("artifact_audit", "org_id=$1 AND artifact_id=$2 AND action='create'", [
          ORG,
          degraded.captureArtifactId,
        ]),
      ).toBe(0);
    });
  },
);
