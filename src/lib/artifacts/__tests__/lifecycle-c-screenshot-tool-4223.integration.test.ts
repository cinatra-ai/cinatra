/**
 * cinatra#4223 — THE SCREENSHOT TOOL, against a REAL Postgres and a REAL disk.
 *
 * What only a database can prove:
 *
 *   (i)   a capture of a page on the org's own connect-registered site files ONE
 *         artifact of the screenshot type, whose object data carries the three
 *         facts the display draws — where (`capturedUrl`), at what viewport
 *         (`viewport`) and when (`capturedAt`) — validated against the type's
 *         real declared schema;
 *   (ii)  the write's finalized ledger row names the calling node as both its
 *         node and its output identity, and carries no image provenance (a
 *         screenshot is not a provider-made picture and never counts against the
 *         per-run picture cap);
 *   (iii) a renderer that reports a viewport of width 0 is refused by that same
 *         schema as `data_rejected`, and nothing is filed;
 *   (iv)  both production display builders — the artifact page and the review
 *         card — hand the filed screenshot's display `content.kind === "object"`
 *         carrying the screenshot type and the three facts: the page as the
 *         live data, the review card as the snapshot of the revision it pins;
 *   (v)   when the artifact's live object data moves afterwards, the review
 *         card still shows the facts its pinned revision was filed with.
 *
 * WHAT IS REAL. The site registry read (`createPreviewCaptureDeps()
 * .listRegisteredSites` over a connect site minted by
 * `upsertConnectSiteAndMintCredential`), the capture entry point, the write
 * authorization, the ledger, the artifact write, the type's schema (the pack's
 * own `objectTypes` entry, registered through `registerParsedArtifactManifest`),
 * the ownership derivation, the blob store, the page component and the review
 * preparation.
 *
 * WHAT IS SUPPLIED. The guarded fetch and the isolated renderer (a real browser
 * subprocess proves a browser, not this road), a fixed clock, the run package's
 * registry read (a Verdaccio round trip is not what these items are about), the
 * session, `next/navigation`'s throwers, the page header (client chrome), and
 * the caller's own run/gate ports of the review preparation.
 *
 * ISOLATION: the #3032 tier's own schema, dropped and rebuilt from the canonical
 * DDL in `beforeAll` and dropped in `afterAll`; the config runs its files
 * serially, so this file and the image-tool suite never share a live schema.
 *
 *   SUPABASE_DB_URL=THE-SCRATCH-DSN pnpm test:lifecycle-c-w8
 */
import { mkdtempSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isValidElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerParsedArtifactManifest } from "@cinatra-ai/objects/register-artifact-extensions";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import type { ActorContext } from "@/lib/authz/actor-context";
import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";

const H = vi.hoisted(() => {
  // The store resolves its schema ONCE, at module load, so the name is stated
  // before any import of this file can reach it.
  const schema = "cinatra_test_w8_image_tool_3032";
  process.env.SUPABASE_SCHEMA = schema;
  const org = "org-4223";
  const user = "user-4223";
  return {
    schema,
    org,
    user,
    actor: {
      principalType: "HumanUser",
      principalId: user,
      organizationId: org,
      orgRole: "member",
      platformRole: "member",
      authSource: "ui",
      policyVersion: "test",
      teamIds: [],
      projectGrants: [],
      projectIds: [],
    },
  };
});

// PARTIAL mock, the #3030 / #3032 posture: only the schema/connection the
// throwaway schema needs and the metadata reads are substituted.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// This suite registers the one type it needs directly; the app-boot registrar
// must not clobber it.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The meaning matcher is a post-commit best-effort enqueue onto a queue this
// tier does not run.
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: async () => {},
}));
// The page's session reads, its navigation throwers and its client chrome, as
// in `src/app/artifacts/[id]/__tests__/w3-kind-typed-row-display.integration.test.ts`.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({
    user: { id: H.user },
    session: { activeOrganizationId: H.org },
  }),
  requireActorContext: async () => H.actor,
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));

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

const TEST_SCHEMA = H.schema;
const ORG = H.org;
const USER = H.user;
const TEMPLATE = "tpl-4223";
const ACTOR = H.actor as ActorContext;

const SHOT_EXT = "@cinatra-ai/screenshot-artifact";
const SHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";

/** The connect-registered site, on loopback. */
const SITE_ORIGIN = "http://localhost:4223";
const PAGE_URL = `${SITE_ORIGIN}/about/`;
const CLOCK = new Date("2026-10-17T16:30:00.000Z");
const PAGE_HTML = "<html><body><h1>About</h1><p>Who we are.</p></body></html>";

/** Two real 1x1 PNGs (the #3032 suite's own). The refused capture renders the
 *  second, so its cleanup can never touch the blob a filed capture holds. */
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const PNG_BLUE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

/**
 * The pack's own `objectTypes[0]` entry, copied byte for byte from
 * `@cinatra-ai/screenshot-artifact` `src/index.ts` at c901c855.
 */
const SCREENSHOT_OBJECT_TYPE_ENTRY = {
      type: "@cinatra-ai/screenshot-artifact:screenshot",
      claim: "dedicated",
      dispositions: {
        projection: "artifact-safe",
        pinnable: true,
        snapshotPolicy: "content",
        sensitivity: "normal",
      },
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          mime: { type: "string" },
          size: { type: "integer" },
          capturedUrl: { type: "string", format: "uri" },
          viewport: {
            type: "object",
            properties: {
              width: { type: "integer", minimum: 1 },
              height: { type: "integer", minimum: 1 },
            },
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
let pageMod: typeof import("@/app/artifacts/[id]/page");
let mountMod: typeof import("@/app/artifacts/[id]/artifact-display-mount");
let prepareMod: typeof import("@/app/artifacts/[id]/review-target-prepare");

const S = () => TEST_SCHEMA;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res;
}

/** An ACTIVE dedicated claim over `type` for the org (w8 `seedClaim`). */
async function seedClaim(type: string, ext: string) {
  await sql(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [nextId("claim"), `org:${ORG}`, type, ext, JSON.stringify({ projection: "artifact-safe" })],
  );
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
  return (res.rows[0] ?? null) as null | {
    node_id: string | null;
    output_id: string;
    path: string;
    extension: string;
    phase: string;
    artifact_id: string | null;
    representation_revision_id: string | null;
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

async function screenshotCount(): Promise<number> {
  const res = await sql(
    `SELECT count(*)::int AS n FROM "${S()}"."objects" WHERE org_id=$1 AND type=$2`,
    [ORG, SHOT_TYPE],
  );
  return Number((res.rows[0] as { n: number }).n);
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

/**
 * The tool's seams: the REAL site registry read, a stubbed guarded fetch and
 * renderer (the renderer returns `png` and reports `viewport`), and the fixed
 * clock.
 */
function screenshotDeps(
  viewport: { width: number; height: number },
  png: string = PNG_RED,
): {
  deps: import("@/lib/artifact-page-capture-tool").ArtifactPageCaptureToolDeps;
  seen: Seen;
} {
  const seen: Seen = { fetches: [], renders: [] };
  const captureDeps: import("@/lib/artifacts/registered-page-capture").CaptureRegisteredPageDeps = {
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
    now: () => CLOCK,
  };
  return {
    seen,
    deps: {
      ...tool.artifactPageCaptureToolDeps(),
      // The run package's declared production, in the shape the registry loader
      // returns it.
      loadProducesRefs: async () => [{ extension: SHOT_EXT, objectTypeId: SHOT_TYPE }],
      capturePage: (i) => pageCapture.captureRegisteredPage({ ...i, deps: captureDeps }),
    },
  };
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

/** The snapshot the page hands to one component, found in its returned tree
 *  without rendering it (every prop value is walked, not only children). */
function propsHandedTo(node: unknown, component: unknown): ArtifactRendererProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = propsHandedTo(child, component);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (node.type === component) return (props.props ?? null) as ArtifactRendererProps | null;
  for (const value of Object.values(props)) {
    const found = propsHandedTo(value, component);
    if (found) return found;
  }
  return null;
}

function expectScreenshotObject(
  props: ArtifactRendererProps | null | undefined,
  surface: string,
  pinned: { representationRevisionId: string } | null = null,
  facts: { capturedUrl: string; capturedAt: string } = {
    capturedUrl: PAGE_URL,
    capturedAt: CLOCK.toISOString(),
  },
) {
  expect(props, `${surface}: no renderer-props snapshot was built`).toBeTruthy();
  const content = props!.content;
  expect(content.kind, `${surface}: content kind`).toBe("object");
  if (content.kind !== "object") return;
  expect(content.objectType, `${surface}: objectType`).toBe(SHOT_TYPE);
  // The page draws the artifact as it is now; a review card draws ONE pinned
  // revision, so its facts are that revision's own snapshot.
  expect(content.source, `${surface}: source`).toBe(pinned ? "snapshot" : "live");
  expect(content.representationRevisionId, `${surface}: revision`).toBe(
    pinned ? pinned.representationRevisionId : null,
  );
  const data = content.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), `${surface}: keys`).toEqual([
    "capturedAt",
    "capturedUrl",
    "viewport",
  ]);
  expect(data.capturedUrl, `${surface}: capturedUrl`).toBe(facts.capturedUrl);
  expect(data.viewport, `${surface}: viewport`).toEqual({ width: 1280, height: 900 });
  expect(data.capturedAt, `${surface}: capturedAt`).toBe(facts.capturedAt);
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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  ({ runPostgresQueriesAsync } = await import("@/lib/postgres-async"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  tool = await import("@/lib/artifact-page-capture-tool");
  capture = await import("@/lib/artifacts/cms-preview-capture");
  pageCapture = await import("@/lib/artifacts/registered-page-capture");
  pageMod = await import("@/app/artifacts/[id]/page");
  mountMod = await import("@/app/artifacts/[id]/artifact-display-mount");
  prepareMod = await import("@/app/artifacts/[id]/review-target-prepare");

  objectTypeRegistry._clearForTests();
  const registered = registerParsedArtifactManifest(
    {
      accepts: { file: { mimeTypes: ["image/png", "image/jpeg", "image/webp"] } },
      objectTypes: [SCREENSHOT_OBJECT_TYPE_ENTRY],
    } as never,
    SHOT_EXT,
  );
  if (!registered) throw new Error("the screenshot type did not register");
  await seedClaim(SHOT_TYPE, SHOT_EXT);
  await sql(
    `INSERT INTO "${S()}"."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, status,
        package_name, package_version, owner_level, owner_id)
     VALUES ($1, $2, '4223 screenshot fixture', 'n/a', '{}', '{}', 'auto', 'active',
             $3, '1.0.0', 'organization', $2)`,
    [TEMPLATE, ORG, "@cinatra-ai/screenshot-fixture-agent"],
  );

  // THE ORG'S ACTIVE CONNECT SITE, minted through the production provisioning
  // write. The credential it returns is never read here.
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
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#4223 — a capture of a registered page files a screenshot carrying its three facts",
  () => {
    it("(i) files one artifact of the screenshot type whose object data carries where, at what viewport and when", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const before = await screenshotCount();
      const { deps, seen } = screenshotDeps({ width: 1280, height: 900 });

      const outcome = await tool.captureArtifactPage(captureCall(runId, "capture_page"), deps);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);
      expect(outcome.capturedUrl).toBe(PAGE_URL);
      expect(outcome.viewport).toEqual({ width: 1280, height: 900 });
      expect(outcome.capturedAt).toBe(CLOCK.toISOString());
      expect(outcome.deduped).toBe(false);

      // The real site read matched the page's origin: one fetch of the page,
      // with no credential headers, and one render pinned to the guard's
      // addresses and confined to the site's origin.
      expect(seen.fetches).toEqual([{ url: PAGE_URL, headers: {} }]);
      expect(seen.renders).toEqual([
        { documentUrl: PAGE_URL, allowedOrigin: SITE_ORIGIN, pinnedAddresses: ["::1"] },
      ]);

      expect(await screenshotCount()).toBe(before + 1);
      const row = await objectRow(outcome.artifactId);
      expect(row?.type).toBe(SHOT_TYPE);
      expect(row?.data.capturedUrl).toBe(PAGE_URL);
      expect(row?.data.viewport).toEqual({ width: 1280, height: 900 });
      expect(row?.data.capturedAt).toBe(CLOCK.toISOString());
      expect(row?.data.mime).toBe("image/png");
      expect(row?.data.latestRepresentationRevisionId).toBe(outcome.representationRevisionId);

      // The bytes on disk are the bytes the renderer returned.
      expect((await artifactBytes(outcome.artifactId)).toString("base64")).toBe(PNG_RED);
    });

    it("(ii) the finalized ledger row names the node as node and output, with no image provenance", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const { deps } = screenshotDeps({ width: 1280, height: 900 });

      const outcome = await tool.captureArtifactPage(captureCall(runId, "capture_home"), deps);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);

      const ledger = await ledgerRow(runId, "capture_home");
      expect(ledger?.phase).toBe("finalized");
      expect(ledger?.path).toBe("materialize_tool");
      expect(ledger?.node_id).toBe("capture_home");
      expect(ledger?.output_id).toBe("capture_home");
      expect(ledger?.extension).toBe(SHOT_EXT);
      expect(ledger?.artifact_id).toBe(outcome.artifactId);
      expect(ledger?.representation_revision_id).toBe(outcome.representationRevisionId);
      expect(ledger?.image_prompt).toBeNull();
      expect(ledger?.image_provider).toBeNull();
      expect(ledger?.image_model).toBeNull();
    });

    it("(iii) a renderer viewport of width 0 is refused by the declared schema as data_rejected, and nothing is filed", async () => {
      const runId = nextId("run");
      await seedRun(runId);
      const before = await screenshotCount();
      const { deps } = screenshotDeps({ width: 0, height: 900 }, PNG_BLUE);

      const outcome = await tool.captureArtifactPage(
        captureCall(runId, "capture_narrow"),
        deps,
      );

      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("unreachable");
      expect(outcome.reason).toBe("data_rejected");
      expect(outcome.error).toMatch(/does not satisfy the declared schema/);
      expect(await screenshotCount()).toBe(before);
      const ledger = await ledgerRow(runId, "capture_narrow");
      expect(ledger?.phase).not.toBe("finalized");
    });
  },
);

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#4223 — both display builders hand a filed screenshot its facts as object content",
  () => {
    let artifactId = "";
    let representationRevisionId = "";

    beforeAll(async () => {
      if (!HAS_REAL_DB) return;
      const runId = nextId("run");
      await seedRun(runId);
      const { deps } = screenshotDeps({ width: 1280, height: 900 });
      const outcome = await tool.captureArtifactPage(
        captureCall(runId, "capture_for_display"),
        deps,
      );
      if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);
      artifactId = outcome.artifactId;
      representationRevisionId = outcome.representationRevisionId;
    });

    it("(iv) the artifact page hands its display object content with the screenshot type and the three facts", async () => {
      const tree = await pageMod.default({ params: Promise.resolve({ id: artifactId }) });
      expectScreenshotObject(
        propsHandedTo(tree, mountMod.ArtifactDisplayMountPoint),
        "artifact page",
      );
    });

    async function reviewCardProps() {
      const target = { artifactId, representationRevisionId };
      const result = await prepareMod.prepareArtifactReviewTargets({
        input: {
          runId: `run-4223-${randomUUID()}`,
          reviewTaskId: `wayflow-${randomUUID()}`,
          targets: [target],
        },
        orgId: ORG,
        actor: ACTOR,
        runGatePorts: {
          verifyRunAccess: () => ({ ok: true as const }),
          readGatePinnedTargets: () => ({ status: "pending" as const, targets: [target] }),
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return null;
      expect(result.prepared).toHaveLength(1);
      return result.prepared[0]!.props;
    }

    it("(iv) the review card hands its display the pinned revision's facts as a snapshot", async () => {
      expectScreenshotObject(await reviewCardProps(), "review card", { representationRevisionId });
    });

    // LAST in this block: it moves the artifact's live object data.
    it("(v) after the live object data moves, the review card keeps the pinned revision's facts and the page shows the live ones", async () => {
      const MOVED = {
        capturedUrl: `${SITE_ORIGIN}/moved/`,
        capturedAt: "2026-10-18T09:00:00.000Z",
      };
      await sql(
        `UPDATE "${S()}"."objects" SET data = data || $3::jsonb WHERE id=$1 AND org_id=$2`,
        [artifactId, ORG, JSON.stringify(MOVED)],
      );
      expect((await objectRow(artifactId))?.data.capturedUrl).toBe(MOVED.capturedUrl);

      expectScreenshotObject(await reviewCardProps(), "review card", { representationRevisionId });

      const tree = await pageMod.default({ params: Promise.resolve({ id: artifactId }) });
      expectScreenshotObject(
        propsHandedTo(tree, mountMod.ArtifactDisplayMountPoint),
        "artifact page",
        null,
        MOVED,
      );
    });
  },
);
