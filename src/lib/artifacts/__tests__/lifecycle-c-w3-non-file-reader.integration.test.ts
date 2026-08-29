/**
 * cinatra#3027 (epic #3023, lifecycle-c W3) — the NON-FILE REVISION READER
 * (enabler 0.10) against a REAL Postgres, on the real substrate DDL.
 *
 * THIS IS ACCEPTANCE ITEM 4: "A dashboard artifact's display reads its pinned
 * configuration through the non-file reader." The unit tier proves what the
 * preparation core does with a non-file member; only a real database can prove
 * that the reader's tuple check, its form filter and its projection agree with
 * the substrate — a stubbed store would agree with whatever the code said.
 *
 * ISOLATION: a fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` DDL — never the worktree's shared schema and
 * never hand-rolled drift-prone DDL — so the reader runs against the exact
 * production constraints (`representation_form_chk`, `resource_kind_chk`, the
 * append-only trigger). Because `postgresSchema` is a module-load const, every
 * app module is dynamically imported in `beforeAll` AFTER the env is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// The reader warms the object-type registry, whose registrar drags the whole
// boot graph (auth, every connector) into a node tier that needs none of it.
// The sibling artifact integration suites stub the registrar for exactly this
// reason; the rows below carry the GENERIC artifact type, which the reader
// admits without any pack registration.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_w3_nonfile_3027";
const ORG = "org-3027";
const OTHER_ORG = "org-3027-other";
/** The generic artifact object type every artifact row carries. */
const GENERIC_ARTIFACT_TYPE = "@cinatra-ai/artifact:object";
const DASHBOARD_MIME = "application/vnd.cinatra.dashboard+json";
/** The configuration the dashboard's twin writer records per revision. */
const PINNED_CONFIGURATION = {
  portlets: [{ id: "revenue", kind: "kpi" }],
  filters: [],
  version: 12,
};

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let reader: typeof import("@/lib/artifacts/artifact-read");
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;

const S = () => TEST_SCHEMA;
function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Seed a real dashboard artifact: an `objects` row, a `dashboard`-kind
 *  `resource`, and one `dashboard`-form `representation` revision carrying the
 *  pinned configuration record the owning system's twin writer writes. */
function seedDashboard(options: {
  orgId?: string;
  configuration?: unknown | undefined;
  deleted?: boolean;
} = {}) {
  const orgId = options.orgId ?? ORG;
  const artifactId = nextId("dash");
  const resourceId = nextId("res");
  const revisionId = nextId("rev");
  sql(
    `INSERT INTO "${S()}"."objects" (id, org_id, type, data, deleted_at)
     VALUES ($1, $2, $3, '{}'::jsonb, ${options.deleted ? "now()" : "NULL"})`,
    [artifactId, orgId, GENERIC_ARTIFACT_TYPE],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, metadata)
     VALUES ($1, $2, 'dashboard', $3, $4, 0, 'skipped', '{}'::jsonb)`,
    [resourceId, orgId, artifactId, DASHBOARD_MIME],
  );
  const signals =
    options.configuration === undefined
      ? null
      : JSON.stringify({ pinnedConfiguration: options.configuration });
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form, classifier_signals)
     VALUES ($1, $2, $3, $4, 1, 'dashboard', $5::jsonb)`,
    [revisionId, orgId, artifactId, resourceId, signals],
  );
  return { artifactId, resourceId, revisionId, orgId };
}

/** Seed a FILE artifact — the reader must never claim one. */
function seedFile() {
  const artifactId = nextId("file");
  const resourceId = nextId("res");
  const revisionId = nextId("rev");
  sql(
    `INSERT INTO "${S()}"."objects" (id, org_id, type, data) VALUES ($1, $2, $3, '{}'::jsonb)`,
    [artifactId, ORG, GENERIC_ARTIFACT_TYPE],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, metadata)
     VALUES ($1, $2, 'blob', $3, 'text/markdown', 10, 'clean', '{}'::jsonb)`,
    [resourceId, ORG, nextId("sha")],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1, $2, $3, $4, 1, 'file')`,
    [revisionId, ORG, artifactId, resourceId],
  );
  return { artifactId, revisionId };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) {
    if (process.env.CINATRA_LIFECYCLE_C_W3_REALDB === "1") {
      throw new Error(
        "this tier exists to run against a real Postgres — set SUPABASE_DB_URL",
      );
    }
    return;
  }
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
  reader = await import("@/lib/artifacts/artifact-read");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("enabler 0.10 — the non-file reader on the real substrate", () => {
  it("returns the form and the PINNED CONFIGURATION RECORD for a dashboard revision", () => {
    const seeded = seedDashboard({ configuration: PINNED_CONFIGURATION });
    const resolved = reader.resolveNonFileArtifactRevision({
      orgId: seeded.orgId,
      artifactId: seeded.artifactId,
      representationRevisionId: seeded.revisionId,
    });
    expect(resolved).not.toBeNull();
    expect(resolved?.form).toBe("dashboard");
    expect(resolved?.mime).toBe(DASHBOARD_MIME);
    expect(resolved?.configuration).toEqual(PINNED_CONFIGURATION);
    // The digest a data capability is sealed to (enabler 0.12) — stable and
    // key-order independent, so two structurally equal configurations agree.
    expect(resolved?.configurationDigest).toBe(
      reader.pinnedConfigurationDigest({
        version: 12,
        filters: [],
        portlets: [{ kind: "kpi", id: "revenue" }],
      }),
    );
  });

  it("answers a NULL configuration honestly while the owning twin writer has written none", () => {
    const seeded = seedDashboard({ configuration: undefined });
    const resolved = reader.resolveNonFileArtifactRevision({
      orgId: seeded.orgId,
      artifactId: seeded.artifactId,
      representationRevisionId: seeded.revisionId,
    });
    expect(resolved?.form).toBe("dashboard");
    expect(resolved?.configuration).toBeNull();
    expect(resolved?.configurationDigest).toBeNull();
  });

  it("verifies the EXACT (organization, artifact, revision) tuple", () => {
    const a = seedDashboard({ configuration: PINNED_CONFIGURATION });
    const b = seedDashboard({ configuration: PINNED_CONFIGURATION });
    const foreign = seedDashboard({ orgId: OTHER_ORG, configuration: PINNED_CONFIGURATION });

    // Another organization's row is invisible, even with the right ids.
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: ORG,
        artifactId: foreign.artifactId,
        representationRevisionId: foreign.revisionId,
      }),
    ).toBeNull();
    // A real revision under the WRONG artifact is not a member.
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: ORG,
        artifactId: a.artifactId,
        representationRevisionId: b.revisionId,
      }),
    ).toBeNull();
    // A revision that does not exist.
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: ORG,
        artifactId: a.artifactId,
        representationRevisionId: "rev-that-never-was",
      }),
    ).toBeNull();
  });

  it("THE FILE-SERVING READ STAYS FILE-ONLY, and this reader stays non-file-only", () => {
    const file = seedFile();
    const dash = seedDashboard({ configuration: PINNED_CONFIGURATION });
    // The non-file reader refuses a file revision …
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: ORG,
        artifactId: file.artifactId,
        representationRevisionId: file.revisionId,
      }),
    ).toBeNull();
    // … and the byte resolver refuses the dashboard revision, exactly as before.
    expect(
      reader.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId: dash.artifactId,
        representationRevisionId: dash.revisionId,
      }),
    ).toBeNull();
  });

  it("refuses a TOMBSTONED artifact live, and reads it for the gate-authorized historical reading only when a pin exists", () => {
    const seeded = seedDashboard({ configuration: PINNED_CONFIGURATION, deleted: true });
    // The ordinary (live) reading: gone.
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: seeded.orgId,
        artifactId: seeded.artifactId,
        representationRevisionId: seeded.revisionId,
      }),
    ).toBeNull();
    // The historical reading with NO pin is still gone — `liveOnly: false` is
    // not a skeleton key, it honours the same `artifact_refs` pin the byte
    // resolver honours.
    expect(
      reader.resolveNonFileArtifactRevision({
        orgId: seeded.orgId,
        artifactId: seeded.artifactId,
        representationRevisionId: seeded.revisionId,
        liveOnly: false,
      }),
    ).toBeNull();

    // With the pin the gate recorded, the approved work is still readable.
    sql(
      `INSERT INTO "${S()}"."artifact_refs"
         (id, org_id, artifact_id, representation_revision_id, digest, mime, origin_kind, referrer_kind, referrer_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'agent_generated', 'review_gate', $7)`,
      [
        nextId("ref"),
        seeded.orgId,
        seeded.artifactId,
        seeded.revisionId,
        "sha256:pinned",
        DASHBOARD_MIME,
        nextId("gate"),
      ],
    );
    const historical = reader.resolveNonFileArtifactRevision({
      orgId: seeded.orgId,
      artifactId: seeded.artifactId,
      representationRevisionId: seeded.revisionId,
      liveOnly: false,
    });
    expect(historical?.form).toBe("dashboard");
    expect(historical?.configuration).toEqual(PINNED_CONFIGURATION);
  });
});
