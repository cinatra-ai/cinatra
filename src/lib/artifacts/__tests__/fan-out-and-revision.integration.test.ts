/**
 * cinatra#3030 (epic #3023 W6) — THE FAN-OUT and THE MID-RUN REVISION, on the
 * real store.
 *
 * Plan sentences:
 *
 *   item 0.27, in full: "Fan-out bindings: a binding may declare that its output
 *   is a list whose members are each an artifact, or that its content source is
 *   a file pattern in the run folder's outputs; the materializer writes one
 *   artifact per member or per matching file; a member's ledger identity is the
 *   list output's id with the member's position, so the ledger's key of run,
 *   output, extension and content still holds; every member is its own artifact,
 *   duplicates included — two identical members are two artifacts over one blob,
 *   as the content-addressed store already works; a title comes from a declared
 *   member field, from the first line of a text member — a new title source the
 *   binding grammar gains, since a binding names a title output today — or from
 *   the file name; the same produced event per artifact."
 *
 *   item 0.30: "Same-artifact revision through the materialize step: a mid-run
 *   write may name an existing artifact and append its next revision instead of
 *   creating a new one — a compare-and-set against the revision the caller read,
 *   the same ledger row and produced event [...] The append's produced event
 *   carries the live-generator origin, which the review policy maps to
 *   intermediate and skips by default; [...] the caller's own declared gate is
 *   recorded as the review of those revisions [...]"
 *
 *   §8.3: "a save that names a base another save has already built on fails on
 *   that index, which is the compare-and-set".
 *
 * REAL-store proof: the real materializer, the real write path, the real
 * append-only representation table with its unique index, the real ledger and
 * the real produced-event outbox. The ONE controlled input is the package
 * MANIFEST read (the registry), which is not the seam under test.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

const BLOG_IDEA = "@cinatra-ai/blog:idea";
const BLOG_IDEA_EXT = "@cinatra-ai/blog-idea-artifact";
const BLOG_POST = "@cinatra-ai/blog:post";
const BLOG_POST_EXT = "@cinatra-ai/blog-post-artifact";

/** The package manifest + OAS the run's template resolves to. Controlled per
 *  package name: a registry read, never the write seam. */
const packages = new Map<string, { manifest: Record<string, unknown>; payload: unknown }>();
vi.mock("@cinatra-ai/registries", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgentPackage: async (input: { packageName: string }) => {
    const pkg = packages.get(input.packageName);
    if (!pkg) throw new Error(`no fixture package for ${input.packageName}`);
    return pkg;
  },
}));
vi.mock("@/lib/verdaccio-config", () => ({
  loadVerdaccioConfigForReads: async () => ({ registryUrl: "http://127.0.0.1:0" }),
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: async () => {},
  createNotification: async () => {},
  markNotificationRead: async () => {},
  markNotificationUnread: async () => {},
  markAllNotificationsRead: async () => {},
  markNotificationsReadByHrefPrefix: async () => {},
  markNotificationsReadThrough: async () => {},
  listNotifications: async () => [],
  listNotificationsForUserId: () => [],
  listNotificationsKeysetForUserId: () => ({ items: [], nextBefore: null }),
}));

const TEST_SCHEMA = "cinatra_test_fanout_revision_3030";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const S = () => q(TEST_SCHEMA);
const ORG = "org-3030-fanout";

let client: Client;
let materializer: typeof import("../run-artifact-materializer");
let appendMod: typeof import("../artifact-revision-append");

/** An OAS document with ONE end node carrying one annotated output. */
function oasWithBinding(outputName: string, binding: Record<string, unknown>) {
  return {
    $referenced_components: {
      end: {
        component_type: "EndNode",
        outputs: [
          { title: outputName, cinatra: { artifact: binding } },
          { title: "title", cinatra: {} },
        ],
      },
    },
  };
}

async function seedTemplateAndRun(input: {
  packageName: string;
  hasBindings: boolean;
}): Promise<{ templateId: string; runId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${S()}"."agent_templates"
       (id, name, source_nl, compiled_plan, input_schema, approval_policy, org_id, package_name, package_version, has_artifact_bindings)
     VALUES ($1, $2, 'test', '[]', '{}', '{"steps":[]}', $3, $4, '1.2.3', $5)`,
    [templateId, "A fixture agent", ORG, input.packageName, input.hasBindings],
  );
  await client.query(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', 'completed', $3)`,
    [runId, templateId, ORG],
  );
  return { templateId, runId };
}

function registerArtifactType(typeId: string, extension: string, mimeTypes: string[]) {
  objectTypeRegistry.register(
    {
      type: typeId,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    extension,
  );
}

async function seedActiveClaim(typeId: string, extension: string) {
  await client.query(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)
     ON CONFLICT DO NOTHING`,
    [
      `claim-${randomUUID()}`,
      `org:${ORG}`,
      typeId,
      extension,
      JSON.stringify({ projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" }),
    ],
  );
}

async function ledgerRows(runId: string) {
  const r = await client.query(
    `SELECT output_id, path, extension, phase, artifact_id, representation_revision_id, content_hash
       FROM "${S()}"."artifact_materializations" WHERE run_id = $1 ORDER BY output_id ASC`,
    [runId],
  );
  return r.rows as Array<{
    output_id: string;
    path: string;
    extension: string;
    phase: string;
    artifact_id: string;
    representation_revision_id: string | null;
    content_hash: string;
  }>;
}

async function representations(artifactId: string) {
  const r = await client.query(
    `SELECT id, revision, resource_id FROM "${S()}"."representation"
      WHERE artifact_id = $1 ORDER BY revision ASC`,
    [artifactId],
  );
  return r.rows as Array<{ id: string; revision: number; resource_id: string }>;
}

async function producedEvents(artifactId: string) {
  const r = await client.query(
    `SELECT emitter, origin_kind, producer_run_id, representation_revision_id
       FROM "${S()}"."artifact_produced_outbox" WHERE artifact_id = $1 ORDER BY created_at ASC`,
    [artifactId],
  );
  return r.rows as Array<{
    emitter: string;
    origin_kind: string;
    producer_run_id: string | null;
    representation_revision_id: string;
  }>;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3030-fan-"));

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  client = new Client({ connectionString: DB_URL });
  await client.connect();
  materializer = await import("../run-artifact-materializer");
  appendMod = await import("../artifact-revision-append");
  objectTypeRegistry._clearForTests();
  registerArtifactType(BLOG_IDEA, BLOG_IDEA_EXT, ["text/plain", "text/markdown", "application/json"]);
  registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
  await seedActiveClaim(BLOG_IDEA, BLOG_IDEA_EXT);
  await seedActiveClaim(BLOG_POST, BLOG_POST_EXT);
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  objectTypeRegistry._clearForTests();
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3030 — the fan-out (real store)", () => {
  it("ACCEPTANCE 3 — a list output fans out to one artifact per member with the first line as the title", async () => {
    const packageName = `@test/ideas-${randomUUID()}`;
    packages.set(packageName, {
      manifest: { cinatra: { produces: [{ extension: BLOG_IDEA_EXT, objectTypeId: BLOG_IDEA }] } },
      payload: oasWithBinding("ideas", {
        extension: BLOG_IDEA_EXT,
        objectTypeId: BLOG_IDEA,
        contentFrom: "ideas",
        membersAreArtifacts: true,
        titleFromFirstLine: true,
        declaredMime: "text/plain",
      }),
    });
    const { templateId, runId } = await seedTemplateAndRun({ packageName, hasBindings: true });
    materializer.__resetRunPackageBindingsCacheForTests();

    const outcomes = await materializer.materializeRunArtifacts({
      runId,
      orgId: ORG,
      templateId,
      packageVersion: "1.2.3",
      createdBy: null,
      endNodeOutputs: {
        ideas: [
          "Why migrations are the hardest part of self-hosting\n\nA whole idea in a member.",
          "What an artifact is, and what it is not\n\nAnother one.",
          // TWO IDENTICAL MEMBERS: two artifacts over one blob.
          "A repeated idea\n\nsame bytes",
          "A repeated idea\n\nsame bytes",
        ],
        title: "the batch",
      },
    });

    expect(outcomes.every((o) => o.ok)).toBe(true);
    expect(outcomes).toHaveLength(4);
    // A MEMBER'S LEDGER IDENTITY: the list output's id with the member's position.
    expect(outcomes.map((o) => o.outputId)).toEqual([
      "ideas#0",
      "ideas#1",
      "ideas#2",
      "ideas#3",
    ]);

    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(4);
    const artifactIds = new Set(rows.map((r) => r.artifact_id));
    // EVERY MEMBER IS ITS OWN ARTIFACT, DUPLICATES INCLUDED.
    expect(artifactIds.size).toBe(4);

    // The two identical members are two artifacts over ONE content-addressed blob.
    const dupes = rows.filter((r) => r.output_id === "ideas#2" || r.output_id === "ideas#3");
    expect(dupes[0]?.content_hash).toBe(dupes[1]?.content_hash);
    const resourceIds = new Set<string>();
    for (const row of dupes) {
      const reps = await representations(row.artifact_id);
      expect(reps).toHaveLength(1);
      resourceIds.add(reps[0]!.resource_id);
    }
    expect(resourceIds.size).toBe(1);

    // THE FIRST LINE OF EACH TEXT MEMBER IS ITS TITLE.
    const titles = new Set<string>();
    for (const row of rows) {
      const r = await client.query(`SELECT type, data FROM "${S()}"."objects" WHERE id = $1`, [
        row.artifact_id,
      ]);
      const drawn = r.rows[0] as { type: string; data: Record<string, unknown> };
      expect(drawn.type).toBe(BLOG_IDEA);
      titles.add(String(drawn.data.title));
    }
    expect(titles).toEqual(
      new Set([
        "Why migrations are the hardest part of self-hosting",
        "What an artifact is, and what it is not",
        "A repeated idea",
      ]),
    );

    // THE SAME PRODUCED EVENT PER ARTIFACT.
    for (const row of rows) {
      const events = await producedEvents(row.artifact_id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ emitter: "createSemanticArtifact", producer_run_id: runId });
    }
  });

  it("a member that resolves to nothing fails visibly, and its siblings still land", async () => {
    const packageName = `@test/ideas-${randomUUID()}`;
    packages.set(packageName, {
      manifest: { cinatra: { produces: [{ extension: BLOG_IDEA_EXT, objectTypeId: BLOG_IDEA }] } },
      payload: oasWithBinding("ideas", {
        extension: BLOG_IDEA_EXT,
        objectTypeId: BLOG_IDEA,
        contentFrom: "ideas",
        membersAreArtifacts: true,
        titleFromMemberField: "title",
        declaredMime: "application/json",
      }),
    });
    const { templateId, runId } = await seedTemplateAndRun({ packageName, hasBindings: true });
    materializer.__resetRunPackageBindingsCacheForTests();

    const outcomes = await materializer.materializeRunArtifacts({
      runId,
      orgId: ORG,
      templateId,
      packageVersion: "1.2.3",
      createdBy: null,
      endNodeOutputs: {
        ideas: [{ title: "a titled member", body: "text" }, { body: "no title here" }],
        title: "the batch",
      },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]?.ok).toBe(true);
    expect(outcomes[1]?.ok).toBe(false);
    if (outcomes[1]?.ok === false) {
      expect(outcomes[1].error).toContain("titleFromMemberField");
      expect(outcomes[1].outputId).toBe("ideas#1");
    }
  });
});

describe.skipIf(!HAS_DB)("cinatra#3030 — the mid-run revision (real store)", () => {
  /** Create the artifact a mid-run write will revise, through the ordinary
   *  binding road, and hand back its first revision. */
  async function seedArtifact(): Promise<{
    runId: string;
    artifactId: string;
    firstRevisionId: string;
  }> {
    const packageName = `@test/post-${randomUUID()}`;
    packages.set(packageName, {
      manifest: { cinatra: { produces: [{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }] } },
      payload: oasWithBinding("draft", {
        extension: BLOG_POST_EXT,
        objectTypeId: BLOG_POST,
        contentFrom: "draft",
        titleFrom: "title",
        declaredMime: "text/markdown",
      }),
    });
    const { templateId, runId } = await seedTemplateAndRun({ packageName, hasBindings: true });
    materializer.__resetRunPackageBindingsCacheForTests();
    const outcomes = await materializer.materializeRunArtifacts({
      runId,
      orgId: ORG,
      templateId,
      packageVersion: "1.2.3",
      createdBy: null,
      endNodeOutputs: { draft: "# A draft another agent wrote\n\nbody", title: "A draft" },
    });
    const first = outcomes[0];
    if (!first || first.ok !== true) throw new Error("the fixture artifact was not written");
    return {
      runId,
      artifactId: first.artifactId,
      firstRevisionId: first.representationRevisionId,
    };
  }

  it("ACCEPTANCE 4 — a mid-run revision append REFUSES a stale base", async () => {
    const { runId, artifactId, firstRevisionId } = await seedArtifact();

    // Two mid-run writes both read revision 1.
    const winner = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "place_pictures",
      artifactId,
      baseRepresentationRevisionId: firstRevisionId,
      content: "# A draft another agent wrote\n\nbody, with a picture placed",
      mime: "text/markdown",
      createdBy: null,
      extension: BLOG_POST_EXT,
      declaredReviewTaskId: "review:blog-post",
    });
    expect(winner).toMatchObject({ ok: true, revision: 2 });

    const loser = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "place_more_pictures",
      artifactId,
      // STILL revision 1 — the base another save has already built on.
      baseRepresentationRevisionId: firstRevisionId,
      content: "# A draft another agent wrote\n\nbody, with a different picture",
      mime: "text/markdown",
      createdBy: null,
      extension: BLOG_POST_EXT,
    });
    expect(loser).toMatchObject({ ok: false, reason: "stale_base" });

    // The artifact carries exactly TWO revisions: the draft and the append.
    const reps = await representations(artifactId);
    expect(reps.map((r) => r.revision)).toEqual([1, 2]);

    // The refused append left NO ledger row finalized and NO produced event.
    const events = await producedEvents(artifactId);
    expect(events).toHaveLength(2);
    // THE APPEND'S PRODUCED EVENT carries the live-generator origin, which the
    // policy maps to INTERMEDIATE and skips by default.
    expect(events[1]).toMatchObject({
      emitter: "artifact_revision_append",
      origin_kind: "intermediate",
      producer_run_id: runId,
    });
    expect(events[0]).toMatchObject({ emitter: "createSemanticArtifact" });

    // THE CALLER'S OWN DECLARED GATE is recorded as the review of that revision.
    const satisfaction = await client.query(
      `SELECT run_id, review_task_id FROM "${S()}"."artifact_revision_review_satisfaction"
        WHERE org_id = $1 AND artifact_id = $2`,
      [ORG, artifactId],
    );
    expect(satisfaction.rows).toHaveLength(1);
    expect(satisfaction.rows[0]).toMatchObject({
      run_id: runId,
      review_task_id: "review:blog-post",
    });
    if (winner.ok) {
      expect(
        appendMod.readRevisionGateSatisfaction({
          orgId: ORG,
          artifactId,
          representationRevisionId: winner.representationRevisionId,
        }),
      ).toMatchObject({ reviewTaskId: "review:blog-post", runId });
    }
  });

  it("refuses a base that is not a revision of that artifact, and one for an artifact that is not there", async () => {
    const { runId, artifactId } = await seedArtifact();
    const other = await seedArtifact();

    const wrongBase = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "n1",
      artifactId,
      baseRepresentationRevisionId: other.firstRevisionId,
      content: "# not this artifact's base\n\nbody",
      mime: "text/markdown",
      createdBy: null,
      extension: BLOG_POST_EXT,
    });
    expect(wrongBase).toMatchObject({ ok: false, reason: "unknown_base" });

    const noArtifact = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "n2",
      artifactId: randomUUID(),
      baseRepresentationRevisionId: other.firstRevisionId,
      content: "# nothing to revise\n\nbody",
      mime: "text/markdown",
      createdBy: null,
      extension: BLOG_POST_EXT,
    });
    expect(noArtifact).toMatchObject({ ok: false, reason: "artifact_not_found" });
  });

  it("appends the SAME ledger row and produced event, and a re-drive of one node is idempotent", async () => {
    const { runId, artifactId, firstRevisionId } = await seedArtifact();
    const append = {
      orgId: ORG,
      runId,
      nodeId: "place_pictures",
      artifactId,
      baseRepresentationRevisionId: firstRevisionId,
      content: "# A draft another agent wrote\n\nbody, with a picture placed",
      mime: "text/markdown",
      createdBy: null,
      extension: BLOG_POST_EXT,
    };
    const first = await appendMod.appendArtifactRevision(append);
    const again = await appendMod.appendArtifactRevision(append);
    expect(first).toMatchObject({ ok: true, revision: 2, deduped: false });
    expect(again).toMatchObject({ ok: true, revision: 2, deduped: true });
    expect(await representations(artifactId)).toHaveLength(2);

    const rows = await ledgerRows(runId);
    const appendRow = rows.find((r) => r.output_id === "place_pictures");
    expect(appendRow).toMatchObject({ path: "materialize_tool", phase: "finalized" });
    if (first.ok) {
      expect(appendRow?.representation_revision_id).toBe(first.representationRevisionId);
    }
  });

  it("refuses a form the artifact's type does not accept", async () => {
    const { runId, artifactId, firstRevisionId } = await seedArtifact();
    const refused = await appendMod.appendArtifactRevision({
      orgId: ORG,
      runId,
      nodeId: "n3",
      artifactId,
      baseRepresentationRevisionId: firstRevisionId,
      content: JSON.stringify({ not: "markdown" }),
      mime: "application/json",
      createdBy: null,
      extension: BLOG_POST_EXT,
    });
    expect(refused).toMatchObject({ ok: false, reason: "accepts_mismatch" });
    expect(await representations(artifactId)).toHaveLength(1);
  });
});
