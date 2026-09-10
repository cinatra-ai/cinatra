/**
 * cinatra#3032 (epic #3023, lifecycle-c W8) — THE IMAGE TOOL, against a REAL
 * Postgres and a REAL disk.
 *
 * These are acceptance items 1, 2 and 6, and only a database and a filesystem
 * together can prove them:
 *
 *   1. "A fixture agent makes a picture filed under its declared extension with
 *      its data." — a real objects row of the extension's OWN declared type,
 *      carrying the data the caller named, validated against that type's real
 *      schema; real bytes on disk that are the bytes the provider produced; a
 *      real finalized ledger row carrying the prompt, the provider and the
 *      model of that write.
 *   2. "A regeneration appends a revision to the same picture." — against the
 *      REAL unique index on (organisation, artifact, revision): the same
 *      artifact id gains revision 2, the projection follows it, the second
 *      write's own ledger row carries the SECOND prompt, and a base another
 *      write has already built on is refused.
 *   6. "Every mutation above is proved on the real surface, never on a stub."
 *
 * NOT A STUB ANYWHERE THAT MATTERS. The write, the ledger, the compare-and-set,
 * the type resolution, the schema validation, the ownership derivation and the
 * blob store are all the production ones. TWO seams are supplied, for the same
 * reasons the sibling suites supply them: the run package's registry read (a
 * Verdaccio round trip is not what these items are about), and the image
 * provider itself — a real provider call would prove a provider, not this road,
 * and this host holds no provider credential by design.
 *
 * ISOLATION (the #1868 / #3026 / #3030 pattern): a fresh schema per file from
 * the CANONICAL `buildCreateStoreSchemaQueries` DDL; the artifact blob root is a
 * temp dir; every app module is dynamically imported in `beforeAll` after the
 * env is set, because `postgresSchema` is a module-load const.
 */
import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

import { vi } from "vitest";

// PARTIAL mock, the #3030 posture: only the schema/connection the throwaway
// schema needs and the metadata reads the data root consults are substituted;
// everything else in the write path stays real.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  return {
    ...actual,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// This suite registers the exact types it needs directly; the app-boot registrar
// must not clobber them.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The meaning matcher is a post-commit best-effort enqueue onto a queue this
// tier does not run; a filed picture must not depend on it either way.
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: async () => {},
}));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

// THE LOUD FAILURE AT MODULE SCOPE (the #3030 rule): a tier whose only failure
// mode is "skipped" reports success by doing nothing.
if (process.env.CINATRA_LIFECYCLE_C_W8_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: " +
      "set SUPABASE_DB_URL to a scratch database. It builds and drops its own " +
      "schema, so any throwaway database will do.",
  );
}

const TEST_SCHEMA = "cinatra_test_w8_image_tool_3032";
const ORG = "org-3032";
const TEMPLATE = "tpl-3032";

/** The fixture agent's declared picture kind, and its own declared type. */
const PICTURE_EXT = "@cinatra-ai/picture-artifact";
const PICTURE_TYPE = "@cinatra-ai/picture-artifact:picture";
/** A SECOND declared kind, so "its declared extension" is a choice the call
 *  makes and not the only option available. */
const NOTE_EXT = "@cinatra-ai/note-artifact";
const NOTE_TYPE = "@cinatra-ai/note-artifact:note";

/** Two real 1x1 PNGs — different bytes, so a regeneration is a different
 *  picture and not a de-duplicated re-drive of the first. */
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let BLOB_ROOT = "";

let runPostgresQueriesAsync: typeof import("@/lib/postgres-async").runPostgresQueriesAsync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let tool: typeof import("@/lib/artifact-image-tool");

const S = () => TEST_SCHEMA;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res;
}

/** An ACTIVE dedicated claim over `type` for the org — what makes the
 *  extension's declared type an artifact-safe target for this organisation. */
async function seedClaim(type: string, ext: string) {
  await sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [nextId("claim"), `org:${ORG}`, type, ext, JSON.stringify({ projection: "artifact-safe" })],
  );
}

/**
 * The picture type's REAL schema: it declares fields of its own — the post the
 * picture belongs to and its placement on that post — so "with its data" is a
 * fact the type enforces, not a field this suite asserts about itself. The note
 * type declares none, so the two together prove the typed data is checked
 * against the type the call resolves to.
 */
function registerPictureType() {
  objectTypeRegistry.register(
    {
      type: PICTURE_TYPE,
      category: "report",
      schema: z.object({
        post: z.string().min(1),
        placement: z.enum(["featured", "body"]),
      }),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["image/png"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    PICTURE_EXT,
  );
}

function registerNoteType() {
  objectTypeRegistry.register(
    {
      type: NOTE_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    NOTE_EXT,
  );
}

/** The provider seam: a named provider that answers with the picture asked of
 *  it, and records every prompt it was given. */
function providerServing(images: string[]) {
  const prompts: string[] = [];
  let n = 0;
  return {
    prompts,
    deps: (over: Partial<import("@/lib/artifact-image-tool").ArtifactImageToolDeps> = {}) => ({
      ...tool.artifactImageToolDeps(),
      resolveImageProvider: async () => ({
        provider: "test-image-provider",
        generateImage: async (call: { prompt: string }) => {
          prompts.push(call.prompt);
          const data = images[Math.min(n, images.length - 1)];
          n += 1;
          return { imageData: data, mimeType: "image/png", model: "test-image-model-1" };
        },
      }),
      // The run package's declared production, in the shape the registry loader
      // returns it.
      loadProducesRefs: async () => [
        { extension: PICTURE_EXT, objectTypeId: PICTURE_TYPE },
        { extension: NOTE_EXT, objectTypeId: NOTE_TYPE },
      ],
      ...over,
    }),
  };
}

async function seedRun(runId: string) {
  await sql(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, org_id, run_by, status, input_params)
       VALUES ($1, $2, $3, $4, 'running', '{}')`,
    [runId, TEMPLATE, ORG, "user-3032"],
  );
}

async function ledgerRow(runId: string, outputId: string) {
  const res = await sql(
    `SELECT path, extension, phase, artifact_id, representation_revision_id,
            image_prompt, image_provider, image_model
       FROM "${S()}"."artifact_materializations" WHERE run_id=$1 AND output_id=$2`,
    [runId, outputId],
  );
  return (res.rows[0] ?? null) as null | {
    path: string;
    extension: string;
    phase: string;
    artifact_id: string;
    representation_revision_id: string;
    image_prompt: string | null;
    image_provider: string | null;
    image_model: string | null;
  };
}

async function objectRow(artifactId: string) {
  const res = await sql(
    `SELECT type, data FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`,
    [artifactId, ORG],
  );
  return (res.rows[0] ?? null) as null | { type: string; data: Record<string, unknown> };
}

async function artifactBytes(artifactId: string, revision?: number): Promise<Buffer> {
  const res = await sql(
    `SELECT b.storage_key FROM "${S()}"."representation" r
       JOIN "${S()}"."resource" res ON res.id = r.resource_id AND res.org_id = r.org_id
       JOIN "${S()}"."artifact_blobs" b ON b.storage_key = res.metadata->>'storageKey'
      WHERE r.org_id=$1 AND r.artifact_id=$2
        ${revision === undefined ? "" : "AND r.revision = " + String(revision)}
      ORDER BY r.revision DESC LIMIT 1`,
    [ORG, artifactId],
  );
  const key = res.rows[0]?.storage_key as string | undefined;
  if (!key) return Buffer.alloc(0);
  return await fsp.readFile(path.join(BLOB_ROOT, key));
}

async function revisionCount(artifactId: string): Promise<number> {
  const res = await sql(
    `SELECT count(*)::int AS n FROM "${S()}"."representation" WHERE org_id=$1 AND artifact_id=$2`,
    [ORG, artifactId],
  );
  return Number((res.rows[0] as { n: number }).n);
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  BLOB_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3032-blobs-"));
  process.env.CINATRA_ARTIFACT_DATA_ROOT = BLOB_ROOT;

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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  ({ runPostgresQueriesAsync } = await import("@/lib/postgres-async"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  tool = await import("@/lib/artifact-image-tool");

  objectTypeRegistry._clearForTests();
  registerPictureType();
  registerNoteType();
  await seedClaim(PICTURE_TYPE, PICTURE_EXT);
  await seedClaim(NOTE_TYPE, NOTE_EXT);
  await sql(
    `INSERT INTO "${S()}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, status,
        package_name, package_version, owner_level, owner_id)
     VALUES ($1, $2, 'w8 picture fixture', 'n/a', '{}', '{}', 'auto', 'active',
             $3, '1.0.0', 'organization', $2)`,
    [TEMPLATE, ORG, "@cinatra-ai/picture-fixture-agent"],
  );
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  if (BLOB_ROOT) rmSync(BLOB_ROOT, { recursive: true, force: true });
  delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 1 — a fixture agent makes a picture filed under its declared extension with its data",
  () => {
    it("files the picture as the extension's own declared type, carrying its data, with the prompt, the provider and the model on the ledger row", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const provider = providerServing([PNG_RED]);

      const outcome = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "The lighthouse",
          prompt: "a lighthouse at dusk",
          data: { post: "post-artifact-1", placement: "featured" },
        },
        provider.deps(),
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(outcome.error);
      expect(outcome.revision).toBe(1);
      expect(outcome.provider).toBe("test-image-provider");
      expect(outcome.model).toBe("test-image-model-1");
      expect(outcome.mime).toBe("image/png");
      expect(provider.prompts).toEqual(["a lighthouse at dusk"]);

      // FILED UNDER ITS DECLARED EXTENSION: the row is the picture extension's
      // own declared type, not the other declared kind and not a fallback.
      const row = await objectRow(outcome.artifactId);
      expect(row?.type).toBe(PICTURE_TYPE);
      // WITH ITS DATA: the fields the caller named are on the object, beside the
      // envelope the writer owns.
      expect(row?.data.post).toBe("post-artifact-1");
      expect(row?.data.placement).toBe("featured");
      expect(row?.data.mime).toBe("image/png");
      expect(row?.data.latestRepresentationRevisionId).toBe(
        outcome.representationRevisionId,
      );

      // The bytes on disk are the bytes the provider produced.
      expect((await artifactBytes(outcome.artifactId)).toString("base64")).toBe(PNG_RED);

      // ONE WRITE WITH A LEDGER ROW, carrying what made the picture.
      const ledger = await ledgerRow(runId, "picture-node");
      expect(ledger?.path).toBe("materialize_tool");
      expect(ledger?.phase).toBe("finalized");
      expect(ledger?.extension).toBe(PICTURE_EXT);
      expect(ledger?.artifact_id).toBe(outcome.artifactId);
      expect(ledger?.image_prompt).toBe("a lighthouse at dusk");
      expect(ledger?.image_provider).toBe("test-image-provider");
      expect(ledger?.image_model).toBe("test-image-model-1");
    });

    it("refuses data the picture type's own schema rejects, and writes nothing", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const provider = providerServing([PNG_RED]);

      const outcome = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "The lighthouse",
          prompt: "a lighthouse at dusk",
          // `placement` is not one the type declares.
          data: { post: "post-artifact-1", placement: "sidebar" },
        },
        provider.deps(),
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("data_rejected");
      expect(outcome.error).toMatch(/does not satisfy the declared schema/);
      // Nothing was filed, and the ledger carries no finalized row for it.
      const ledger = await ledgerRow(runId, "picture-node");
      expect(ledger?.phase).not.toBe("finalized");
    });

    it("refuses a picture whose form the declared type does not accept", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const provider = providerServing([PNG_RED]);
      const outcome = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "note-node",
          // The note kind is declared production, and accepts markdown only.
          extension: NOTE_EXT,
          title: "Not a picture's home",
          prompt: "a lighthouse at dusk",
        },
        provider.deps(),
      );
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("write_refused");
      expect(outcome.error).toMatch(/accepts \[text\/markdown\]/);
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 2 — a regeneration appends a revision to the same picture",
  () => {
    it("appends revision 2 to the SAME picture, moves the projection, and records the SECOND prompt on that write's own ledger row", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const provider = providerServing([PNG_RED, PNG_BLUE]);
      const first = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "The lighthouse",
          prompt: "a lighthouse at dusk",
          data: { post: "post-artifact-1", placement: "featured" },
        },
        provider.deps(),
      );
      if (!first.ok) throw new Error(first.error);

      const again = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "",
          prompt: "the same lighthouse, at dawn",
          artifactId: first.artifactId,
          baseRepresentationRevisionId: first.representationRevisionId,
        },
        provider.deps(),
      );

      expect(again.ok).toBe(true);
      if (!again.ok) throw new Error(again.error);
      // THE SAME PICTURE, one revision later — not a second artifact.
      expect(again.artifactId).toBe(first.artifactId);
      expect(again.representationRevisionId).not.toBe(first.representationRevisionId);
      expect(again.revision).toBe(2);
      expect(await revisionCount(first.artifactId)).toBe(2);

      // The projection follows the revision it points at.
      const row = await objectRow(first.artifactId);
      expect(row?.data.latestRepresentationRevisionId).toBe(again.representationRevisionId);
      // The picture's own data survives the append untouched.
      expect(row?.data.post).toBe("post-artifact-1");
      expect(row?.data.placement).toBe("featured");

      // The new revision's bytes are the regenerated picture.
      expect((await artifactBytes(first.artifactId)).toString("base64")).toBe(PNG_BLUE);
      expect((await artifactBytes(first.artifactId, 1)).toString("base64")).toBe(PNG_RED);

      // THE REVISION'S OWN LEDGER ROW carries the prompt of THAT write — a
      // regenerated picture has a prompt of its own.
      const appendLedger = await ledgerRow(
        runId,
        `picture-node#append:${first.artifactId}@${first.representationRevisionId}`,
      );
      expect(appendLedger?.phase).toBe("finalized");
      expect(appendLedger?.image_prompt).toBe("the same lighthouse, at dawn");
      expect(appendLedger?.image_provider).toBe("test-image-provider");
      expect(appendLedger?.image_model).toBe("test-image-model-1");
      // The first write's row still carries the FIRST prompt.
      const createLedger = await ledgerRow(runId, "picture-node");
      expect(createLedger?.image_prompt).toBe("a lighthouse at dusk");
    });

    it("refuses a regeneration that names a base another write has already built on", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const provider = providerServing([PNG_RED, PNG_BLUE, PNG_RED]);
      const first = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "The lighthouse",
          prompt: "a lighthouse at dusk",
          data: { post: "post-artifact-1", placement: "featured" },
        },
        provider.deps(),
      );
      if (!first.ok) throw new Error(first.error);
      const winner = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "picture-node",
          extension: PICTURE_EXT,
          title: "",
          prompt: "at dawn",
          artifactId: first.artifactId,
          baseRepresentationRevisionId: first.representationRevisionId,
        },
        provider.deps(),
      );
      expect(winner.ok).toBe(true);

      const loser = await tool.generateArtifactImage(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3032",
          nodeId: "other-node",
          extension: PICTURE_EXT,
          title: "",
          prompt: "at noon",
          artifactId: first.artifactId,
          // The revision the FIRST write produced — which the winner has
          // already built on.
          baseRepresentationRevisionId: first.representationRevisionId,
        },
        provider.deps(),
      );
      expect(loser.ok).toBe(false);
      if (loser.ok) throw new Error("unreachable");
      expect(loser.reason).toBe("stale_base");
      // The refusal left the picture at two revisions.
      expect(await revisionCount(first.artifactId)).toBe(2);
    });
  },
);
