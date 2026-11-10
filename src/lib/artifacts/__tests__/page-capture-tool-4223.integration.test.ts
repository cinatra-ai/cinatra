/**
 * cinatra#4223: THE PAGE CAPTURE TOOL against a REAL Postgres and a REAL disk.
 *
 * What only a database can prove:
 *
 *   (i)   a capture of a page on the org's own connect-registered site files ONE
 *         artifact of the screenshot type, whose object data carries the three
 *         facts the display draws (`capturedUrl`, `viewport`, `capturedAt`),
 *         validated against the type's real declared schema, and whose revision
 *         carries the same facts as its record;
 *   (ii)  the finalized ledger row names the calling node as both its node and its
 *         output identity and carries no image provenance; the lease the capture
 *         took of the shared budget is released;
 *   (iii) a renderer viewport of width 0 is refused by that same schema as
 *         `data_rejected`, and nothing is filed;
 *   (iv)  a re-drive of the node with the same bytes answers the facts recorded
 *         with the first revision, not the re-drive's own time.
 *
 * WHAT IS REAL. The site registry read (`createPreviewCaptureDeps()
 * .listRegisteredSites` over a connect site minted by
 * `upsertConnectSiteAndMintCredential`), the capture entry point, the write
 * authorization, the ledger, the artifact write, the type's schema (the pack's own
 * `objectTypes` entry, registered through `registerParsedArtifactManifest`), the
 * budget, the facts record and its reader, the ownership derivation, the blob store.
 *
 * WHAT IS SUPPLIED. The guarded fetch and the isolated renderer (a real browser
 * subprocess proves a browser, not this road), a fixed clock, and the run package's
 * registry read.
 *
 * ISOLATION: the #3032 tier's own schema, dropped and rebuilt from the canonical DDL
 * in `beforeAll` and dropped in `afterAll`; the config runs its files serially.
 *
 *   SUPABASE_DB_URL=THE-SCRATCH-DSN pnpm test:lifecycle-c-w8
 */
import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerParsedArtifactManifest } from "@cinatra-ai/objects/register-artifact-extensions";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const H = vi.hoisted(() => {
  // The store resolves its schema ONCE, at module load, so the name is stated
  // before any import of this file can reach it.
  const schema = "cinatra_test_w8_image_tool_3032";
  process.env.SUPABASE_SCHEMA = schema;
  return { schema };
});

// PARTIAL mock, the #3030 / #3032 posture: only the schema/connection the
// throwaway schema needs and the metadata reads are substituted.
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
// This suite registers the one type it needs directly; the app-boot registrar must not clobber it.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The meaning matcher is a post-commit best-effort enqueue onto a queue this tier does not run.
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: async () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

// THE LOUD FAILURE AT MODULE SCOPE (the #3030 rule): a tier whose only failure
// mode is "skipped" reports success by doing nothing.
if (process.env.CINATRA_LIFECYCLE_C_W8_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: set SUPABASE_DB_URL to a " +
      "scratch database. It builds and drops its own schema, so any throwaway database will do.",
  );
}

const TEST_SCHEMA = H.schema;
const ORG = "org-4223";
const USER = "user-4223";
const TEMPLATE = "tpl-4223";
const SHOT_EXT = "@cinatra-ai/screenshot-artifact";
const SHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
/** The connect-registered site, on loopback. */
const SITE_ORIGIN = "http://localhost:4223";
const PAGE_URL = `${SITE_ORIGIN}/about/`;
const CLOCK = new Date("2026-10-17T16:30:00.000Z");
const LATER = new Date("2026-10-18T09:00:00.000Z");
const PAGE_HTML = "<html><body><h1>About</h1><p>Who we are.</p></body></html>";

/** Two real 1x1 PNGs (the #3032 suite's own). The refused capture renders the second. */
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

/** The pack's own `objectTypes[0]` entry, copied from `@cinatra-ai/screenshot-artifact` `src/index.ts` at c901c855. */
const SCREENSHOT_OBJECT_TYPE_ENTRY = {
  type: SHOT_TYPE,
  claim: "dedicated",
  dispositions: { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content", sensitivity: "normal" },
  schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      mime: { type: "string" },
      size: { type: "integer" },
      capturedUrl: { type: "string", format: "uri" },
      viewport: {
        type: "object",
        properties: { width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } },
        required: ["width", "height"],
        additionalProperties: false,
      },
      capturedAt: { type: "string", format: "date-time" },
      latestRepresentationRevisionId: { type: "string" },
      latestDigest: { type: "string" },
    },
    required: ["mime", "size"],
    additionalProperties: true,
  },
};

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;
let BLOB_ROOT = "";

let runPostgresQueriesAsync: typeof import("@/lib/postgres-async").runPostgresQueriesAsync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let tool: typeof import("@/lib/artifact-page-capture-tool");
let capture: typeof import("@/lib/artifacts/cms-preview-capture");
let pageCapture: typeof import("@/lib/artifacts/registered-page-capture");
let factsRecord: typeof import("@/lib/artifacts/page-capture-facts-record");

const S = () => TEST_SCHEMA;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res!;
}

async function seedRun(runId: string) {
  await sql(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, org_id, run_by, status, input_params)
       VALUES ($1, $2, $3, $4, 'running', '{}')`,
    [runId, TEMPLATE, ORG, USER],
  );
}

async function ledgerRow(runId: string, outputId: string) {
  const res = await sql(
    `SELECT node_id, output_id, path, extension, phase, artifact_id, representation_revision_id,
            image_prompt, image_provider, image_model
       FROM "${S()}"."artifact_materializations" WHERE run_id=$1 AND output_id=$2`,
    [runId, outputId],
  );
  return (res.rows[0] ?? null) as null | Record<string, string | null>;
}

async function objectRow(artifactId: string) {
  const res = await sql(`SELECT type, data FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`, [artifactId, ORG]);
  return (res.rows[0] ?? null) as null | { type: string; data: Record<string, unknown> };
}

async function screenshotCount(): Promise<number> {
  const res = await sql(`SELECT count(*)::int AS n FROM "${S()}"."objects" WHERE org_id=$1 AND type=$2`, [
    ORG,
    SHOT_TYPE,
  ]);
  return Number((res.rows[0] as { n: number }).n);
}

async function leases(runId: string) {
  const res = await sql(
    `SELECT released_at IS NOT NULL AS released FROM "${S()}"."page_capture_leases" WHERE org_id=$1 AND run_id=$2`,
    [ORG, runId],
  );
  return res.rows as Array<{ released: boolean }>;
}

async function artifactBytes(artifactId: string): Promise<Buffer> {
  const res = await sql(
    `SELECT b.storage_key FROM "${S()}"."representation" r
       JOIN "${S()}"."resource" res ON res.id = r.resource_id AND res.org_id = r.org_id
       JOIN "${S()}"."artifact_blobs" b ON b.storage_key = res.metadata->>'storageKey'
      WHERE r.org_id=$1 AND r.artifact_id=$2
      ORDER BY r.revision DESC LIMIT 1`,
    [ORG, artifactId],
  );
  const key = res.rows[0]?.storage_key as string | undefined;
  if (!key) return Buffer.alloc(0);
  return await fsp.readFile(path.join(BLOB_ROOT, key));
}

type Seen = {
  fetches: Array<{ url: string; headers: Record<string, string> }>;
  renders: Array<{ documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }>;
};

/** The REAL site registry read, a stubbed guarded fetch and renderer, and a fixed clock; every other seam is production. */
function captureDeps(viewport: { width: number; height: number }, png: string = PNG_RED, clock: Date = CLOCK) {
  const seen: Seen = { fetches: [], renders: [] };
  const seams: import("@/lib/artifacts/registered-page-capture").CaptureRegisteredPageDeps = {
    listRegisteredSites: capture.createPreviewCaptureDeps().listRegisteredSites,
    fetchPreview: async ({ url, headers }) => {
      seen.fetches.push({ url, headers });
      return { ok: true, html: PAGE_HTML, pinnedAddresses: ["::1"] };
    },
    renderIsolated: async ({ documentUrl, allowedOrigin, pinnedAddresses }) => {
      seen.renders.push({ documentUrl, allowedOrigin, pinnedAddresses: [...pinnedAddresses] });
      return {
        ok: true,
        screenshot: new Uint8Array(Buffer.from(png, "base64")),
        geometry: { regions: [], contentHeight: 900, viewport },
        network: { blockedRequests: 0, allowedRequests: 0 },
      };
    },
    now: () => clock,
  };
  const deps: import("@/lib/artifact-page-capture-tool").ArtifactPageCaptureToolDeps = {
    ...tool.artifactPageCaptureToolDeps(),
    // The run package's declared production, in the shape the registry loader returns it.
    loadProducesRefs: async () => [{ extension: SHOT_EXT, objectTypeId: SHOT_TYPE }],
    capturePage: (i) => pageCapture.captureRegisteredPage({ ...i, deps: seams }),
  };
  return { deps, seen };
}

function captureCall(runId: string, nodeId: string) {
  return {
    runId,
    orgId: ORG,
    templateId: TEMPLATE,
    packageVersion: "1.0.0",
    createdBy: USER,
    nodeId,
    extension: SHOT_EXT,
    title: "The about page",
    url: PAGE_URL,
  };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  BLOB_ROOT = mkdtempSync(path.join(tmpdir(), "cin-4223-blobs-"));
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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesAsync } = await import("@/lib/postgres-async"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  tool = await import("@/lib/artifact-page-capture-tool");
  capture = await import("@/lib/artifacts/cms-preview-capture");
  pageCapture = await import("@/lib/artifacts/registered-page-capture");
  factsRecord = await import("@/lib/artifacts/page-capture-facts-record");

  objectTypeRegistry._clearForTests();
  const registered = registerParsedArtifactManifest(
    {
      accepts: { file: { mimeTypes: ["image/png", "image/jpeg", "image/webp"] } },
      objectTypes: [SCREENSHOT_OBJECT_TYPE_ENTRY],
    } as never,
    SHOT_EXT,
  );
  if (!registered) throw new Error("the screenshot type did not register");
  await sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [nextId("claim"), `org:${ORG}`, SHOT_TYPE, SHOT_EXT, JSON.stringify({ projection: "artifact-safe" })],
  );
  await sql(
    `INSERT INTO "${S()}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, status,
        package_name, package_version, owner_level, owner_id)
     VALUES ($1, $2, '4223 page capture fixture', 'n/a', '{}', '{}', 'auto', 'active',
             $3, '1.0.0', 'organization', $2)`,
    [TEMPLATE, ORG, "@cinatra-ai/screenshot-fixture-agent"],
  );
  // THE ORG'S ACTIVE CONNECT SITE, minted through the production provisioning write.
  // The credential it returns is never read here.
  const { upsertConnectSiteAndMintCredential } = await import("@/lib/connect-provisioning");
  upsertConnectSiteAndMintCredential({
    client: "wordpress",
    widgetOrigin: SITE_ORIGIN,
    callbackOrigin: null,
    webhookSecretHash: null,
    adminUserId: null,
    orgId: ORG,
  });
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
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("cinatra#4223 a capture of a registered page files a screenshot carrying its three facts", () => {
  it("(i) files one artifact of the screenshot type whose object data and revision record carry where, at what viewport and when", async () => {
    const runId = nextId("run");
    await seedRun(runId);
    const before = await screenshotCount();
    const { deps, seen } = captureDeps({ width: 1280, height: 900 });

    const outcome = await tool.captureArtifactPage(captureCall(runId, "capture_page"), deps);

    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);
    expect(outcome).toMatchObject({
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: CLOCK.toISOString(),
      deduped: false,
    });
    // The real site read matched the page's origin: one fetch with no credential
    // headers, one render pinned to the guard's addresses and the site's origin.
    expect(seen.fetches).toEqual([{ url: PAGE_URL, headers: {} }]);
    expect(seen.renders).toEqual([{ documentUrl: PAGE_URL, allowedOrigin: SITE_ORIGIN, pinnedAddresses: ["::1"] }]);

    expect(await screenshotCount()).toBe(before + 1);
    const row = await objectRow(outcome.artifactId);
    expect(row?.type).toBe(SHOT_TYPE);
    expect(row?.data.capturedUrl).toBe(PAGE_URL);
    expect(row?.data.viewport).toEqual({ width: 1280, height: 900 });
    expect(row?.data.capturedAt).toBe(CLOCK.toISOString());
    expect(row?.data.mime).toBe("image/png");
    expect(row?.data.latestRepresentationRevisionId).toBe(outcome.representationRevisionId);
    expect((await artifactBytes(outcome.artifactId)).toString("base64")).toBe(PNG_RED);

    // The revision's own facts record, read by the production reader.
    expect(
      factsRecord.readPageCaptureFactsForRevision({
        orgId: ORG,
        artifactId: outcome.artifactId,
        representationRevisionId: outcome.representationRevisionId,
        objectType: SHOT_TYPE,
      }),
    ).toEqual({
      status: "recorded",
      facts: { capturedUrl: PAGE_URL, viewport: { width: 1280, height: 900 }, capturedAt: CLOCK.toISOString() },
    });
  });

  it("(ii) the finalized ledger row names the node as node and output, with no image provenance; the lease is released", async () => {
    const runId = nextId("run");
    await seedRun(runId);
    const { deps } = captureDeps({ width: 1280, height: 900 });

    const outcome = await tool.captureArtifactPage(captureCall(runId, "capture_home"), deps);
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);

    expect(await ledgerRow(runId, "capture_home")).toEqual({
      node_id: "capture_home",
      output_id: "capture_home",
      path: "materialize_tool",
      extension: SHOT_EXT,
      phase: "finalized",
      artifact_id: outcome.artifactId,
      representation_revision_id: outcome.representationRevisionId,
      image_prompt: null,
      image_provider: null,
      image_model: null,
    });
    expect(await leases(runId)).toEqual([{ released: true }]);
  });

  it("(iii) a renderer viewport of width 0 is refused by the declared schema as data_rejected, and nothing is filed", async () => {
    const runId = nextId("run");
    await seedRun(runId);
    const before = await screenshotCount();
    const { deps } = captureDeps({ width: 0, height: 900 }, PNG_BLUE);

    const outcome = await tool.captureArtifactPage(captureCall(runId, "capture_narrow"), deps);

    expect(outcome).toEqual({ ok: false, reason: "data_rejected", error: tool.PAGE_CAPTURE_DATA_REJECTED_ERROR });
    expect(await screenshotCount()).toBe(before);
    expect((await ledgerRow(runId, "capture_narrow"))?.phase).not.toBe("finalized");
    expect(await leases(runId)).toEqual([{ released: true }]);
  });

  it("(iv) a re-drive of the node with the same bytes answers the first revision's recorded facts", async () => {
    const runId = nextId("run");
    await seedRun(runId);
    const first = await tool.captureArtifactPage(
      captureCall(runId, "capture_again"),
      captureDeps({ width: 1280, height: 900 }).deps,
    );
    if (!first.ok) throw new Error(`${first.reason}: ${first.error}`);
    const before = await screenshotCount();

    const again = await tool.captureArtifactPage(
      captureCall(runId, "capture_again"),
      captureDeps({ width: 1280, height: 900 }, PNG_RED, LATER).deps,
    );

    expect(again).toEqual({
      ok: true,
      artifactId: first.artifactId,
      representationRevisionId: first.representationRevisionId,
      capturedUrl: PAGE_URL,
      viewport: { width: 1280, height: 900 },
      capturedAt: CLOCK.toISOString(),
      deduped: true,
    });
    expect(await screenshotCount()).toBe(before);
    expect(await leases(runId)).toEqual([{ released: true }, { released: true }]);
  });
});
