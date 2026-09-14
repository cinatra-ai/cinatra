/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — THE RUN FOLDER'S PICKUP, THE FILE
 * BINDINGS, THE FILE FAN-OUT AND THE MID-RUN REVISION, against a REAL Postgres
 * and a REAL disk.
 *
 * These are acceptance items 1, 2, 3 and 4, and only a database and a
 * filesystem together can prove them:
 *
 *   1. "A fixture agent's file in its run folder's outputs becomes an artifact
 *      by the default road."  — real bytes on disk, the real detection ladder,
 *      the real one write path, a real `default_road` ledger row under the
 *      reserved file id.
 *   2. "A bound file lands under its declared extension." — the binding's own
 *      extension decides the target, not the ladder's base.
 *   3. "A list output fans out to one artifact per member with the first line
 *      as the title." — proved HERE for the FILE half of item 0.27 (one
 *      artifact per matching file, each titled from its own first line, with
 *      positional member identities). The LIST half already landed on main with
 *      cinatra#3034 and keeps its own proofs in
 *      `run-artifact-materializer.test.ts`; this slice does not re-do it.
 *   4. "A mid-run revision append refuses a stale base." — against the REAL
 *      unique index on (organisation, artifact, revision): the winner lands
 *      revision 2, the loser naming revision 1 is refused `stale_base`, and no
 *      ledger row and no produced event survive the refusal.
 *
 * NOT A STUB ANYWHERE THAT MATTERS. The pickup is driven through
 * `defaultRoadPickupDeps` — the SAME target resolution, write path, ownership
 * derivation and run-folder reader the product wires at boot. Only the run
 * package's registry read is supplied directly (a Verdaccio round trip is not
 * what these items are about), so `producesRefs` and the file bindings are
 * handed in the shape that loader returns.
 *
 * ISOLATION (the #1868 / #3026 pattern): a fresh schema per file from the
 * CANONICAL `buildCreateStoreSchemaQueries` DDL; the artifact blob root and the
 * run data root are temp dirs; every app module is dynamically imported in
 * `beforeAll` after the env is set, because `postgresSchema` is a module-load
 * const.
 */
import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// PARTIAL mock: the real write path reaches modules whose own module-load work
// reads connector configuration, so a narrow replacement of `@/lib/database`
// would break the import graph long before this suite's subject. Only the four
// things this tier must control are substituted — the schema/connection the
// throwaway schema needs, and the metadata reads the two data roots consult
// (both roots are pinned by env here) — and everything else stays real.
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

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

// THE LOUD FAILURE AT MODULE SCOPE, not in a hook: `describe.skipIf` skips every
// suite in the file, and a file with nothing left to run never runs its
// file-level hooks — a tier whose only failure mode is "skipped" reports success
// by doing nothing.
if (process.env.CINATRA_LIFECYCLE_C_W6_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: " +
      "set SUPABASE_DB_URL to a scratch database. It builds and drops its own " +
      "schema, so any throwaway database will do.",
  );
}

const TEST_SCHEMA = "cinatra_test_w6_run_folder_3030";
const ORG = "org-3030";
const TEMPLATE = "tpl-3030";

/** The agent's declared kind — one `produces` ref, so it is THE declared kind. */
const NOTE_EXT = "@cinatra-ai/note-artifact";
const NOTE_TYPE = "@cinatra-ai/note-artifact:note";
/** A SECOND extension a binding can name, so "its declared extension" is a
 *  choice the binding makes and not the only option available. */
const BRIEF_EXT = "@cinatra-ai/brief-artifact";
const BRIEF_TYPE = "@cinatra-ai/brief-artifact:brief";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let RUN_ROOT = "";
let BLOB_ROOT = "";

let runPostgresQueriesAsync: typeof import("@/lib/postgres-async").runPostgresQueriesAsync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let folder: typeof import("@/lib/artifacts/run-folder");
let retention: typeof import("@/lib/artifacts/run-folder-retention");
let pickup: typeof import("@/lib/artifacts/default-road-pickup");
let pickupRun: typeof import("@/lib/artifacts/default-road-pickup-run");
let appendMod: typeof import("@/lib/artifacts/artifact-revision-append");
let repMod: typeof import("@/lib/artifacts/representation-store");

const S = () => TEST_SCHEMA;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res;
}

/** An ACTIVE dedicated claim over `type` for the org — what makes the extension's
 *  declared type an artifact-safe target for this organisation. */
async function seedClaim(type: string, ext: string) {
  await sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [nextId("claim"), `org:${ORG}`, type, ext, JSON.stringify({ projection: "artifact-safe" })],
  );
}

function registerType(type: string, ext: string, mimeTypes: string[]) {
  objectTypeRegistry.register(
    {
      type,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    ext,
  );
}

/** Bytes at or above the document floor — below it, nothing takes the road. */
const bulk = (seed: string) => seed.repeat(Math.ceil(1400 / seed.length));

const MARKDOWN_NOTE = `# Field notes\n\n${bulk("- an observation about the run\n")}`;
const CHAPTER_ONE = `# Chapter one\n\n${bulk("The first chapter's body text.\n")}`;
const CHAPTER_TWO = `# Chapter two\n\n${bulk("The second chapter's body text.\n")}`;
const BRIEF = `# The brief\n\n${bulk("What the brief asks for.\n")}`;

/** Stage one file in a run's outputs folder. */
async function stage(runId: string, relPath: string, text: string) {
  await folder.writeRunOutputFile({
    orgId: ORG,
    runId,
    relPath,
    bytes: new TextEncoder().encode(text),
  });
}

/** Drive the pickup for one run through the PRODUCTION seams. */
async function pickUp(input: {
  runId: string;
  fileBindings?: import("@/lib/artifacts/default-road-pickup").RunFileBinding[];
  endNodeOutputs?: Record<string, unknown> | null;
}) {
  const files = await folder.listRunOutputFiles({ orgId: ORG, runId: input.runId });
  return pickup.pickUpDefaultRoadOutputs(
    {
      runId: input.runId,
      orgId: ORG,
      templateId: TEMPLATE,
      packageVersion: "1.0.0",
      createdBy: "user-3030",
      endNodeOutputs: input.endNodeOutputs ?? null,
      boundOutputIds: [],
      // The fixture agent declares exactly one produced kind, so it IS its
      // declared kind — the first rung of the default road's target ladder.
      declaredKindExtension: NOTE_EXT,
      runFiles: files.map((f) => ({ relPath: f.relPath, byteLength: f.byteLength })),
      fileBindings: input.fileBindings ?? [],
    },
    {
      ...pickupRun.defaultRoadPickupDeps({ orgId: ORG, runId: input.runId }),
      // The model rung is never reachable in a test: a road that asked a model
      // would prove a model's opinion, not this road's.
      ladder: { modelRungEnabled: () => false },
    },
  );
}

async function ledgerRow(runId: string, outputId: string) {
  const res = await sql(
    `SELECT path, extension, phase, artifact_id, representation_revision_id, detection_rung
       FROM "${S()}"."artifact_materializations" WHERE run_id=$1 AND output_id=$2`,
    [runId, outputId],
  );
  return (res.rows[0] ?? null) as null | {
    path: string;
    extension: string;
    phase: string;
    artifact_id: string;
    representation_revision_id: string;
    detection_rung: string | null;
  };
}

async function artifactText(artifactId: string): Promise<string> {
  const res = await sql(
    `SELECT b.storage_key FROM "${S()}"."representation" r
       JOIN "${S()}"."resource" res ON res.id = r.resource_id AND res.org_id = r.org_id
       JOIN "${S()}"."artifact_blobs" b ON b.storage_key = res.metadata->>'storageKey'
      WHERE r.org_id=$1 AND r.artifact_id=$2 ORDER BY r.revision DESC LIMIT 1`,
    [ORG, artifactId],
  );
  const key = res.rows[0]?.storage_key as string | undefined;
  if (!key) return "";
  return await fsp.readFile(path.join(BLOB_ROOT, key), "utf8");
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  BLOB_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3030-blobs-"));
  RUN_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3030-runs-"));
  process.env.CINATRA_ARTIFACT_DATA_ROOT = BLOB_ROOT;
  process.env.CINATRA_RUN_DATA_ROOT = RUN_ROOT;

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
  folder = await import("@/lib/artifacts/run-folder");
  retention = await import("@/lib/artifacts/run-folder-retention");
  pickup = await import("@/lib/artifacts/default-road-pickup");
  pickupRun = await import("@/lib/artifacts/default-road-pickup-run");
  appendMod = await import("@/lib/artifacts/artifact-revision-append");
  repMod = await import("@/lib/artifacts/representation-store");

  objectTypeRegistry._clearForTests();
  registerType(NOTE_TYPE, NOTE_EXT, ["text/markdown", "text/plain"]);
  registerType(BRIEF_TYPE, BRIEF_EXT, ["text/markdown", "text/plain"]);
  await seedClaim(NOTE_TYPE, NOTE_EXT);
  await seedClaim(BRIEF_TYPE, BRIEF_EXT);
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  for (const root of [BLOB_ROOT, RUN_ROOT]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
  delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
  delete process.env.CINATRA_RUN_DATA_ROOT;
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 1 — a file in the run folder's outputs becomes an artifact by the default road",
  () => {
    it("writes the artifact, a default_road ledger row under the reserved file id, and the receipt", async () => {
      const runId = nextId("run");
      await stage(runId, "notes.md", MARKDOWN_NOTE);

      const outcomes = await pickUp({ runId });
      expect(outcomes).toHaveLength(1);
      const [outcome] = outcomes;
      expect(outcome.ok).toBe(true);
      expect(outcome.source).toBe("file");
      expect(outcome.relPath).toBe("notes.md");
      expect(outcome.ledgerOutputId).toBe("cinatra:run-file:notes.md");
      expect(outcome.artifactId).toBeTruthy();

      // The ROW the write claimed, on the real ledger, on the DEFAULT road.
      const row = await ledgerRow(runId, "cinatra:run-file:notes.md");
      expect(row).not.toBeNull();
      expect(row!.path).toBe("default_road");
      expect(row!.phase).toBe("finalized");
      expect(row!.extension).toBe(NOTE_EXT);
      expect(row!.detection_rung).toBeTruthy();

      // The BYTES the agent wrote, round-tripped through the real blob store.
      expect(await artifactText(outcome.artifactId!)).toBe(MARKDOWN_NOTE);

      // The reserved id cannot collide with a node id or an output name.
      expect(pickup.runFileLedgerOutputId("notes.md")).toContain(":");

      // THE RECEIPT the retention tier reads (item 0.21) — written because the
      // pickup READ the folder, and the folder is left in place.
      const receipt = await folder.readRunFolderPickup(folder.runFolderPath(ORG, runId));
      expect(receipt?.files).toBe(1);
      expect(await folder.listRunOutputFiles({ orgId: ORG, runId })).toHaveLength(1);
    });

    it("records a file that is not UTF-8 text as a refusal rather than storing bytes nobody wrote", async () => {
      const runId = nextId("run");
      // A PNG signature followed by bytes no UTF-8 decoder can carry.
      await folder.writeRunOutputFile({
        orgId: ORG,
        runId,
        relPath: "picture.png",
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xfd]),
      });
      const [outcome] = await pickUp({ runId });
      expect(outcome.ok).toBe(false);
      expect(outcome.skipped).toBe("not_utf8");
      expect(await ledgerRow(runId, "cinatra:run-file:picture.png")).toBeNull();
    });

    it("records a file that is gone by the time the pickup reads as a verdict, never a failure", async () => {
      const runId = nextId("run");
      await stage(runId, "vanishing.md", MARKDOWN_NOTE);
      const files = await folder.listRunOutputFiles({ orgId: ORG, runId });
      await fsp.rm(files[0].absPath, { force: true });
      const outcomes = await pickup.pickUpDefaultRoadOutputs(
        {
          runId,
          orgId: ORG,
          templateId: TEMPLATE,
          packageVersion: "1.0.0",
          createdBy: "user-3030",
          endNodeOutputs: null,
          boundOutputIds: [],
          declaredKindExtension: NOTE_EXT,
          runFiles: files.map((f) => ({ relPath: f.relPath, byteLength: f.byteLength })),
        },
        {
          ...pickupRun.defaultRoadPickupDeps({ orgId: ORG, runId }),
          ladder: { modelRungEnabled: () => false },
        },
      );
      expect(outcomes[0].ok).toBe(false);
      expect(outcomes[0].skipped).toBe("file_missing");
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 2 — a bound file lands under its declared extension",
  () => {
    it("takes the binding's extension, not the agent's declared kind, and rides the end_node_binding path", async () => {
      const runId = nextId("run");
      await stage(runId, "brief.md", BRIEF);

      const [outcome] = await pickUp({
        runId,
        fileBindings: [
          {
            outputId: "brief",
            nodeId: "EndNode",
            // The binding names the OTHER extension on purpose: the agent's
            // declared kind is NOTE_EXT, so a file landing under BRIEF_EXT can
            // only be the binding's doing.
            extension: BRIEF_EXT,
            declaredMime: "text/markdown",
            fileFrom: "brief.md",
          },
        ],
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.extension).toBe(BRIEF_EXT);
      const row = await ledgerRow(runId, "brief");
      expect(row).not.toBeNull();
      expect(row!.path).toBe("end_node_binding");
      expect(row!.extension).toBe(BRIEF_EXT);

      const objects = await sql(
        `SELECT type FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`,
        [outcome.artifactId, ORG],
      );
      expect(objects.rows[0]?.type).toBe(BRIEF_TYPE);
    });

    it("refuses a form the bound extension does not accept, and writes nothing", async () => {
      const runId = nextId("run");
      await stage(runId, "brief.md", BRIEF);
      const [outcome] = await pickUp({
        runId,
        fileBindings: [
          {
            outputId: "brief",
            nodeId: "EndNode",
            extension: BRIEF_EXT,
            declaredMime: "application/pdf",
            fileFrom: "brief.md",
          },
        ],
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/does not accept/);
      expect(await ledgerRow(runId, "brief")).toBeNull();
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 3 — the fan-out: one artifact per matching file, titled from its own first line",
  () => {
    it("writes one artifact per match, with positional member identities and each file's first line as the title", async () => {
      const runId = nextId("run");
      await stage(runId, "chapters/one.md", CHAPTER_ONE);
      await stage(runId, "chapters/two.md", CHAPTER_TWO);
      await stage(runId, "notes.md", MARKDOWN_NOTE);

      const outcomes = await pickUp({
        runId,
        fileBindings: [
          {
            outputId: "chapters",
            nodeId: "EndNode",
            extension: BRIEF_EXT,
            declaredMime: "text/markdown",
            filePattern: "chapters/*.md",
            titleFromFirstLine: true,
          },
        ],
      });

      const fanned = outcomes.filter((o) => o.relPath?.startsWith("chapters/"));
      expect(fanned).toHaveLength(2);
      expect(fanned.every((o) => o.ok)).toBe(true);
      // Two artifacts, never one merged row.
      expect(new Set(fanned.map((o) => o.artifactId)).size).toBe(2);
      // The ledger identity is the list output's id with the member's position
      // — the shape the ledger already reserves for a fanned-out member.
      expect(await ledgerRow(runId, "chapters[0]")).not.toBeNull();
      expect(await ledgerRow(runId, "chapters[1]")).not.toBeNull();

      const titles = await sql(
        `SELECT o.data->>'title' AS title FROM "${S()}"."objects" o
          WHERE o.org_id=$1 AND o.id = ANY($2::text[]) ORDER BY o.data->>'title'`,
        [ORG, fanned.map((o) => o.artifactId)],
      );
      expect(titles.rows.map((r) => r.title)).toEqual(["# Chapter one", "# Chapter two"]);

      // The file the pattern did NOT match still took the default road.
      const unmatched = outcomes.find((o) => o.relPath === "notes.md");
      expect(unmatched?.ok).toBe(true);
      expect(unmatched?.ledgerOutputId).toBe("cinatra:run-file:notes.md");
    });

    it("writes two artifacts over one content-addressed resource when two members carry the same bytes", async () => {
      const runId = nextId("run");
      await stage(runId, "chapters/a.md", CHAPTER_ONE);
      await stage(runId, "chapters/b.md", CHAPTER_ONE);

      const outcomes = await pickUp({
        runId,
        fileBindings: [
          {
            outputId: "chapters",
            nodeId: "EndNode",
            extension: BRIEF_EXT,
            declaredMime: "text/markdown",
            filePattern: "chapters/*.md",
            titleFromFirstLine: true,
          },
        ],
      });
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((o) => o.ok)).toBe(true);
      // DUPLICATES ARE DELIBERATELY UNMERGED: two files the agent wrote are two
      // artifacts, over ONE content-addressed resource.
      expect(new Set(outcomes.map((o) => o.artifactId)).size).toBe(2);
      const resources = await sql(
        `SELECT DISTINCT r.resource_id FROM "${S()}"."representation" r
          WHERE r.org_id=$1 AND r.artifact_id = ANY($2::text[])`,
        [ORG, outcomes.map((o) => o.artifactId)],
      );
      expect(resources.rows).toHaveLength(1);
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 4 — a mid-run revision append refuses a stale base",
  () => {
    /** One artifact with ONE stored revision, written by the real road. */
    async function seedArtifact(): Promise<{ artifactId: string; revisionId: string }> {
      const runId = nextId("run");
      await stage(runId, "draft.md", MARKDOWN_NOTE);
      const [outcome] = await pickUp({ runId });
      expect(outcome.ok).toBe(true);
      return {
        artifactId: outcome.artifactId!,
        revisionId: outcome.representationRevisionId!,
      };
    }

    it("the winner lands revision 2 and the loser naming revision 1 is refused stale_base", async () => {
      const seeded = await seedArtifact();
      const runId = nextId("run");

      const winner = await appendMod.appendArtifactRevision({
        orgId: ORG,
        runId,
        nodeId: "AppendNodeA",
        artifactId: seeded.artifactId,
        baseRepresentationRevisionId: seeded.revisionId,
        content: `${MARKDOWN_NOTE}\n\nThe first appender's paragraph.\n`,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
      });
      expect(winner.ok).toBe(true);
      if (winner.ok) expect(winner.revision).toBe(2);

      const loser = await appendMod.appendArtifactRevision({
        orgId: ORG,
        runId,
        nodeId: "AppendNodeB",
        artifactId: seeded.artifactId,
        // The base the loser READ — already built on by the winner.
        baseRepresentationRevisionId: seeded.revisionId,
        content: `${MARKDOWN_NOTE}\n\nThe second appender's paragraph.\n`,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
      });
      expect(loser.ok).toBe(false);
      if (!loser.ok) expect(loser.reason).toBe("stale_base");

      // EXACTLY TWO revisions: the refusal wrote none.
      const revisions = repMod.listRepresentations(ORG, seeded.artifactId);
      expect(revisions.map((r) => r.revision)).toEqual([1, 2]);

      // NO LEDGER ROW and NO PRODUCED EVENT survive the refusal.
      expect(
        await ledgerRow(
          runId,
          appendMod.appendLedgerOutputId({
            nodeId: "AppendNodeB",
            artifactId: seeded.artifactId,
            baseRepresentationRevisionId: seeded.revisionId,
          }),
        ),
      ).toBeNull();
      const events = await sql(
        `SELECT emitter FROM "${S()}"."artifact_produced_outbox"
          WHERE org_id=$1 AND artifact_id=$2 AND emitter='artifact_revision_append'`,
        [ORG, seeded.artifactId],
      );
      expect(events.rows).toHaveLength(1);
    });

    it("refuses a base that is not a revision of this artifact in this organisation", async () => {
      const seeded = await seedArtifact();
      const refused = await appendMod.appendArtifactRevision({
        orgId: ORG,
        runId: nextId("run"),
        nodeId: "AppendNodeC",
        artifactId: seeded.artifactId,
        baseRepresentationRevisionId: nextId("not-a-revision"),
        content: MARKDOWN_NOTE,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
      });
      expect(refused).toMatchObject({ ok: false, reason: "unknown_base" });
    });

    it("refuses an artifact this organisation does not have", async () => {
      const refused = await appendMod.appendArtifactRevision({
        orgId: ORG,
        runId: nextId("run"),
        nodeId: "AppendNodeD",
        artifactId: nextId("no-such-artifact"),
        baseRepresentationRevisionId: nextId("rev"),
        content: MARKDOWN_NOTE,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
      });
      expect(refused).toMatchObject({ ok: false, reason: "artifact_not_found" });
    });

    it("records the run's declared gate as the review of the revision it appended", async () => {
      const seeded = await seedArtifact();
      const runId = nextId("run");
      const reviewTaskId = nextId("gate");
      const appended = await appendMod.appendArtifactRevision({
        orgId: ORG,
        runId,
        nodeId: "AppendNodeE",
        artifactId: seeded.artifactId,
        baseRepresentationRevisionId: seeded.revisionId,
        content: `${MARKDOWN_NOTE}\n\nA revision under a declared gate.\n`,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
        declaredReviewTaskId: reviewTaskId,
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      const satisfaction = await appendMod.readRevisionGateSatisfaction({
        orgId: ORG,
        artifactId: seeded.artifactId,
        representationRevisionId: appended.representationRevisionId,
      });
      expect(satisfaction).toMatchObject({ runId, reviewTaskId });
    });

    it("returns the same revision, without appending a second, when one node re-drives with the same bytes", async () => {
      const seeded = await seedArtifact();
      const runId = nextId("run");
      const args = {
        orgId: ORG,
        runId,
        nodeId: "AppendNodeF",
        artifactId: seeded.artifactId,
        baseRepresentationRevisionId: seeded.revisionId,
        content: `${MARKDOWN_NOTE}\n\nOnce.\n`,
        mime: "text/markdown",
        createdBy: "user-3030",
        extension: NOTE_EXT,
      };
      const first = await appendMod.appendArtifactRevision(args);
      const second = await appendMod.appendArtifactRevision(args);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(second.deduped).toBe(true);
        expect(second.representationRevisionId).toBe(first.representationRevisionId);
      }
      expect(repMod.listRepresentations(ORG, seeded.artifactId).map((r) => r.revision)).toEqual([
        1, 2,
      ]);
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 5 — the folder the pickup read is collected after the grace period",
  () => {
    it("is still there right after the pickup, and gone once the grace period has passed", async () => {
      const runId = nextId("run");
      await stage(runId, "notes.md", MARKDOWN_NOTE);
      await pickUp({ runId });

      const dir = folder.runFolderPath(ORG, runId);
      const receipt = await folder.readRunFolderPickup(dir);
      expect(receipt).not.toBeNull();

      const pickedUpAt = Date.parse(receipt!.pickedUpAt);
      const withinGrace = await retention.sweepRunFolders({
        root: RUN_ROOT,
        now: new Date(pickedUpAt + 60 * 60 * 1000),
      });
      expect(
        withinGrace.decisions.find((d) => d.runId === runId),
      ).toMatchObject({ reason: "within_grace", deleted: false });
      expect(await fsp.stat(dir).catch(() => null)).not.toBeNull();

      const pastGrace = await retention.sweepRunFolders({
        root: RUN_ROOT,
        now: new Date(pickedUpAt + 25 * 60 * 60 * 1000),
      });
      expect(pastGrace.decisions.find((d) => d.runId === runId)).toMatchObject({
        reason: "picked_up_past_grace",
        deleted: true,
      });
      expect(await fsp.stat(dir).catch(() => null)).toBeNull();
    });
  },
);

// ---------------------------------------------------------------------------
// THE CONVERGENCE ROUND (cinatra#3030). Each case below pins one finding of the
// read-only review of this delta, on the same real Postgres and real disk.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)("the convergence round's rules", () => {
  async function seedNote(): Promise<{ artifactId: string; revisionId: string }> {
    const runId = nextId("run");
    await stage(runId, "draft.md", MARKDOWN_NOTE);
    const [outcome] = await pickUp({ runId });
    expect(outcome.ok).toBe(true);
    return {
      artifactId: outcome.artifactId!,
      revisionId: outcome.representationRevisionId!,
    };
  }

  async function resourceCount(): Promise<number> {
    const res = await sql(`SELECT count(*)::int AS n FROM "${S()}"."resource" WHERE org_id=$1`, [
      ORG,
    ]);
    return Number(res.rows[0]?.n ?? 0);
  }

  it("honours a bound file's declared object type, and refuses the file rather than filing it as another type", async () => {
    const runId = nextId("run");
    await stage(runId, "brief.md", BRIEF);
    const [refused] = await pickUp({
      runId,
      fileBindings: [
        {
          outputId: "brief",
          nodeId: "EndNode",
          extension: BRIEF_EXT,
          objectTypeId: NOTE_TYPE,
          declaredMime: "text/markdown",
          fileFrom: "brief.md",
        },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/declares object type/);
    expect(await ledgerRow(runId, "brief")).toBeNull();

    const secondRun = nextId("run");
    await stage(secondRun, "brief.md", BRIEF);
    const [accepted] = await pickUp({
      runId: secondRun,
      fileBindings: [
        {
          outputId: "brief",
          nodeId: "EndNode",
          extension: BRIEF_EXT,
          objectTypeId: BRIEF_TYPE,
          declaredMime: "text/markdown",
          fileFrom: "brief.md",
        },
      ],
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.extension).toBe(BRIEF_EXT);
  });

  it("resolves the file bindings from the declaration the run EXECUTED, never from the package registry", async () => {
    // cinatra#3208's rule, applied to the file half: the template version this
    // run is pinned to carries the declaration its own compile found, and THAT
    // is what the pickup reads. The registry is unreachable in this suite, so a
    // read of it could only fail — which is exactly the point.
    const templateId = nextId("template");
    const declaration = JSON.stringify({
      v: 1,
      bindings: [
        {
          nodeId: "EndNode",
          outputId: "brief",
          binding: {
            extension: BRIEF_EXT,
            declaredMime: "text/markdown",
            fileFrom: "brief.md",
          },
        },
      ],
      producesRefs: [{ extension: BRIEF_EXT, objectTypeId: BRIEF_TYPE }],
    });
    await sql(
      `INSERT INTO "${S()}"."agent_templates"
   (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy,
    package_name, package_version, has_artifact_bindings, artifact_bindings)
 VALUES ($1,$2,'W6 fixture','n/a','{}','{}','none',$3,$4,true,$5)`,
      [templateId, ORG, "@cinatra-ai/w6-fixture-agent", "1.2.3", declaration],
    );

    const materializer = await import("@/lib/artifacts/run-artifact-materializer");
    const ctx = await materializer.loadRunDerivationContext({
      templateId,
      packageVersion: "1.2.3",
    });
    expect(ctx.bindings.map((b) => b.binding.fileFrom)).toEqual(["brief.md"]);
    expect(ctx.producesRefs).toEqual([{ extension: BRIEF_EXT, objectTypeId: BRIEF_TYPE }]);
  });

  it("revises BOTH artifacts when one node appends the same bytes to each", async () => {
    const first = await seedNote();
    const second = await seedNote();
    const runId = nextId("run");
    const addition = `${MARKDOWN_NOTE}\n\nThe same paragraph, twice over.\n`;

    const toFirst = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "AppendNodeSame",
      artifactId: first.artifactId,
      baseRepresentationRevisionId: first.revisionId,
      content: addition,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: NOTE_EXT,
    });
    const toSecond = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "AppendNodeSame",
      artifactId: second.artifactId,
      baseRepresentationRevisionId: second.revisionId,
      content: addition,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: NOTE_EXT,
    });

    expect(toFirst.ok).toBe(true);
    expect(toSecond.ok).toBe(true);
    if (!toFirst.ok || !toSecond.ok) return;
    // The second call revised the SECOND artifact — it did not read the first
    // write's refs back out of the ledger.
    expect(toSecond.artifactId).toBe(second.artifactId);
    expect(toSecond.representationRevisionId).not.toBe(toFirst.representationRevisionId);
    expect(repMod.listRepresentations(ORG, first.artifactId).map((r) => r.revision)).toEqual([
      1, 2,
    ]);
    expect(repMod.listRepresentations(ORG, second.artifactId).map((r) => r.revision)).toEqual([
      1, 2,
    ]);
  });

  it("leaves no resource row and no bytes behind when a base is refused", async () => {
    const seeded = await seedNote();
    const runId = nextId("run");
    const winner = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "AppendNodeWinner",
      artifactId: seeded.artifactId,
      baseRepresentationRevisionId: seeded.revisionId,
      content: `${MARKDOWN_NOTE}\n\nThe winner.\n`,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: NOTE_EXT,
    });
    expect(winner.ok).toBe(true);

    const before = await resourceCount();
    const loser = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "AppendNodeLoser",
      artifactId: seeded.artifactId,
      baseRepresentationRevisionId: seeded.revisionId,
      content: `${MARKDOWN_NOTE}\n\nThe loser's own bytes.\n`,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: NOTE_EXT,
    });
    expect(loser).toMatchObject({ ok: false, reason: "stale_base" });
    // The refusal staged a resource, a blob row and bytes before the
    // compare-and-set lost; none of them survive it.
    expect(await resourceCount()).toBe(before);
    const blobs = await sql(
      `SELECT count(*)::int AS n FROM "${S()}"."artifact_blobs" b
        WHERE b.org_id=$1
          AND NOT EXISTS (SELECT 1 FROM "${S()}"."resource" r
                           WHERE r.org_id=b.org_id AND r.metadata->>'blobId' = b.id)`,
      [ORG],
    );
    expect(Number(blobs.rows[0]?.n ?? 0)).toBe(0);
  });

  it("refuses an append whose caller was authorized for another object type", async () => {
    const seeded = await seedNote();
    const refused = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId: nextId("run"),
      nodeId: "AppendNodeWrongType",
      artifactId: seeded.artifactId,
      baseRepresentationRevisionId: seeded.revisionId,
      content: `${MARKDOWN_NOTE}\n\nA type this caller may not write.\n`,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: BRIEF_EXT,
      expectedObjectTypeId: BRIEF_TYPE,
    });
    expect(refused).toMatchObject({ ok: false, reason: "type_mismatch" });
    expect(repMod.listRepresentations(ORG, seeded.artifactId).map((r) => r.revision)).toEqual([1]);
  });

  it("answers a concurrent retry of the same append with the revision it landed, never a false stale base", async () => {
    const seeded = await seedNote();
    const runId = nextId("run");
    const args = {
      orgId: ORG,
      runId,
      nodeId: "AppendNodeRetry",
      artifactId: seeded.artifactId,
      baseRepresentationRevisionId: seeded.revisionId,
      content: `${MARKDOWN_NOTE}\n\nOne operation, driven twice at once.\n`,
      mime: "text/markdown",
      createdBy: "user-3030",
      extension: NOTE_EXT,
    };
    const [a, b] = await Promise.all([
      appendMod.appendArtifactRevision(args),
      appendMod.appendArtifactRevision(args),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.representationRevisionId).toBe(a.representationRevisionId);
    expect(repMod.listRepresentations(ORG, seeded.artifactId).map((r) => r.revision)).toEqual([
      1, 2,
    ]);
  });
});
