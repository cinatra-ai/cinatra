/**
 * cinatra#4223: A FILED PAGE CAPTURE REACHES ITS DISPLAY WITH ITS THREE FACTS,
 * through both production builders, against a REAL Postgres and a REAL disk.
 *
 * A picture's file form has no content class, so the content channel answers
 * `unsupported-form`. The page capture tool records the capture's facts (where,
 * at what viewport, when) with the revision it files. The artifact page and the
 * review target hand that record to the display as the object snapshot of the
 * revision they draw, through `buildObjectContentProjection`:
 *
 *   (i)  the artifact page's renderer-props snapshot carries `content.kind`
 *        "object", the screenshot type and the three filed facts;
 *   (ii) the review target's snapshot for the pinned revision carries the same;
 *   (iii) after the row's live object data moves, both still carry the facts
 *        recorded with the revision: object data never reaches the display as
 *        capture facts.
 *
 * WHAT IS REAL. Everything of the page capture suite beside this one (the site
 * registry read, the capture entry point, the ledger, the artifact write, the
 * type's declared schema, the facts record and its reader, the blob store),
 * the artifact page component itself, the display mount resolution and the
 * review target preparation.
 *
 * WHAT IS SUPPLIED. The guarded fetch and the isolated renderer, a fixed clock,
 * the run package's registry read, the page's session reads, its navigation
 * throwers and its client page header (as in
 * `src/app/artifacts/[id]/__tests__/w3-kind-typed-row-display.integration.test.ts`
 * for the stores), and the run and gate ports of the review preparation.
 *
 * ISOLATION: the #3032 tier's own schema, dropped and rebuilt from the canonical DDL
 * in `beforeAll` and dropped in `afterAll`; the config runs its files serially.
 *
 *   SUPABASE_DB_URL=THE-SCRATCH-DSN pnpm test:lifecycle-c-w8
 */
import { mkdtempSync, rmSync } from "node:fs";
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
// This suite registers the one type it needs directly; the app-boot registrar must not clobber it.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The meaning matcher is a post-commit best-effort enqueue onto a queue this tier does not run.
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({ enqueueArtifactMatchRun: async () => {} }));
// The page's session reads, its navigation throwers and its client chrome.
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => ({ user: { id: H.user }, session: { activeOrganizationId: H.org } }),
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
    "this tier exists to run against a real Postgres, and it was asked to run: set SUPABASE_DB_URL to a " +
      "scratch database. It builds and drops its own schema, so any throwaway database will do.",
  );
}

const TEST_SCHEMA = H.schema;
const ORG = H.org;
const USER = H.user;
const TEMPLATE = "tpl-4223";
const SHOT_EXT = "@cinatra-ai/screenshot-artifact";
const SHOT_TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
/** The connect-registered site, on loopback. */
const SITE_ORIGIN = "http://localhost:4223";
const PAGE_URL = `${SITE_ORIGIN}/about/`;
const CLOCK = new Date("2026-10-17T16:30:00.000Z");
const PAGE_HTML = "<html><body><h1>About</h1><p>Who we are.</p></body></html>";

/** A real 1x1 PNG (the #3032 suite's own). */
const PNG_RED =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

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
let pageMod: typeof import("@/app/artifacts/[id]/page");
let mountMod: typeof import("@/app/artifacts/[id]/artifact-display-mount");
let prepareMod: typeof import("@/app/artifacts/[id]/review-target-prepare");

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

async function objectRow(artifactId: string) {
  const res = await sql(`SELECT type, data FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`, [artifactId, ORG]);
  return (res.rows[0] ?? null) as null | { type: string; data: Record<string, unknown> };
}

type Seen = {
  fetches: Array<{ url: string; headers: Record<string, string> }>;
  renders: Array<{ documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }>;
};

/** The REAL site registry read, a stubbed guarded fetch and renderer, and a fixed clock; every other seam is production. */
function captureDeps(viewport: { width: number; height: number }) {
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
        screenshot: new Uint8Array(Buffer.from(PNG_RED, "base64")),
        geometry: { regions: [], contentHeight: 900, viewport },
        network: { blockedRequests: 0, allowedRequests: 0 },
      };
    },
    now: () => CLOCK,
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


const ACTOR = H.actor as unknown as ActorContext;
const FILED = { capturedUrl: PAGE_URL, viewport: { width: 1280, height: 900 }, capturedAt: CLOCK.toISOString() };

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

function expectFiledFacts(
  props: ArtifactRendererProps | null | undefined,
  surface: string,
  representationRevisionId: string,
) {
  expect(props, `${surface}: no renderer-props snapshot was built`).toBeTruthy();
  const content = props!.content;
  expect(content.kind, `${surface}: content kind`).toBe("object");
  if (content.kind !== "object") return;
  expect(content.objectType, `${surface}: objectType`).toBe(SHOT_TYPE);
  // The facts are the revision's own record, so the projection names that revision.
  expect(content.source, `${surface}: source`).toBe("snapshot");
  expect(content.representationRevisionId, `${surface}: revision`).toBe(representationRevisionId);
  const data = content.data as Record<string, unknown>;
  expect(Object.keys(data).sort(), `${surface}: keys`).toEqual(["capturedAt", "capturedUrl", "viewport"]);
  expect(data.capturedUrl, `${surface}: capturedUrl`).toBe(FILED.capturedUrl);
  expect(data.viewport, `${surface}: viewport`).toEqual(FILED.viewport);
  expect(data.capturedAt, `${surface}: capturedAt`).toBe(FILED.capturedAt);
}

describe.skipIf(!HAS_REAL_DB)("cinatra#4223 both display builders hand a filed page capture its facts as object content", () => {
  let artifactId = "";
  let representationRevisionId = "";

  beforeAll(async () => {
    if (!HAS_REAL_DB) return;
    const runId = nextId("run");
    await seedRun(runId);
    const outcome = await tool.captureArtifactPage(
      captureCall(runId, "capture_for_display"),
      captureDeps({ width: 1280, height: 900 }).deps,
    );
    if (!outcome.ok) throw new Error(`${outcome.reason}: ${outcome.error}`);
    artifactId = outcome.artifactId;
    representationRevisionId = outcome.representationRevisionId;
  });

  async function pageProps() {
    const tree = await pageMod.default({ params: Promise.resolve({ id: artifactId }) });
    return propsHandedTo(tree, mountMod.ArtifactDisplayMountPoint);
  }

  async function reviewTargetProps() {
    const target = { artifactId, representationRevisionId };
    const result = await prepareMod.prepareArtifactReviewTargets({
      input: { runId: `run-4223-${randomUUID()}`, reviewTaskId: `wayflow-${randomUUID()}`, targets: [target] },
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

  it("(i) the artifact page hands its display object content with the screenshot type and the three facts", async () => {
    expectFiledFacts(await pageProps(), "artifact page", representationRevisionId);
  });

  it("(ii) the review target hands its display the pinned revision's facts", async () => {
    expectFiledFacts(await reviewTargetProps(), "review target", representationRevisionId);
  });

  // LAST in this block: it moves the artifact's live object data.
  it("(iii) after the row's object data moves, both builders still hand the facts recorded with the revision", async () => {
    const MOVED = { capturedUrl: `${SITE_ORIGIN}/moved/`, capturedAt: "2026-10-18T09:00:00.000Z" };
    await sql(`UPDATE "${S()}"."objects" SET data = data || $3::jsonb WHERE id=$1 AND org_id=$2`, [
      artifactId,
      ORG,
      JSON.stringify(MOVED),
    ]);
    expect((await objectRow(artifactId))?.data.capturedUrl).toBe(MOVED.capturedUrl);

    expectFiledFacts(await pageProps(), "artifact page", representationRevisionId);
    expectFiledFacts(await reviewTargetProps(), "review target", representationRevisionId);
  });
});
