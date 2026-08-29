/**
 * cinatra#3030 (epic #3023 W6) — THE FILE PICKUP, on the real store.
 *
 * Plan sentences:
 *
 *   item 0.22, in full: "File pickup and file bindings: at terminal success
 *   every file in the run's `outputs` folder is an output — bound, when a
 *   binding names it as its content source (bindings gain a file source beside
 *   the output source, so an explicit dependency covers files too), or on the
 *   default road otherwise; the pickup streams the bytes once into the store,
 *   types them by item 0.18, re-validates against the target's accepted forms,
 *   and records one ledger row per file."
 *
 *   item 0.21: "[...] the terminal transition hands the pickup to that process
 *   through the outbox the derivation already uses [...] and a retention tier of
 *   its own — deleted after pickup plus a grace period".
 *
 * Proves, on a real database and a real disk:
 *   1. ACCEPTANCE 1 — a fixture agent's file in its run folder's outputs becomes
 *      an artifact by the DEFAULT ROAD, typed by the ladder, with one ledger row
 *      under the reserved file id;
 *   2. ACCEPTANCE 2 — a BOUND file lands under its declared extension;
 *   3. a file pattern fans out: one artifact per matching file, titled by the
 *      file name;
 *   4. the pickup writes the receipt the retention tier reads.
 *
 * REAL-store proof (no boundary stub at the write seam): the real writer
 * (`writeClaimedArtifact` -> `createSemanticArtifact` -> the materialization
 * ledger), the real claim registry, the real object registry, the real run
 * folder on disk. The controlled inputs are the two MANIFEST reads that are not
 * the seam — the run agent's declaration (handed in through the pickup's own
 * `loadContext` seam) and which packages are required-in-prod — plus the model
 * rung, which is injected so the suite never calls a model.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

type ContextFixture = {
  producesRefs: Array<{ extension: string; objectTypeId?: string }>;
  hasBindings: boolean;
  // The binding grammar's own type, reached through the collector's result shape.
  bindings: import("@cinatra-ai/agents/artifact-binding").CollectedArtifactBinding[];
};
const contextByTemplate = new Map<string, ContextFixture>();
const loadContext = async (input: { templateId: string; packageVersion: string | null }) =>
  contextByTemplate.get(input.templateId) ?? {
    producesRefs: [],
    hasBindings: false,
    bindings: [],
  };

const REQUIRED = new Set<string>();
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => REQUIRED.has(pkg),
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

const TEST_SCHEMA = "cinatra_test_run_folder_3030";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const S = () => q(TEST_SCHEMA);
const ORG = "org-3030-run-folder";

const TEXT_BASE = "@cinatra-ai/text:document";
const TEXT_BASE_EXT = "@cinatra-ai/text-artifact";
const MARKDOWN_BASE = "@cinatra-ai/markdown:document";
const MARKDOWN_BASE_EXT = "@cinatra-ai/markdown-artifact";
const BLOG_POST = "@cinatra-ai/blog:post";
const BLOG_POST_EXT = "@cinatra-ai/blog-post-artifact";

let client: Client;
let deriveMod: typeof import("../unbound-output-derivation");
let runFolder: typeof import("../run-folder");
let runRoot = "";

/** A markdown document the structural probes settle without a model. */
const MARKDOWN_DOC = [
  "# The run folder, and why an agent needed one",
  "",
  "- a file the agent wrote",
  "- a folder the pickup reads",
  "",
  "See [the notes](https://example.invalid/notes).",
  "",
  "x".repeat(1200),
].join("\n");

const NOTES_DOC = ["Plain notes about the pipeline.", "", "y".repeat(1500)].join("\n");

const neverAsk = vi.fn(async () => {
  throw new Error("the pickup reached the model rung on a row that must not");
});

async function seedTemplateAndRun(): Promise<{ templateId: string; runId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${S()}"."agent_templates" (id, name, source_nl, compiled_plan, input_schema, approval_policy, org_id, package_name)
     VALUES ($1, $2, 'test', '[]', '{}', '{"steps":[]}', $3, $4)`,
    [templateId, "A fixture agent that writes files", ORG, `@test/${templateId}`],
  );
  await client.query(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', 'completed', $3)`,
    [runId, templateId, ORG],
  );
  return { templateId, runId };
}

/** Write the files the fixture agent emitted, through the run folder's OWN write
 *  path — the same one the passthrough's file tool and the sandbox publish take. */
async function emitFiles(
  runId: string,
  files: ReadonlyArray<{ relPath: string; content: string }>,
): Promise<Array<{ relPath: string; byteLength: number }>> {
  const out: Array<{ relPath: string; byteLength: number }> = [];
  for (const file of files) {
    const written = await runFolder.writeRunOutputFile({
      orgId: ORG,
      runId,
      relPath: file.relPath,
      bytes: new TextEncoder().encode(file.content),
    });
    out.push({ relPath: written.relPath, byteLength: written.byteLength });
  }
  return out;
}

/** The outbox row the terminal transition writes — here carrying FILE items, by
 *  reference, exactly as the terminal capture records them. */
async function seedOutboxWithFiles(input: {
  runId: string;
  templateId: string;
  files: ReadonlyArray<{ relPath: string; byteLength: number }>;
}): Promise<void> {
  const { selectRunFilePickupItems } = await import(
    "@cinatra-ai/agents/end-node-output-pickup"
  );
  const items = selectRunFilePickupItems(input.files);
  await client.query(
    `INSERT INTO "${S()}"."agent_run_output_derivations"
       (run_id, org_id, template_id, package_version, created_by, content, content_is_json, content_hash, items, status)
     VALUES ($1, $2, $3, '1.2.3', NULL, NULL, false, NULL, $4::jsonb, 'pending')`,
    [input.runId, ORG, input.templateId, JSON.stringify(items)],
  );
}

async function ledgerRows(runId: string) {
  const r = await client.query(
    `SELECT output_id, path, extension, phase, artifact_id, decided_rung, decided_verdict
       FROM "${S()}"."artifact_materializations"
      WHERE run_id = $1 ORDER BY output_id ASC`,
    [runId],
  );
  return r.rows as Array<{
    output_id: string;
    path: string;
    extension: string;
    phase: string;
    artifact_id: string | null;
    decided_rung: string | null;
    decided_verdict: Record<string, unknown> | null;
  }>;
}

async function objectRow(artifactId: string) {
  const r = await client.query(
    `SELECT type, data FROM "${S()}"."objects" WHERE id = $1`,
    [artifactId],
  );
  return r.rows[0] as { type: string; data: Record<string, unknown> };
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

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3030-art-"));
  runRoot = mkdtempSync(path.join(tmpdir(), "cin-3030-runs-"));
  process.env.CINATRA_RUN_DATA_ROOT = runRoot;

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
  deriveMod = await import("../unbound-output-derivation");
  runFolder = await import("../run-folder");
  objectTypeRegistry._clearForTests();
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  objectTypeRegistry._clearForTests();
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  for (const root of [process.env.CINATRA_ARTIFACT_DATA_ROOT, runRoot]) {
    if (root) rmSync(root, { recursive: true, force: true });
  }
  delete process.env.CINATRA_RUN_DATA_ROOT;
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3030 — the file pickup (real store, real disk)", () => {
  it("ACCEPTANCE 1 — a fixture agent's file in its run folder's outputs becomes an artifact by the default road", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(MARKDOWN_BASE, MARKDOWN_BASE_EXT, ["text/markdown"]);
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain"]);
    REQUIRED.add(MARKDOWN_BASE_EXT);
    REQUIRED.add(TEXT_BASE_EXT);
    await seedActiveClaim(MARKDOWN_BASE, MARKDOWN_BASE_EXT);
    await seedActiveClaim(TEXT_BASE, TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    // The agent declares NOTHING: no binding, no produces. It writes two files.
    const files = await emitFiles(runId, [
      { relPath: "draft.md", content: MARKDOWN_DOC },
      { relPath: "notes/plain.txt", content: NOTES_DOC },
    ]);
    await seedOutboxWithFiles({ runId, templateId, files });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");

    // ONE LEDGER ROW PER FILE, under the reserved file id family.
    const rows = await ledgerRows(runId);
    expect(rows.map((r) => r.output_id)).toEqual([
      "cinatra:run-file:draft.md",
      "cinatra:run-file:notes/plain.txt",
    ]);
    for (const row of rows) {
      expect(row.path).toBe("default_road");
      expect(row.phase).toBe("finalized");
      expect(row.artifact_id).toBeTruthy();
      expect(row.decided_rung).toBeTruthy();
    }
    // TYPED BY THE LADDER, each under the base its form belongs to.
    const draft = rows.find((r) => r.output_id.endsWith("draft.md"))!;
    const notes = rows.find((r) => r.output_id.endsWith("plain.txt"))!;
    expect(draft.extension).toBe(MARKDOWN_BASE_EXT);
    expect((draft.decided_verdict as { form: string }).form).toBe("text/markdown");
    expect(notes.extension).toBe(TEXT_BASE_EXT);

    const drawn = await objectRow(draft.artifact_id!);
    expect(drawn.type).toBe(MARKDOWN_BASE);
    // The FILE NAME is the title of a file nothing declared a title for.
    expect(drawn.data.title).toBe("draft.md");
    expect(drawn.data.size).toBe(Buffer.byteLength(MARKDOWN_DOC, "utf8"));

    // THE PICKUP RECEIPT the retention tier reads (item 0.21).
    const receipt = await runFolder.readRunFolderPickup(runFolder.runFolderPath(ORG, runId));
    expect(receipt).toMatchObject({ files: 2 });
    expect(existsSync(runFolder.runOutputsPath(ORG, runId))).toBe(true);
  });

  it("ACCEPTANCE 2 — a bound file lands under its declared extension", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(MARKDOWN_BASE, MARKDOWN_BASE_EXT, ["text/markdown"]);
    registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
    REQUIRED.add(MARKDOWN_BASE_EXT);
    await seedActiveClaim(MARKDOWN_BASE, MARKDOWN_BASE_EXT);
    await seedActiveClaim(BLOG_POST, BLOG_POST_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    // The agent DECLARES the file: a binding names it as its content source.
    contextByTemplate.set(templateId, {
      producesRefs: [{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }],
      hasBindings: true,
      bindings: [
        {
          nodeId: "end",
          outputId: "post_file",
          binding: {
            extension: BLOG_POST_EXT,
            objectTypeId: BLOG_POST,
            fileFrom: "draft.md",
            declaredMime: "text/markdown",
            titleFromFirstLine: true,
          },
        },
      ],
    });
    const files = await emitFiles(runId, [{ relPath: "draft.md", content: MARKDOWN_DOC }]);
    await seedOutboxWithFiles({ runId, templateId, files });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");

    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(1);
    // THE BINDING'S OWN LEDGER IDENTITY and path — not the default road's.
    expect(rows[0]).toMatchObject({
      output_id: "post_file",
      path: "end_node_binding",
      extension: BLOG_POST_EXT,
      phase: "finalized",
    });
    const drawn = await objectRow(rows[0]!.artifact_id!);
    // UNDER ITS DECLARED EXTENSION, not the form's base.
    expect(drawn.type).toBe(BLOG_POST);
    // The declared first-line title source.
    expect(drawn.data.title).toBe("The run folder, and why an agent needed one");
  });

  it("a file pattern fans out: one artifact per matching file, titled by the file name", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(MARKDOWN_BASE, MARKDOWN_BASE_EXT, ["text/markdown"]);
    registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
    REQUIRED.add(MARKDOWN_BASE_EXT);
    await seedActiveClaim(MARKDOWN_BASE, MARKDOWN_BASE_EXT);
    await seedActiveClaim(BLOG_POST, BLOG_POST_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    contextByTemplate.set(templateId, {
      producesRefs: [{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }],
      hasBindings: true,
      bindings: [
        {
          nodeId: "end",
          outputId: "posts",
          binding: {
            extension: BLOG_POST_EXT,
            objectTypeId: BLOG_POST,
            filePattern: "posts/*.md",
            declaredMime: "text/markdown",
          },
        },
      ],
    });
    const files = await emitFiles(runId, [
      { relPath: "posts/first.md", content: `# First\n\n${"a".repeat(1100)}` },
      { relPath: "posts/second.md", content: `# Second\n\n${"b".repeat(1100)}` },
      // Outside the pattern: it takes the default road instead.
      { relPath: "aside.md", content: MARKDOWN_DOC },
    ]);
    await seedOutboxWithFiles({ runId, templateId, files });

    await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );

    const rows = await ledgerRows(runId);
    expect(rows.map((r) => r.output_id).sort()).toEqual([
      "cinatra:run-file:aside.md",
      "posts#posts/first.md",
      "posts#posts/second.md",
    ]);
    const bound = rows.filter((r) => r.path === "end_node_binding");
    expect(bound).toHaveLength(2);
    for (const row of bound) {
      expect(row.extension).toBe(BLOG_POST_EXT);
      const drawn = await objectRow(row.artifact_id!);
      expect(drawn.type).toBe(BLOG_POST);
      expect(String(drawn.data.title)).toMatch(/^(first|second)\.md$/);
    }
    // The unmatched file still took the DEFAULT ROAD — and there the per-output
    // ladder of item 0.17 runs in its own order: no binding names it, so the
    // AGENT'S DECLARED KIND claims it before the form's base ever would.
    const unbound = rows.find((r) => r.output_id === "cinatra:run-file:aside.md")!;
    expect(unbound.path).toBe("default_road");
    expect(unbound.extension).toBe(BLOG_POST_EXT);
    expect(MARKDOWN_BASE_EXT).not.toBe(BLOG_POST_EXT);
  });

  it("a file whose bytes are NOT UTF-8 text is a RECORDED verdict, never a transcoded artifact", async () => {
    // The convergence round's adopted finding. `Buffer.toString("utf8")` never
    // fails: it substitutes U+FFFD for every byte it cannot decode, so a picture
    // left in the outputs folder would silently become an artifact holding bytes
    // the agent did not write, indistinguishable from a good one. This slice
    // deliberately stops short of pictures (W8 brings them), so the honest answer
    // is a refusal ON THE ROW.
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(MARKDOWN_BASE, MARKDOWN_BASE_EXT, ["text/markdown"]);
    REQUIRED.add(MARKDOWN_BASE_EXT);
    await seedActiveClaim(MARKDOWN_BASE, MARKDOWN_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const written = await runFolder.writeRunOutputFile({
      orgId: ORG,
      runId,
      relPath: "hero.png",
      bytes: png,
    });
    await seedOutboxWithFiles({
      runId,
      templateId,
      files: [{ relPath: written.relPath, byteLength: written.byteLength }],
    });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("no_match");
    const row = await client.query(
      `SELECT detail FROM "${S()}"."agent_run_output_derivations" WHERE run_id = $1`,
      [runId],
    );
    const detail = row.rows[0]?.detail as { outcomes?: Array<Record<string, unknown>> };
    expect(detail.outcomes?.[0]).toMatchObject({
      status: "no_target",
      refusal: { reason: "not_utf8" },
    });
    // No artifact, no ledger row — and the file itself is untouched on disk, so
    // the retention tier still governs it and W8 can pick it up on its own road.
    expect(await ledgerRows(runId)).toEqual([]);
    const stillThere = await runFolder.listRunOutputFiles({ orgId: ORG, runId });
    expect(stillThere.map((f) => f.relPath)).toEqual(["hero.png"]);
  });

  it("a file that is gone by the time the pickup reads is a RECORDED verdict, not a failure", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(MARKDOWN_BASE, MARKDOWN_BASE_EXT, ["text/markdown"]);
    REQUIRED.add(MARKDOWN_BASE_EXT);
    await seedActiveClaim(MARKDOWN_BASE, MARKDOWN_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    await seedOutboxWithFiles({
      runId,
      templateId,
      files: [{ relPath: "vanished.md", byteLength: 2048 }],
    });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("no_match");
    const row = await client.query(
      `SELECT status, detail FROM "${S()}"."agent_run_output_derivations" WHERE run_id = $1`,
      [runId],
    );
    const detail = row.rows[0]?.detail as { outcomes?: Array<Record<string, unknown>> };
    expect(detail.outcomes?.[0]).toMatchObject({
      status: "no_target",
      refusal: { reason: "file_missing" },
    });
    expect(await ledgerRows(runId)).toEqual([]);
  });
});
