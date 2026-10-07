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
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

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
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
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

/** cinatra#3603 — THE HOST-SHAPED CLASS. A type registered host-side with a
 * `dispositions` payload, NO `isArtifact` descriptor and NO package-name
 * argument (byte-for-byte the shape `register-types.ts` produces for a
 * claim-backed host type), claimed by a pack whose NAME IS NOT the type's
 * namespace. Such a type can never enter `objectTypeRegistry.listArtifacts()`,
 * so the read side's old type source could never admit it while the write side
 * (which reads the org's claim winners) already did. Registered HERE rather
 * than read out of a registrar, so these cases measure the CLASS and not the
 * contents of a registrar another change may move. */
const HOST_TYPE = "@cinatra-ai/host3603-social:post-draft";
const HOST_CLAIM_EXT = "@cinatra-ai/host3603-social-artifacts";
/** The same shape whose WINNING claim projects `none` (the `email:recipient`
 * class) — never artifact-safe, so it stays refused before AND after. */
const HOST_NONE_TYPE = "@cinatra-ai/host3603-privacy:recipient";
const HOST_NONE_EXT = "@cinatra-ai/host3603-privacy-artifacts";
/** The same shape whose org chain carries a RETIRED claim by one package and
 * the ACTIVE winner by another — admission follows the WINNER, not any claim. */
const HOST_WINNER_TYPE = "@cinatra-ai/host3603-docs:page";
const HOST_WINNER_RETIRED_EXT = "@cinatra-ai/host3603-docs-legacy";
const HOST_WINNER_ACTIVE_EXT = "@cinatra-ai/host3603-docs-artifacts";
/** A SECOND organisation that holds no claim over any of them at any scope of
 * its chain — "a type nobody claims stays refused" as behaviour. */
const ORG_NO_CLAIM = "org-3603-unclaimed";

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
let extReadMod: typeof import("@/lib/artifacts/extension-artifact-reads");
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
function seedDedicatedClaim(input: {
  id: string;
  type: string;
  ext: string;
  /** Defaults to ORG — cinatra#3603 seeds a second org's chain too. */
  orgId?: string;
  /** Defaults to 'active' — cinatra#3603 seeds a retired loser too. */
  status?: string;
  /** Defaults to 'artifact-safe' — cinatra#3603 seeds a `none` winner too. */
  projection?: "artifact-safe" | "none";
}) {
  const projection = input.projection ?? "artifact-safe";
  sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', $6, 1, $5::jsonb)`,
    [
      input.id,
      `org:${input.orgId ?? ORG}`,
      input.type,
      input.ext,
      JSON.stringify(
        projection === "none"
          ? { projection: "none", pinnable: false, snapshotPolicy: "none" }
          : { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
      ),
      input.status ?? "active",
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

/** cinatra#3603 — register a type in the HOST registrar's exact shape: a
 * `dispositions` payload, NO `isArtifact`, NO package-name argument. */
function registerHostShapedType(type: string, projection: "artifact-safe" | "none") {
  objectTypeRegistry.register({
    type,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
    renderers: { listRow: null, card: null, detail: null },
    dispositions: { projection },
  } as never);
}

/** cinatra#3603 — the write, through the SAME shipped choke point this suite
 * already drives (`createSemanticArtifact`, which emits the writer witness and
 * composes the claim-winner binding into its Tx2). */
async function produceHostShaped(input: { orgId: string; objectType: string; body: string }) {
  return creationMod.createSemanticArtifact({
    orgId: input.orgId,
    objectType: input.objectType,
    expectedAcceptMimes: ["text/markdown"],
    createdBy: null,
    ownerLevel: "organization",
    ownerId: input.orgId,
    title: "host-shaped draft",
    declaredMime: "text/markdown",
    originKind: "agent_generated",
    stream: bytes(input.body),
    createdByRunId: null,
    skipFallbackClassification: true,
  });
}

/** cinatra#3603 — a writer-authored, claimed, file-backed row seeded directly
 * (the `none`-projection type is not an artifact WRITE target, so the shipped
 * writer refuses it; the case under test is the READ gate, and this row carries
 * everything that gate tests: an eligible binding AND the writer's append-only
 * 'create' audit row for the exact representation). */
function seedWriterAuthoredClaimedRow(input: { orgId: string; type: string; ext: string }) {
  const objectId = nextId("obj-3603");
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
      input.type,
      input.orgId,
      JSON.stringify({ artifactType: "file", latestRepresentationRevisionId: repId, mime: "text/markdown" }),
    ],
  );
  sql(
    `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
     VALUES ($1,$2,'local-disk',$3,$4,$5,'text/markdown')`,
    [blobId, input.orgId, `key/${blobId}`, sha, 12],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata)
     VALUES ($1,$2,'blob',$3,'text/markdown',$4,$5::jsonb)`,
    [resourceId, input.orgId, `blob:${sha}`, 12, JSON.stringify({ blobId })],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,1,'file')`,
    [repId, input.orgId, objectId, resourceId],
  );
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation)
     VALUES ($1,$2,$3,$4,'system','eligible','binding',$5,1)`,
    [nextId("sab"), input.orgId, objectId, input.ext, nextId("claim")],
  );
  sql(
    `INSERT INTO "${S()}"."artifact_audit"
       (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
     VALUES ($1,$2,$3,$4,'create',NULL,'{}'::jsonb)`,
    [nextId("aud"), input.orgId, objectId, repId],
  );
  return { objectId, repId };
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
  const { replayStoreSchema } = await import("@/lib/test-support/store-schema-replay");
  await replayStoreSchema(client, buildCreateStoreSchemaQueries(TEST_SCHEMA));
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  creationMod = await import("@/lib/artifacts/artifact-creation");
  assertionMod = await import("@/lib/artifacts/semantic-assertion-store");
  bindingMod = await import("@/lib/objects/binding-write-path");
  readMod = await import("@/lib/artifacts/artifact-read");
  extReadMod = await import("@/lib/artifacts/extension-artifact-reads");
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

  // cinatra#3603 — the host-shaped class: three types in the host registrar's
  // exact shape, each claimed by a package whose name is NOT the type's
  // namespace, so none of them can ever enter `listArtifacts()`.
  registerHostShapedType(HOST_TYPE, "artifact-safe");
  registerHostShapedType(HOST_NONE_TYPE, "none");
  registerHostShapedType(HOST_WINNER_TYPE, "artifact-safe");
  seedDedicatedClaim({ id: nextId("claim-host"), type: HOST_TYPE, ext: HOST_CLAIM_EXT });
  seedDedicatedClaim({
    id: nextId("claim-host-none"),
    type: HOST_NONE_TYPE,
    ext: HOST_NONE_EXT,
    projection: "none",
  });
  // The RETIRED loser and the ACTIVE winner over one type, in one org chain.
  seedDedicatedClaim({
    id: nextId("claim-winner-retired"),
    type: HOST_WINNER_TYPE,
    ext: HOST_WINNER_RETIRED_EXT,
    status: "retired",
    projection: "none",
  });
  seedDedicatedClaim({
    id: nextId("claim-winner-active"),
    type: HOST_WINNER_TYPE,
    ext: HOST_WINNER_ACTIVE_EXT,
  });
  // ORG_NO_CLAIM gets NO claim row at any scope — deliberately seeded nowhere.
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

    // -----------------------------------------------------------------------
    // RUNG 7 — cinatra#3603: the READ side admits what the WRITE side admits.
    //
    // The class: a CLAIM-BACKED, HOST-REGISTERED artifact type (no
    // `isArtifact`, registered by the host, claimed by a package whose name is
    // not the type's namespace). The writer admits it because the org's WINNING
    // claim for it is artifact-safe and the type is registered in this process;
    // the reader used to test a different list — `listArtifacts()` — that such
    // a type can never be on, so every read answered "does not resolve".
    // The four cases below pin the new source AND its bounds.
    // -----------------------------------------------------------------------
    it("cinatra#3603: a claim-backed HOST-REGISTERED type reads back its real bytes through readArtifactRepresentationText", async () => {
      const body = "# LinkedIn draft\n\nthe text an agent must read back.\n";
      const produced = await produceHostShaped({
        orgId: ORG,
        objectType: HOST_TYPE,
        body,
      });
      const content = await extReadMod.readArtifactRepresentationText({
        orgId: ORG,
        artifactId: produced.artifactId,
        representationRevisionId: produced.representationRevisionId,
      });
      expect(content.text).toBe(body);
      expect(content.mime).toBe("text/markdown");
    });

    it("cinatra#3603: the SAME host-shaped type on an organisation that holds NO claim stays REFUSED", async () => {
      const produced = await produceHostShaped({
        orgId: ORG_NO_CLAIM,
        objectType: HOST_TYPE,
        body: "# Unclaimed\n",
      });
      await expect(
        extReadMod.readArtifactRepresentationText({
          orgId: ORG_NO_CLAIM,
          artifactId: produced.artifactId,
          representationRevisionId: produced.representationRevisionId,
        }),
      ).rejects.toThrow(/does not resolve/);
    });

    it("cinatra#3603: a host-shaped type whose WINNING claim projects 'none' stays REFUSED", () => {
      const row = seedWriterAuthoredClaimedRow({
        orgId: ORG,
        type: HOST_NONE_TYPE,
        ext: HOST_NONE_EXT,
      });
      expect(
        readMod.resolveArtifactVersionForServe({
          orgId: ORG,
          artifactId: row.objectId,
          representationRevisionId: row.repId,
          liveOnly: true,
        }),
      ).toBeNull();
    });

    it("cinatra#3603: admission follows the WINNING claim — a retired claim by another package does not decide it", async () => {
      const body = "# Docs page\n\nwritten under the active winner.\n";
      const produced = await produceHostShaped({
        orgId: ORG,
        objectType: HOST_WINNER_TYPE,
        body,
      });
      const content = await extReadMod.readArtifactRepresentationText({
        orgId: ORG,
        artifactId: produced.artifactId,
        representationRevisionId: produced.representationRevisionId,
      });
      expect(content.text).toBe(body);
      expect(content.mime).toBe("text/markdown");
    });
  },
);
