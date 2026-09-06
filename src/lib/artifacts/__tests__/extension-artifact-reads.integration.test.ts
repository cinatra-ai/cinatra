/**
 * DEPENDENCY-SCOPED ARTIFACT READS, AND THE LISTING'S CURSOR, ON A REAL
 * POSTGRES (cinatra#3031, epic #3023 W7).
 *
 * Acceptance item 3, in the issue's own words: "a flow lists and reads
 * artifacts of a declared dependency and is refused for an undeclared kind".
 * Acceptance item 4: "the listing pages with a cursor".
 *
 * The plan sentence they serve — enabler 0.26: "the passthrough admits the
 * list, the get and a new content read — the text of a representation up to a
 * cap — only for types the calling extension declares as artifact dependencies
 * — an admission bound to the declaration and the version, the shape the
 * delegated chat's perimeter already has — bound to the organisation of the
 * run, size-capped and audited; the listing gains a filter by type and a cursor
 * in place of its flat cap."
 *
 * WHY A REAL STORE. The cursor is the half that cannot be proved anywhere else:
 * a keyset page boundary is a claim about an ORDER BY and a tuple comparison
 * that Postgres performs, and about rows a Postgres index returns. A double
 * would page a JavaScript array and agree with itself. So the rows here are
 * real `objects` rows in a real schema built from the product's own bootstrap
 * DDL, read through the shipped `listObjectsByFilter` → `listArtifacts` →
 * `listArtifactsPage` chain, and the content read resolves through the same
 * `resolveArtifactVersionForServe` + blob-store range read the serve route uses.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const IN_DEDICATED_LANE = process.env.CINATRA_EXTENSION_TABLES_REALDB === "1";

if (IN_DEDICATED_LANE && !HAS_DB) {
  throw new Error(
    "the #3031 artifact-reads lane needs a live Postgres: set SUPABASE_DB_URL to a real " +
      "connection string. Refusing to skip — a skipped proof that a cursor pages without " +
      "dropping a row proves nothing.",
  );
}
const describeDb = HAS_DB ? describe : describe.skip;

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x3031";
const q = (s: string) => s.replaceAll('"', '""');

const CALLER = "@cinatra-ai/w7-reader-agent";
const IDEA_PKG = "@cinatra-ai/w7-idea-artifact";
const IDEA_TYPE = `${IDEA_PKG}:idea`;
const POST_PKG = "@cinatra-ai/w7-post-artifact";
const POST_TYPE = `${POST_PKG}:post`;
const ORG = "org-w7-reads";
const OTHER_ORG = "org-w7-reads-other";
const PERSON = "usr-w7-reads";
const RUN_ID = "run-w7-reads";

const PUBLIC_FLOOR: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS public."user" (id text PRIMARY KEY, username text, name text NOT NULL, email text NOT NULL, "emailVerified" boolean NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public."organization" (id text PRIMARY KEY, slug text NOT NULL, name text NOT NULL, "createdAt" timestamptz NOT NULL, "archivedAt" timestamptz, "archiveEpoch" int)`,
  `CREATE TABLE IF NOT EXISTS public."team" (id text PRIMARY KEY, "organizationId" text, name text)`,
  `CREATE TABLE IF NOT EXISTS public."teamMember" (id text PRIMARY KEY, "teamId" text, "userId" text)`,
  `CREATE TABLE IF NOT EXISTS public."member" (id text PRIMARY KEY, "organizationId" text, "userId" text, "createdAt" timestamptz, role text)`,
  `CREATE TABLE IF NOT EXISTS public."oauthClient" (id text PRIMARY KEY, "clientId" text)`,
];

let admin: Client;
let dataRoot: string;
const auditEvents: Record<string, unknown>[] = [];

/** The admission the reads run under: ONE declared artifact dependency. */
async function admissionFor(deps: unknown[]) {
  const { resolveArtifactDependencyAdmission } = await import(
    "@/lib/artifacts/extension-artifact-admission"
  );
  return resolveArtifactDependencyAdmission({
    packageName: CALLER,
    packageVersion: "1.0.0",
    cinatra: { dependencies: deps },
  });
}

async function readCtx(deps?: unknown[]) {
  return {
    admission: await admissionFor(
      deps ?? [
        {
          packageName: IDEA_PKG,
          kind: "artifact",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "^1.0.0" },
          requirement: "required",
        },
      ],
    ),
    orgId: ORG,
    runId: RUN_ID,
    audit: async (e: Record<string, unknown>) => {
      auditEvents.push(e);
    },
  };
}

/** One artifact row, with the substance a content read resolves through. */
async function seedArtifact(input: {
  id: string;
  type: string;
  orgId: string;
  createdAt: string;
  text?: string;
}) {
  const s = q(SCHEMA);
  let latestRevision: string | null = null;
  if (input.text !== undefined) {
    const revisionId = `rev-${input.id}`;
    const blobId = `blob-${input.id}`;
    const resourceId = `res-${input.id}`;
    const bytes = Buffer.from(input.text, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const storageKey = `orgs/${input.orgId}/artifacts/${input.id}/versions/${revisionId}/${blobId}.bin`;
    const abs = join(dataRoot, storageKey);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, bytes);
    await admin.query(
      `INSERT INTO "${s}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
       VALUES ($1,$2,'local-disk',$3,$4,$5,'text/markdown',$6)`,
      [blobId, input.orgId, storageKey, sha, bytes.length, PERSON],
    );
    await admin.query(
      `INSERT INTO "${s}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, metadata, created_by)
       VALUES ($1,$2,'blob',$3,'text/markdown',$4,$5::jsonb,$6)`,
      [resourceId, input.orgId, sha, bytes.length, JSON.stringify({ blobId, storageKey }), PERSON],
    );
    await admin.query(
      `INSERT INTO "${s}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by)
       VALUES ($1,$2,$3,$4,1,'file',$5)`,
      [revisionId, input.orgId, input.id, resourceId, PERSON],
    );
    latestRevision = revisionId;
  }
  await admin.query(
    `INSERT INTO "${s}"."objects" (id, type, data, org_id, created_by, created_at, updated_at, owner_level, visibility, source)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6::timestamptz,$6::timestamptz,'organization','organization','test')`,
    [
      input.id,
      input.type,
      JSON.stringify({
        title: input.id,
        mime: "text/markdown",
        size: input.text?.length ?? 0,
        artifactType: "file",
        originKind: "agent_generated",
        ...(latestRevision ? { latestRepresentationRevisionId: latestRevision } : {}),
      }),
      input.orgId,
      PERSON,
      input.createdAt,
    ],
  );
}

describeDb("dependency-scoped artifact reads (cinatra#3031 acceptance 3 and 4)", () => {
  beforeAll(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "w7-artifacts-"));
    process.env.CINATRA_ARTIFACT_DATA_ROOT = dataRoot;
    process.env.SUPABASE_SCHEMA = SCHEMA;

    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS "${q(SCHEMA)}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${q(SCHEMA)}"`);
    for (const stmt of PUBLIC_FLOOR) await admin.query(stmt);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const stmt of buildCreateStoreSchemaQueries(SCHEMA)) await admin.query(stmt.text);
    await admin.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified")
       VALUES ($1,$2,$3,$4,false) ON CONFLICT (id) DO NOTHING`,
      [PERSON, "w7reads", "w7reads", "w7reads@example.test"],
    );
    for (const org of [ORG, OTHER_ORG]) {
      await admin.query(
        `INSERT INTO public."organization" (id, slug, name, "createdAt")
         VALUES ($1,$1,$1, now()) ON CONFLICT (id) DO NOTHING`,
        [org],
      );
    }

    // Two artifact TYPES, each owned by its own package — which is what makes
    // "the types the calling extension declares as artifact dependencies" a
    // real distinction rather than a naming convention.
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    const def = (type: string) =>
      ({
        type,
        category: "content",
        schema: z.record(z.string(), z.unknown()),
        lifecycle: { states: ["active"], initial: "active", transitions: {} },
        renderers: {},
        isArtifact: true,
      }) as never;
    objectTypeRegistry.register(def(IDEA_TYPE), IDEA_PKG);
    objectTypeRegistry.register(def(POST_TYPE), POST_PKG);

    // Five ideas, one post, and one idea in ANOTHER organisation.
    for (let i = 1; i <= 5; i += 1) {
      await seedArtifact({
        id: `idea-${i}`,
        type: IDEA_TYPE,
        orgId: ORG,
        createdAt: `2026-08-2${i}T10:00:00Z`,
        text: `# idea ${i}\n\nthe body of idea ${i}\n`,
      });
    }
    await seedArtifact({
      id: "post-1",
      type: POST_TYPE,
      orgId: ORG,
      createdAt: "2026-08-26T10:00:00Z",
      text: "# a post\n",
    });
    await seedArtifact({
      id: "idea-other-org",
      type: IDEA_TYPE,
      orgId: OTHER_ORG,
      createdAt: "2026-08-27T10:00:00Z",
      text: "# not yours\n",
    });
  }, 180_000);

  afterAll(async () => {
    delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
    if (!admin) return;
    await admin.query(`DROP SCHEMA IF EXISTS "${q(SCHEMA)}" CASCADE`).catch(() => {});
    await admin.end().catch(() => {});
  });

  it("lists the artifacts of its DECLARED dependency, and nothing else", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    const page = await extensionArtifactsList(await readCtx(), { limit: 50 });
    expect(page.artifacts.map((a) => a.artifactId).sort()).toEqual([
      "idea-1",
      "idea-2",
      "idea-3",
      "idea-4",
      "idea-5",
    ]);
    // The post exists and is an artifact; it is simply not declared.
    expect(page.artifacts.some((a) => a.objectType === POST_TYPE)).toBe(false);
  });

  it("is bound to the organisation of the run", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    const page = await extensionArtifactsList(await readCtx(), { limit: 50 });
    expect(page.artifacts.some((a) => a.artifactId === "idea-other-org")).toBe(false);
    expect(page.artifacts.every((a) => a.organizationId === ORG)).toBe(true);
  });

  it("reads one artifact of the declared dependency, and its text up to the cap", async () => {
    const { extensionArtifactGet, extensionArtifactContentRead } = await import(
      "@/lib/artifacts/extension-artifact-reads"
    );
    const ctx = await readCtx();
    const got = await extensionArtifactGet(ctx, { artifactId: "idea-3" });
    expect(got.objectType).toBe(IDEA_TYPE);

    const content = await extensionArtifactContentRead(ctx, { artifactId: "idea-3" });
    expect(content.text).toBe("# idea 3\n\nthe body of idea 3\n");
    expect(content.truncated).toBe(false);
    expect(content.mime).toBe("text/markdown");

    const capped = await extensionArtifactContentRead(ctx, { artifactId: "idea-3", maxBytes: 8 });
    expect(capped.text).toBe("# idea 3");
    expect(capped.truncated).toBe(true);
    expect(capped.totalBytes).toBeGreaterThan(capped.bytesRead);
  });

  it("IS REFUSED FOR AN UNDECLARED KIND — on the list, the get and the content read", async () => {
    const { extensionArtifactsList, extensionArtifactGet, extensionArtifactContentRead } =
      await import("@/lib/artifacts/extension-artifact-reads");
    const ctx = await readCtx();
    await expect(extensionArtifactsList(ctx, { types: [POST_TYPE] })).rejects.toThrow(
      /does not declare .* as an artifact dependency/,
    );
    await expect(extensionArtifactGet(ctx, { artifactId: "post-1" })).rejects.toThrow(
      /does not declare/,
    );
    await expect(
      extensionArtifactContentRead(ctx, { artifactId: "post-1" }),
    ).rejects.toThrow(/does not declare/);
  });

  it("admits nothing at all to a caller that declares no artifact dependency", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    const page = await extensionArtifactsList(await readCtx([]), { limit: 50 });
    expect(page.artifacts).toEqual([]);
  });

  it("audits every read with the calling extension and the declaration it was admitted by", async () => {
    auditEvents.length = 0;
    const { extensionArtifactGet } = await import("@/lib/artifacts/extension-artifact-reads");
    const ctx = await readCtx();
    await extensionArtifactGet(ctx, { artifactId: "idea-1" });
    await extensionArtifactGet(ctx, { artifactId: "post-1" }).catch(() => {});
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[0]).toMatchObject({
      decision: "allowed",
      organizationId: ORG,
      runId: RUN_ID,
      resourceType: "artifact",
      operation: "artifacts_get",
    });
    expect((auditEvents[0]?.metadata as Record<string, unknown>).extension).toBe(CALLER);
    expect((auditEvents[0]?.metadata as Record<string, unknown>).declarationDigest).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(auditEvents[1]).toMatchObject({ decision: "denied" });
  });

  it("THE LISTING PAGES WITH A CURSOR — every row once, in order, no gap", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    const ctx = await readCtx();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const page: Awaited<ReturnType<typeof extensionArtifactsList>> =
        await extensionArtifactsList(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.artifacts.length).toBeLessThanOrEqual(2);
      seen.push(...page.artifacts.map((a) => a.artifactId));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    // Newest first, every row exactly once, nothing repeated and nothing lost.
    expect(seen).toEqual(["idea-5", "idea-4", "idea-3", "idea-2", "idea-1"]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(cursor).toBeNull();
  });

  it("a cursor from a page BEFORE a newer row still walks the rest without repeating one", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    const ctx = await readCtx();
    const first = await extensionArtifactsList(ctx, { limit: 2 });
    expect(first.artifacts.map((a) => a.artifactId)).toEqual(["idea-5", "idea-4"]);
    // A row lands between the two reads — the keyset means it changes no boundary.
    await seedArtifact({
      id: "idea-6",
      type: IDEA_TYPE,
      orgId: ORG,
      createdAt: "2026-08-28T10:00:00Z",
      text: "# idea 6\n",
    });
    const second = await extensionArtifactsList(ctx, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.artifacts.map((a) => a.artifactId)).toEqual(["idea-3", "idea-2"]);
    await admin.query(`DELETE FROM "${q(SCHEMA)}"."objects" WHERE id = 'idea-6'`);
  });

  it("refuses a cursor it did not write, rather than silently restarting", async () => {
    const { extensionArtifactsList } = await import("@/lib/artifacts/extension-artifact-reads");
    await expect(
      extensionArtifactsList(await readCtx(), { limit: 2, cursor: "not-a-cursor" }),
    ).rejects.toThrow(/is not a cursor this listing wrote/);
  });
});
