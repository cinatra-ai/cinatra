/**
 * cinatra#1896 / epic #1883 §D8 (v1) — REAL-DB integration proof that
 * DASHBOARD-FORM rows are excluded from attachment-hydrated context candidates.
 *
 * A dashboards-artifact twin (§D7) writes an `objects` row of the base type
 * `@cinatra-ai/dashboard-artifact:dashboard` (a registered artifact type, so the
 * resolver's type predicate admits it) whose substance is the published
 * dashboard envelope — a `representation.form = 'dashboard'` row, NOT ingestible
 * file bytes. Such a row can never be hydrated as an LLM attachment. This suite
 * proves the CANDIDATE query (`resolveContextSlot`, #1430 — the producer every
 * attachment-hydration consumer reads) EXCLUDES a dashboard-form row even when it
 * carries an eligible assertion an accepted extension matches, while a file-form
 * row that is otherwise IDENTICAL (same type-admission, same eligible accepted
 * assertion) still resolves — so `form` is the sole discriminant.
 *
 * ISOLATION (the pack-typed-readers.integration.test.ts pattern): fresh schema
 * per file from the CANONICAL `buildCreateStoreSchemaQueries` DDL; app modules
 * dynamically imported in `beforeAll` AFTER the env is set; the app-boot
 * registrar is no-op'd and the two types this suite needs are registered
 * directly.
 */
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
const TEST_SCHEMA = "cinatra_test_ctx_dashboard_excl_1896";
const ORG = "org-1896";
const EXT = "@cinatra-ai/marketing-icp-artifact";
const DOC_TYPE = "@cinatra-ai/doc-artifact:document";
const DASH_TYPE = "@cinatra-ai/dashboard-artifact:dashboard";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let resolverMod: typeof import("@/lib/artifacts/context-resolver");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

function seedObject(id: string, type: string) {
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,'{}'::jsonb,1,'pending','organization',$3,'organization',NULL)`,
    [id, type, ORG],
  );
}

/** A file-form representation (revision 1) through the resource model. */
function seedFileRepresentation(artifactId: string): string {
  const resourceId = nextId("res");
  const repId = nextId("rep");
  const sha = nextId("sha");
  sql(
    `INSERT INTO "${S()}"."resource"
       (id, org_id, kind, substance_key, mime, size_bytes, metadata)
     VALUES ($1,$2,'blob',$3,'text/markdown',$4,'{}'::jsonb)`,
    [resourceId, ORG, `blob:${sha}`, 12],
  );
  sql(
    `INSERT INTO "${S()}"."representation"
       (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,1,'file')`,
    [repId, ORG, artifactId, resourceId],
  );
  return repId;
}

/** A dashboard-form representation (revision 1) — the twin writer's shape. */
function seedDashboardRepresentation(artifactId: string): string {
  const resourceId = nextId("res");
  const repId = nextId("rep");
  sql(
    `INSERT INTO "${S()}"."resource"
       (id, org_id, kind, substance_key, mime, size_bytes, metadata)
     VALUES ($1,$2,'dashboard',$3,'application/vnd.cinatra.dashboard+json',0,'{}'::jsonb)`,
    [resourceId, ORG, artifactId],
  );
  sql(
    `INSERT INTO "${S()}"."representation"
       (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1,$2,$3,$4,1,'dashboard')`,
    [repId, ORG, artifactId, resourceId],
  );
  return repId;
}

/** An eligible CLASSIC assertion an accepted extension matches. */
function seedClassicAssertion(artifactId: string, extension: string): string {
  const id = nextId("sa");
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, assertion_basis)
     VALUES ($1,$2,$3,$4,'agent','eligible','classic')`,
    [id, ORG, artifactId, extension],
  );
  return id;
}

const ACTOR = {
  principalType: "HumanUser",
  principalId: "user-1896",
  organizationId: ORG,
  authSource: "agent",
  projectIds: [],
} as never;
const SLOT = {
  slotId: "slot-1896",
  acceptedArtifactExtensions: [EXT],
  selectionMode: "autonomous" as const,
  resolutionMode: "accumulate" as const,
};
const INSTALLED = [{ extension: EXT, satisfies: [] as string[] }];

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

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
  resolverMod = await import("@/lib/artifacts/context-resolver");

  // Both types must be in listArtifacts() so the resolver admits their rows.
  objectTypeRegistry._clearForTests();
  objectTypeRegistry.register(
    {
      type: DOC_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/markdown"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    "@cinatra-ai/doc-artifact",
  );
  objectTypeRegistry.register(
    {
      type: DASH_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { dashboard: {} } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    "@cinatra-ai/dashboard-artifact",
  );
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "cinatra#1896 §D8 — dashboard-form rows excluded from context candidates (real DB)",
  () => {
    it("both types are registered artifacts (control: type-admission is NOT the discriminant)", () => {
      const types = objectTypeRegistry.listArtifacts().map((d) => d.type);
      expect(types).toContain(DOC_TYPE);
      expect(types).toContain(DASH_TYPE);
    });

    it("resolves a file-form row but EXCLUDES an otherwise-identical dashboard-form row", () => {
      // Row A — file-form: registered artifact type + eligible accepted assertion.
      const fileId = nextId("obj-file");
      seedObject(fileId, DOC_TYPE);
      seedFileRepresentation(fileId);
      seedClassicAssertion(fileId, EXT);

      // Row B — dashboard-form: registered artifact type + eligible accepted
      // assertion (same as A). The ONLY difference is representation.form.
      const dashId = nextId("obj-dash");
      seedObject(dashId, DASH_TYPE);
      seedDashboardRepresentation(dashId);
      seedClassicAssertion(dashId, EXT);

      const refs = resolverMod.resolveContextSlot({
        actor: ACTOR,
        slot: SLOT,
        installedExtensions: INSTALLED,
      });
      const ids = refs.map((r) => r.artifactId);
      // The file-form row resolves…
      expect(ids).toContain(fileId);
      // …the dashboard-form row is excluded (the §D8 v1 guard).
      expect(ids).not.toContain(dashId);
    });

    it("excludes a dashboard-form row even under an explicit project refinement", () => {
      const dashId = nextId("obj-dash-proj");
      seedObject(dashId, DASH_TYPE);
      seedDashboardRepresentation(dashId);
      seedClassicAssertion(dashId, EXT);

      const refs = resolverMod.resolveContextSlot({
        actor: { ...(ACTOR as object), projectIds: ["proj-1896"] } as never,
        slot: SLOT,
        projectId: "proj-1896",
        installedExtensions: INSTALLED,
      });
      expect(refs.map((r) => r.artifactId)).not.toContain(dashId);
    });
  },
);
