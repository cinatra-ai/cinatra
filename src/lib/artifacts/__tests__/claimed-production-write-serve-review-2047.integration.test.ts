/**
 * cinatra#2047 re-acceptance D-8 + OBS-1 — the SHIPPED producer write path must
 * work end to end for an org that actually HOLDS the artifact pack's claim.
 * REAL-DB integration proof (no mocks on the DB / storage path).
 *
 * THE REPRO THIS SUITE INVERTS (recorded live in the #2047 re-acceptance):
 *
 *   D-8    `materializeBlogPostBodyArtifact` THREW on any claim-holding org.
 *          `createSemanticArtifact` composes the binding reconcile into its Tx2
 *          (cinatra#1868), so the committed row already carries a BINDING-basis
 *          `semantic_assertion` for the claim winner. The materializer's trailing
 *          classic `assertSemanticType` could not archive that binding
 *          (`buildAssertionOps`' archive excludes `assertion_basis='binding'`)
 *          AND did not treat it as a precedence block, so its INSERT collided
 *          with `sa_active_unique_idx (org_id, artifact_id, extension)` —
 *          `duplicate key`, AFTER the artifact had committed (an orphan).
 *          `artifact-creation.ts` documents exactly this asymmetry for the in-Tx
 *          ordering; the post-Tx call re-created it.
 *   OBS-1  the produced revision was then UNSERVABLE:
 *          `resolveArtifactVersionForServe(liveOnly:true)` returned null because
 *          the pack-typed direct-representation arm was guarded by
 *          `NOT EXISTS (… binding …)`, and a claimed row served only through an
 *          `object_content_snapshots` row that nothing writes for a FILE
 *          artifact. Live consequence: the run-embedded review target rendered
 *          "review target unavailable — reason `revision-not-member`", and the
 *          typed changes-request came back BLOCKED `tombstoned-base` (the
 *          `revisionMember` port resolved the base witness to null).
 *
 * The four rungs proven here, on a claim-holding org, against real DDL +
 * constraints + real blob IO:
 *   1. PRODUCE  — the materializer's exact call pair (createSemanticArtifact →
 *                 assertSemanticType) does NOT throw; the row commits with the
 *                 winner BINDING and the redundant classic is a precedence
 *                 no-op, never a duplicate-key.
 *   2. SERVE    — `resolveArtifactVersionForServe({liveOnly:true})` resolves the
 *                 produced revision's real bytes.
 *   3. GATE     — the review preparation core, driven through the REAL
 *                 `revisionMember` port, prepares a target that is NOT the
 *                 `revision-not-member` floor.
 *   4. REPAIR   — `recordReviewSurfaceChangesRequested` with the witness the
 *                 surface binder computes from that same port is ACCEPTED (a
 *                 repair opens); it is no longer `tombstoned-base`.
 *
 * And the ratified invariant that MUST survive:
 *   5. ISOLATION — a claimed TYPED-DATA row (no file-artifact envelope, no
 *                  content snapshot) still does NOT serve its direct
 *                  representation (cinatra#1430 claimant isolation, epic #1424).
 *
 * ISOLATION (the #1868 / #1430 integration pattern): fresh schema per file from
 * the CANONICAL `buildCreateStoreSchemaQueries` DDL; the blob root is a temp dir;
 * every app module is dynamically imported in `beforeAll` AFTER the env is set
 * (postgresSchema is a module-load const). The heavy app-boot registrar is no-op'd
 * so this suite's directly-registered types survive the reader gates' warm.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/<db> \
 *     pnpm test src/lib/artifacts/__tests__/claimed-production-write-serve-review-2047
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const TEST_SCHEMA = "cinatra_test_claimed_production_2047";
const ORG = "org-2047-d8";

/** The blog-post-artifact shape: a registered isArtifact PACK type whose OWN pack
 * holds the dedicated claim over it (what a real marketplace install produces). */
const PACK_TYPE = "@cinatra-ai/blog-post-artifact:post";
const PACK_EXT = "@cinatra-ai/blog-post-artifact";
/** A claimed TYPED-DATA type: claim-backed, NO isArtifact descriptor — the row
 * class cinatra#1430's claimant isolation actually governs. */
const DATA_TYPE = "@cinatra-ai/campaigns:campaign";
const DATA_EXT = "@cinatra-ai/campaigns";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let creationMod: typeof import("@/lib/artifacts/artifact-creation");
let assertionMod: typeof import("@/lib/artifacts/semantic-assertion-store");
let bindingMod: typeof import("@/lib/objects/binding-write-path");
let readMod: typeof import("@/lib/artifacts/artifact-read");
let prepMod: typeof import("@/lib/artifacts/artifact-review-preparation");
let gateStore: typeof import("@cinatra-ai/agents/artifact-review-gate-store");
let crStore: typeof import("@cinatra-ai/agents/lifecycle-review-changes-requested");
let orchIds: typeof import("@/lib/lifecycle/lifecycle-orchestration");
let producedIds: typeof import("@/lib/lifecycle/lifecycle-produced-event");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Directly seed an ACTIVE dedicated claim over `type` (org scope) — the state
 * `activateArtifactExtensionClaims` (the install anchor's own function) leaves. */
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

function activeAssertions(artifactId: string): Array<{ extension: string; basis: string }> {
  const r = sql(
    `SELECT extension, assertion_basis AS basis FROM "${S()}"."semantic_assertion"
       WHERE org_id=$1 AND artifact_id=$2 AND eligibility<>'archived' ORDER BY extension`,
    [ORG, artifactId],
  );
  return r.rows.map((row) => ({
    extension: String(row.extension),
    basis: String(row.basis),
  }));
}

/** The SHIPPED producer call pair — byte-for-byte what
 * `materializeBlogPostBodyArtifact` does around the artifact write choke point
 * (createSemanticArtifact, then the trailing classic assertion). */
async function produceThroughShippedWritePath(body: string): Promise<{
  artifactId: string;
  representationRevisionId: string;
  assertion: { inserted: boolean; blockedByPrecedence: boolean };
}> {
  const created = await creationMod.createSemanticArtifact({
    orgId: ORG,
    objectType: PACK_TYPE,
    expectedAcceptMimes: ["text/markdown"],
    createdBy: null,
    ownerLevel: "organization",
    ownerId: ORG,
    title: "blog post body",
    declaredMime: "text/markdown",
    originKind: "agent_generated",
    stream: bytes(body),
    createdByRunId: null,
    skipFallbackClassification: true,
  });
  const assertion = assertionMod.assertSemanticType({
    orgId: ORG,
    artifactId: created.artifactId,
    extension: PACK_EXT,
    assertedBy: "agent",
    principal: null,
  });
  return { ...created, assertion };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-2047-d8-"));

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
  readMod = await import("@/lib/artifacts/artifact-read");
  prepMod = await import("@/lib/artifacts/artifact-review-preparation");
  gateStore = await import("@cinatra-ai/agents/artifact-review-gate-store");
  crStore = await import("@cinatra-ai/agents/lifecycle-review-changes-requested");
  orchIds = await import("@/lib/lifecycle/lifecycle-orchestration");
  producedIds = await import("@/lib/lifecycle/lifecycle-produced-event");

  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    {
      type: PACK_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    PACK_EXT,
  );
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

  // The org HOLDS the pack's claim — the exact state the re-acceptance activated
  // through the shipped `activateArtifactExtensionClaims`.
  seedDedicatedClaim({ id: nextId("claim-pack"), type: PACK_TYPE, ext: PACK_EXT });
  seedDedicatedClaim({ id: nextId("claim-data"), type: DATA_TYPE, ext: DATA_EXT });
}, 120_000);

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  await (
    gateStore as unknown as { agentBuilderPool?: { end: () => Promise<void> } }
  )?.agentBuilderPool?.end?.().catch(() => {});
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#2047 D-8 + OBS-1 — the shipped producer write path on a CLAIM-HOLDING org (real DB + disk)",
  () => {
    // -----------------------------------------------------------------------
    // RUNG 1 — PRODUCE (D-8).
    // -----------------------------------------------------------------------
    it("D-8: the shipped write path (createSemanticArtifact → assertSemanticType) does NOT throw on a claim-holding org", async () => {
      const produced = await produceThroughShippedWritePath("# Hello\n\nbody one.\n");
      expect(produced.artifactId).toBeTruthy();
      expect(produced.representationRevisionId).toBeTruthy();

      // The winner binding committed IN the creation Tx (cinatra#1868)…
      const binding = bindingMod.readActiveBinding(ORG, produced.artifactId);
      expect(binding).not.toBeNull();
      expect(binding!.extension).toBe(PACK_EXT);

      // …and the redundant classic is a PRECEDENCE NO-OP, not a duplicate key:
      // the binding already asserts this exact extension with higher authority.
      expect(produced.assertion.inserted).toBe(false);
      expect(produced.assertion.blockedByPrecedence).toBe(true);

      // Exactly ONE active assertion for the extension — the binding. (The
      // pre-fix behaviour could not reach this line: the INSERT collided with
      // sa_active_unique_idx and threw AFTER the artifact row had committed.)
      expect(activeAssertions(produced.artifactId)).toEqual([
        { extension: PACK_EXT, basis: "binding" },
      ]);
    });

    it("D-8: the write path is REPEATABLE — a second production on the same claim-holding org also succeeds", async () => {
      const a = await produceThroughShippedWritePath("# One\n");
      const b = await produceThroughShippedWritePath("# Two\n");
      expect(a.artifactId).not.toBe(b.artifactId);
      expect(activeAssertions(b.artifactId)).toEqual([
        { extension: PACK_EXT, basis: "binding" },
      ]);
    });

    // -----------------------------------------------------------------------
    // RUNG 2 — SERVE (OBS-1).
    // -----------------------------------------------------------------------
    it("OBS-1: the produced revision SERVES — resolveArtifactVersionForServe(liveOnly) resolves its real bytes", async () => {
      const produced = await produceThroughShippedWritePath("# Servable\n\nbytes.\n");
      const resolved = readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: produced.artifactId,
        representationRevisionId: produced.representationRevisionId,
        liveOnly: true,
      });
      expect(resolved).not.toBeNull();
      expect(resolved!.mime).toBe("text/markdown");
      expect(resolved!.storageKey).toBeTruthy();
      expect(resolved!.sizeBytes).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // RUNG 3 — the review target is DECIDABLE (no `revision-not-member` floor).
    // -----------------------------------------------------------------------
    it("OBS-1: the review preparation core, driven through the REAL revisionMember port, does NOT floor to revision-not-member", async () => {
      const produced = await produceThroughShippedWritePath("# Reviewable\n");
      const target = {
        artifactId: produced.artifactId,
        representationRevisionId: produced.representationRevisionId,
      };
      // The ONE real port: byte-for-byte the surface binder's
      // (`review-target-prepare.ts`) revisionMember — liveOnly against the real
      // store. The remaining ports are the core's proven-elsewhere collaborators.
      const revisionMember = (artifactId: string, representationRevisionId: string) => {
        const resolved = readMod.resolveArtifactVersionForServe({
          orgId: ORG,
          artifactId,
          representationRevisionId,
          liveOnly: true,
        });
        return resolved ? { mime: resolved.mime } : null;
      };
      const artifact = { id: produced.artifactId, title: "blog post body" };
      const result = await prepMod.prepareReviewTargetsCore(
        { runId: "run-2047-prep", reviewTaskId: `wayflow-${randomUUID()}`, targets: [target] },
        {
          verifyRunAccess: () => ({ ok: true }) as const,
          readGatePinnedTargets: () => ({ status: "pending", targets: [target] }) as const,
          readArtifact: () =>
            ({ kind: "ok", artifact: artifact as never }) as never,
          revisionMember,
          resolveMount: () =>
            ({ kind: "floor", packageName: PACK_EXT, reason: "no-semantic-renderer" }) as const,
          buildProps: () => ({ propsApiVersion: 1 }) as never,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prepared).toHaveLength(1);
      const mount = result.prepared[0].mount;
      // The defect rendered "review target unavailable — reason revision-not-member".
      expect(mount.kind === "floor" ? mount.reason : null).not.toBe("revision-not-member");
      // Props exist ⇒ the core got past the member check with a real mime.
      expect(result.prepared[0].props).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // RUNG 4 — the typed changes-request is ACCEPTED (no `tombstoned-base`).
    // -----------------------------------------------------------------------
    it("OBS-1: a typed changes-request on the produced revision is ACCEPTED — a repair opens, never tombstoned-base", async () => {
      const produced = await produceThroughShippedWritePath("# Needs work\n");
      const target = {
        artifactId: produced.artifactId,
        representationRevisionId: produced.representationRevisionId,
      };
      const runId = `run-${randomUUID()}`;
      const eventId = producedIds.producedEventId(
        target.artifactId,
        target.representationRevisionId,
        "artifact_produced",
      );
      const reviewTaskId = orchIds.autoReviewTaskId(eventId);
      await gateStore.emitArtifactReviewGate({
        runId,
        orgId: ORG,
        reviewTaskId,
        targets: [target],
      });

      // The CAS witness EXACTLY as `submitReviewSurfaceChangesRequested` derives
      // it: the pinned revision when the revisionMember port resolves it live,
      // null when it does not. Before the fix this resolved to null on a
      // claim-holding org — the `tombstoned-base` BLOCK the re-acceptance saw.
      const member = readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: target.artifactId,
        representationRevisionId: target.representationRevisionId,
        liveOnly: true,
      });
      const currentBaseRevisionId = member ? target.representationRevisionId : null;
      expect(currentBaseRevisionId).toBe(target.representationRevisionId);

      const cr = await crStore.recordReviewSurfaceChangesRequested({
        runId,
        reviewTaskId,
        baseTarget: target,
        currentBaseRevisionId,
        feedback: "Tighten the headline and add a CTA.",
      });
      expect(cr.ok).toBe(true);
      if (!cr.ok) {
        expect(cr.code).not.toBe("tombstoned-base");
        return;
      }
      expect(cr.repairId).toBeTruthy();
      // The base gate CLOSED as changes_requested — the review attempt is decided.
      const closed = await gateStore.readReviewGate(runId, reviewTaskId);
      expect(closed!.status).toBe("resolved");
      expect(closed!.disposition).toBe("changes_requested");
    });

    // -----------------------------------------------------------------------
    // RUNG 5 — the ratified invariant that MUST survive.
    // -----------------------------------------------------------------------
    it("cinatra#1430 claimant isolation PRESERVED — a claimed TYPED-DATA row still does NOT serve a direct representation", () => {
      // A typed-DATA row: claim-backed, NO file-artifact envelope in objects.data
      // and no content snapshot. This is the row class #1430 governs — its only
      // legitimate served content is the policy-keyed snapshot.
      const objectId = nextId("obj-data");
      const resourceId = nextId("res");
      const blobId = nextId("blob");
      const repId = nextId("rep");
      const sha = nextId("sha");
      sql(
        `INSERT INTO "${S()}"."objects"
           (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
         VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
        [objectId, DATA_TYPE, ORG, JSON.stringify({ name: "a campaign" })],
      );
      sql(
        `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
         VALUES ($1,$2,'local-disk',$3,$4,$5,'application/json')`,
        [blobId, ORG, `key/${blobId}`, sha, 12],
      );
      sql(
        `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata)
         VALUES ($1,$2,'blob',$3,'application/json',$4,$5::jsonb)`,
        [resourceId, ORG, `blob:${sha}`, 12, JSON.stringify({ blobId })],
      );
      sql(
        `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
         VALUES ($1,$2,$3,$4,1,'file')`,
        [repId, ORG, objectId, resourceId],
      );
      sql(
        `INSERT INTO "${S()}"."semantic_assertion"
           (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
         VALUES ($1,$2,$3,$4,'system','eligible','binding',$5,1)`,
        [nextId("sab"), ORG, objectId, DATA_EXT, nextId("claim")],
      );

      const resolved = readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: objectId,
        representationRevisionId: repId,
        liveOnly: true,
      });
      expect(resolved).toBeNull();
    });

    // -----------------------------------------------------------------------
    // RUNG 6 — the FORGERY control (adopted from the codex round on this lane).
    // -----------------------------------------------------------------------
    it("FORGERY: a CLAIMED pack-typed row with caller-forged objects.data (artifactType:'file') and NO writer-authored representation still does NOT serve", () => {
      // The dangerous shape: the row's TYPE is a registered isArtifact pack type
      // (so it passes the pack-type predicate) AND it is claimed (so #1430
      // isolation governs it) AND its objects.data carries the file-artifact
      // marker a caller can merge in through objects_save / objects_update.
      // Admission is keyed to the WRITER's append-only 'create' audit row for
      // the exact representation, which no objects/MCP write path can reach —
      // so this row is refused, and claimant isolation holds against forgery.
      const objectId = nextId("obj-forged");
      const resourceId = nextId("res");
      const blobId = nextId("blob");
      const repId = nextId("rep");
      const sha = nextId("sha");
      sql(
        `INSERT INTO "${S()}"."objects"
           (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
         VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
        [
          objectId,
          PACK_TYPE,
          ORG,
          // Exactly the envelope the artifact writer stamps — forged by a caller.
          JSON.stringify({
            artifactType: "file",
            latestRepresentationRevisionId: repId,
            mime: "text/markdown",
            secretish: "claimant-private row content",
          }),
        ],
      );
      sql(
        `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
         VALUES ($1,$2,'local-disk',$3,$4,$5,'text/markdown')`,
        [blobId, ORG, `key/${blobId}`, sha, 12],
      );
      sql(
        `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata)
         VALUES ($1,$2,'blob',$3,'text/markdown',$4,$5::jsonb)`,
        [resourceId, ORG, `blob:${sha}`, 12, JSON.stringify({ blobId })],
      );
      sql(
        `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
         VALUES ($1,$2,$3,$4,1,'file')`,
        [repId, ORG, objectId, resourceId],
      );
      sql(
        `INSERT INTO "${S()}"."semantic_assertion"
           (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
         VALUES ($1,$2,$3,$4,'system','eligible','binding',$5,1)`,
        [nextId("sab"), ORG, objectId, PACK_EXT, nextId("claim")],
      );
      // NO artifact_audit 'create' row — nothing the artifact writer authored.

      expect(
        readMod.resolveArtifactVersionForServe({
          orgId: ORG,
          artifactId: objectId,
          representationRevisionId: repId,
          liveOnly: true,
        }),
      ).toBeNull();

      // Control on the control: the SAME row becomes servable the moment a real
      // writer-provenance row exists for that exact representation — proving the
      // refusal above is the provenance predicate, not an unrelated mismatch.
      sql(
        `INSERT INTO "${S()}"."artifact_audit"
           (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
         VALUES ($1,$2,$3,$4,'create',NULL,'{}'::jsonb)`,
        [nextId("aud"), ORG, objectId, repId],
      );
      expect(
        readMod.resolveArtifactVersionForServe({
          orgId: ORG,
          artifactId: objectId,
          representationRevisionId: repId,
          liveOnly: true,
        }),
      ).not.toBeNull();
    });
  },
);
