/**
 * cinatra#3029 (epic #3023 W5) — THE DEFAULT ROAD, on the real store.
 *
 * This file replaces `unbound-output-derivation.integration.test.ts`, whose
 * subject — the produces-scoped derivation of the run's final RESPONSE TEXT and
 * its "Agent output not captured" advisory — is RETIRED by item 0.17. What is
 * proved here is what replaced it.
 *
 * Plan sentence (item 0.17, in full): "The default road: the post-terminal
 * pickup stops dropping undeclared work. Today an output with no declared target
 * is advised and dropped, the job reads only the final response text, and one
 * bound output switches derivation off for the whole agent. After: the pickup
 * runs once per emitted file and once per end-node output at or above the
 * document floor, applies the per-output ladder of section 3 — binding, then the
 * agent's declared kind, then the form's base, then the binary base — writes
 * through the one path with one ledger row per item under a reserved id that
 * cannot collide with a node id, dedupes identical bytes within the run, emits
 * the produced event and enqueues the meaning match; the response-text
 * derivation and the 'not captured' advisory retire."
 *
 * REAL-store proof (no boundary stub at the write seam): the real writer
 * (`writeClaimedArtifact` -> `createSemanticArtifact` -> the materialization
 * ledger), the real claim registry, the real object registry, real disk. The
 * ONLY controlled inputs are two MANIFEST reads that are not the seam — the run
 * agent's declared `produces`, and which packages are required-in-prod — plus
 * the model rung, which is injected so the suite never calls a model.
 *
 * Proves:
 *   1. ACCEPTANCE 1 — a fixture agent's undeclared end-node outputs above the
 *      floor become artifacts of the RIGHT BASE, with the DECIDING RUNG and the
 *      verdict on their ledger rows;
 *   2. ACCEPTANCE 2 — an item family with nothing above the floor takes no road:
 *      no ledger row, no artifact (the floor itself is proved where it is
 *      applied, in packages/agents/src/__tests__/end-node-output-pickup.test.ts);
 *   3. ACCEPTANCE 3 — response text takes no road: a row captured by the RETIRED
 *      core settles without writing anything AND without a notification;
 *   4. ACCEPTANCE 4 — undetectable bytes land under the BINARY BASE, and while
 *      no binary base is installed the refusal is RECORDED rather than guessed;
 *   5. the per-output ladder's declared-kind rung wins over the form's base;
 *   6. identical bytes in one run are ONE artifact with TWO ledger rows;
 *   7. a partially bound agent no longer loses its unbound work.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided
 * (CINATRA_DB_INTEGRATION_TESTS=1).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

// The produces SOURCE (a registry manifest read) is controlled per-template and
// handed in through the pickup's OWN `loadContext` seam — no module mock, so the
// write seam (writeClaimedArtifact -> createSemanticArtifact -> the
// materialization ledger) is the REAL one, imported once, with no partial-mock
// graph standing between the suite and the store.
const contextByTemplate = new Map<
  string,
  { producesRefs: Array<{ extension: string; objectTypeId?: string }>; hasBindings: boolean }
>();
const loadContext = async (input: { templateId: string; packageVersion: string | null }) =>
  contextByTemplate.get(input.templateId) ?? { producesRefs: [], hasBindings: false };
// Which packages are REQUIRED-in-prod is manifest DATA, not the seam — it is the
// domain of the form-base rung. Controlled so this suite's fixture bases are the
// required set, exactly as `selectRequiredArtifactUploadCandidates` reads it.
const REQUIRED = new Set<string>();
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => REQUIRED.has(pkg),
}));
// The heavy app-boot registrar must not clobber the types this suite registers.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// THE NOTIFICATION CHANNEL, cut at the module boundary. The pickup no longer
// reaches it — the "Agent output not captured" advisory RETIRES with item 0.17,
// and that retirement is asserted directly in
// `./response-text-derivation-retired.test.ts`. It is stubbed here for the same
// reason the retired suite stubbed it: the real module drags a large host graph
// (down to the MCP instruction builder) into a suite whose subject is the
// artifact store, and a spy that is never called is the cheapest way to keep
// that graph out.
const notificationCalls: Array<Record<string, unknown>> = [];
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: async (
    _recipient: Record<string, unknown>,
    record: Record<string, unknown>,
  ) => {
    notificationCalls.push(record);
  },
  createNotification: async (record: Record<string, unknown>) => {
    notificationCalls.push(record);
  },
  markNotificationRead: async () => {},
  markNotificationUnread: async () => {},
  markAllNotificationsRead: async () => {},
  markNotificationsReadByHrefPrefix: async () => {},
  markNotificationsReadThrough: async () => {},
  listNotifications: async () => [],
  listNotificationsForUserId: () => [],
  listNotificationsKeysetForUserId: () => ({ items: [], nextBefore: null }),
}));

const TEST_SCHEMA = "cinatra_test_default_road_3029";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-3029-default-road";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const S = () => q(TEST_SCHEMA);

const TEXT_BASE = "@cinatra-ai/text:document";
const TEXT_BASE_EXT = "@cinatra-ai/text-artifact";
const JSON_BASE = "@cinatra-ai/json:document";
const JSON_BASE_EXT = "@cinatra-ai/json-artifact";
const BINARY_BASE = "@cinatra-ai/binary:file";
const BINARY_BASE_EXT = "@cinatra-ai/binary-artifact";
const BLOG_POST = "@cinatra-ai/blog:post";
const BLOG_POST_EXT = "@cinatra-ai/blog-post-artifact";

let client: Client;
let deriveMod: typeof import("../unbound-output-derivation");
let pickupMod: typeof import("../default-road-pickup");
// The CANONICAL install road, the one the product uses — this suite creates
// its fixture install rows through the lifecycle primitive, never a raw write.
let lifecycle: typeof import("@cinatra-ai/extensions/lifecycle-primitive");

/** A markdown document comfortably over the one-kilobyte document floor. */
const MARKDOWN_DOC = [
  "# Why migrations are the hardest part of self-hosting",
  "",
  "- the schema moves",
  "- the data does not",
  "",
  "See [the notes](https://example.invalid/notes).",
  "",
  "x".repeat(1200),
].join("\n");

const JSON_DOC = JSON.stringify({
  ideas: Array.from({ length: 60 }, (_, i) => ({ id: i, title: `idea number ${i}` })),
});

/** Bytes nobody can name: NUL-bearing in the sniffer's head window, no
 *  signature, not text — the ladder's binary fallback is the only rung left.
 *
 *  WHY THE TWO ACCEPTANCE-4 CASES BELOW DRIVE THE PICKUP DIRECTLY. Postgres
 *  refuses a NUL inside a `text`/`jsonb` value, so bytes like these cannot pass
 *  through the outbox row at all — which is not a gap in the road but a fact
 *  about it: an end-node output is a serialisable VALUE, so its bytes are always
 *  UTF-8 text and the binary rung is unreachable from that half of the road.
 *  Undetectable bytes arrive as FILES, and files are #3030 (W6). These two cases
 *  therefore hand the item straight to the pickup — the REAL ladder, the REAL
 *  write path, the REAL ledger and the REAL store — and skip only the outbox
 *  row, which is the one thing that cannot carry them. */
const UNNAMEABLE = "\u0000\u0001\u0002\u0003" + " binary payload".repeat(120);

type Item = {
  outputId: string;
  outputName: string;
  source: "end_node_output";
  content: string;
  contentIsJson: boolean;
  contentHash: string;
  byteLength: number;
};

function item(outputName: string, content: string, contentIsJson = false): Item {
  return {
    outputId: `cinatra:run-output:${outputName}`,
    outputName,
    source: "end_node_output",
    content,
    contentIsJson,
    contentHash: sha(content),
    byteLength: Buffer.byteLength(content, "utf8"),
  };
}

async function seedTemplateAndRun(): Promise<{ templateId: string; runId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  await client.query(
    `INSERT INTO "${S()}"."agent_templates" (id, name, source_nl, compiled_plan, input_schema, approval_policy, org_id, package_name)
     VALUES ($1, $2, 'test', '[]', '{}', '{"steps":[]}', $3, $4)`,
    [templateId, "Blog draft writer", ORG, `@test/${templateId}`],
  );
  await client.query(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', 'completed', $3)`,
    [runId, templateId, ORG],
  );
  return { templateId, runId };
}

/** Insert the outbox row the terminal transition writes (the pickup's INPUT).
 *  `items: null` reproduces a row captured by the RETIRED core. */
async function seedOutbox(input: {
  runId: string;
  templateId: string;
  items: Item[] | null;
  legacyContent?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO "${S()}"."agent_run_output_derivations"
       (run_id, org_id, template_id, package_version, created_by, content, content_is_json, content_hash, items, status)
     VALUES ($1, $2, $3, '1.2.3', NULL, $4, false, $5, $6::jsonb, 'pending')`,
    [
      input.runId,
      ORG,
      input.templateId,
      input.legacyContent ?? null,
      input.legacyContent ? sha(input.legacyContent) : null,
      input.items === null ? null : JSON.stringify(input.items),
    ],
  );
}

async function outboxRow(runId: string) {
  const r = await client.query(
    `SELECT status, detail FROM "${S()}"."agent_run_output_derivations" WHERE run_id = $1`,
    [runId],
  );
  return r.rows[0] as { status: string; detail: Record<string, unknown> | null } | undefined;
}

async function ledgerRows(runId: string) {
  const r = await client.query(
    `SELECT output_id, path, extension, phase, artifact_id, representation_revision_id,
            decided_rung, decided_verdict
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
    representation_revision_id: string | null;
    decided_rung: string | null;
    decided_verdict: Record<string, unknown> | null;
  }>;
}

async function objectTypeOf(artifactId: string): Promise<string> {
  const r = await client.query(`SELECT type FROM "${S()}"."objects" WHERE id = $1`, [artifactId]);
  return String(r.rows[0]?.type);
}

async function producedEventsFor(runId: string) {
  const r = await client.query(
    `SELECT artifact_id, producing_extension, producing_extension_version
       FROM "${S()}"."artifact_produced_outbox" WHERE producer_run_id = $1`,
    [runId],
  );
  return r.rows as Array<{
    artifact_id: string;
    producing_extension: string | null;
    producing_extension_version: string | null;
  }>;
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
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [
      `claim-${randomUUID()}`,
      `org:${ORG}`,
      typeId,
      extension,
      JSON.stringify({ projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" }),
    ],
  );
}

/** The model rung, injected. It THROWS if reached on a row that must be settled
 *  above it — the suite never calls a model, and never silently could. */
const neverAsk = vi.fn(async () => {
  throw new Error("the pickup reached the model rung on a row that must not");
});

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3029-"));

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
  pickupMod = await import("../default-road-pickup");
  lifecycle = await import("@cinatra-ai/extensions/lifecycle-primitive");
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
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("cinatra#3029 — the default road (real store)", () => {
  it("ACCEPTANCE 1 — undeclared end-node outputs above the floor become artifacts of the right base, with the deciding rung on their ledger rows", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(JSON_BASE, JSON_BASE_EXT, ["application/json"]);
    REQUIRED.add(TEXT_BASE_EXT);
    REQUIRED.add(JSON_BASE_EXT);
    await seedActiveClaim(TEXT_BASE, TEXT_BASE_EXT);
    await seedActiveClaim(JSON_BASE, JSON_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    // The agent declares NOTHING — no binding, no produces.
    await seedOutbox({
      runId,
      templateId,
      items: [item("draft", MARKDOWN_DOC), item("ideas", JSON_DOC, true)],
    });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");

    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(2);
    // ONE LEDGER ROW PER ITEM, under the reserved id family.
    expect(rows.map((r) => r.output_id)).toEqual([
      "cinatra:run-output:draft",
      "cinatra:run-output:ideas",
    ]);
    for (const r of rows) {
      expect(r.path).toBe("default_road");
      expect(r.phase).toBe("finalized");
      expect(r.artifact_id).toBeTruthy();
      // THE DECIDING RUNG AND ITS VERDICT, on the row.
      expect(r.decided_rung).toBe("structural");
      expect(r.decided_verdict).toMatchObject({ rung: "structural" });
      expect(String((r.decided_verdict as { reason: string }).reason).length).toBeGreaterThan(0);
    }
    // THE RIGHT BASE for each form.
    const draft = rows.find((r) => r.output_id.endsWith("draft"))!;
    const ideas = rows.find((r) => r.output_id.endsWith("ideas"))!;
    expect(draft.extension).toBe(TEXT_BASE_EXT);
    expect((draft.decided_verdict as { form: string }).form).toBe("text/markdown");
    expect(await objectTypeOf(draft.artifact_id!)).toBe(TEXT_BASE);
    expect(ideas.extension).toBe(JSON_BASE_EXT);
    expect((ideas.decided_verdict as { form: string }).form).toBe("application/json");
    expect(await objectTypeOf(ideas.artifact_id!)).toBe(JSON_BASE);

    // The produced event carries the producing extension — the base the ladder chose.
    const events = await producedEventsFor(runId);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect([TEXT_BASE_EXT, JSON_BASE_EXT]).toContain(e.producing_extension);
      // The base the ladder chose is a different extension from the agent
      // template, so its version is recorded as an honest NULL, never the
      // template's pinned version.
      expect(e.producing_extension_version).toBeNull();
    }
    expect(neverAsk).not.toHaveBeenCalled();
  });

  it("ACCEPTANCE 2 — an item family with nothing above the floor takes no road: no ledger row, no artifact", async () => {
    const { templateId, runId } = await seedTemplateAndRun();
    await seedOutbox({ runId, templateId, items: [] });
    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");
    expect(await ledgerRows(runId)).toHaveLength(0);
    const row = await outboxRow(runId);
    expect(row?.detail).toMatchObject({ reason: "nothing_above_the_floor" });
  });

  it("ACCEPTANCE 3 — response text takes no road, and the 'not captured' advisory is gone", async () => {
    const { templateId, runId } = await seedTemplateAndRun();
    // A row exactly as the RETIRED core captured it: the final response text,
    // and no item family.
    await seedOutbox({ runId, templateId, items: null, legacyContent: MARKDOWN_DOC });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");
    expect(await ledgerRows(runId)).toHaveLength(0);
    expect(await producedEventsFor(runId)).toHaveLength(0);
    // The advisory RETIRES: nothing is emitted, for any outcome.
    const row = await outboxRow(runId);
    expect(row?.detail).toMatchObject({ reason: "response_text_retired", hadContent: true });
    // The advisory RETIRES: nothing is emitted, for any outcome.
    expect(notificationCalls).toHaveLength(0);
  });

  it("ACCEPTANCE 4 — undetectable bytes land under the BINARY BASE", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(BINARY_BASE, BINARY_BASE_EXT, ["application/octet-stream"]);
    REQUIRED.add(TEXT_BASE_EXT);
    REQUIRED.add(BINARY_BASE_EXT);
    await seedActiveClaim(BINARY_BASE, BINARY_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const outcomes = await pickupMod.pickUpDefaultRoadItems(
      {
        runId,
        orgId: ORG,
        templateId,
        packageVersion: "1.2.3",
        createdBy: null,
        templateName: "Blog draft writer",
        items: [item("blob", UNNAMEABLE)],
        producesRefs: [],
      },
      { ask: neverAsk, modelRungEnabled: false },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("written");
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("default_road");
    expect(rows[0].extension).toBe(BINARY_BASE_EXT);
    expect(rows[0].decided_rung).toBe("binary_fallback");
    expect(rows[0].decided_verdict).toMatchObject({ form: "application/octet-stream" });
    expect(await objectTypeOf(rows[0].artifact_id!)).toBe(BINARY_BASE);
  });

  it("ACCEPTANCE 4, the state of THIS branch — with no binary base installed the refusal is RECORDED, never guessed", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const outcomes = await pickupMod.pickUpDefaultRoadItems(
      {
        runId,
        orgId: ORG,
        templateId,
        packageVersion: "1.2.3",
        createdBy: null,
        templateName: "Blog draft writer",
        items: [item("blob", UNNAMEABLE)],
        producesRefs: [],
      },
      { ask: neverAsk, modelRungEnabled: false },
    );
    // Nothing was written, and the outcome SAYS SO with the rung and the reason
    // — no artifact under a type nothing owns.
    expect(outcomes[0]).toMatchObject({
      status: "no_target",
      targetRung: "binary_base",
      verdict: { rung: "binary_fallback", form: "application/octet-stream" },
      refusal: { reason: "no_base_installed" },
    });
    expect(await ledgerRows(runId)).toHaveLength(0);
    expect(notificationCalls).toHaveLength(0);
  });

  it("the declared-kind rung wins over the form's base, PER OUTPUT — and a partially bound agent keeps its unbound work", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(JSON_BASE, JSON_BASE_EXT, ["application/json"]);
    registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
    REQUIRED.add(TEXT_BASE_EXT);
    REQUIRED.add(JSON_BASE_EXT);
    await seedActiveClaim(BLOG_POST, BLOG_POST_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    // The agent declares one produce AND has bindings — the retired core
    // switched derivation off for the whole agent on exactly this shape.
    contextByTemplate.set(templateId, {
      producesRefs: [{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }],
      hasBindings: true,
    });
    await seedOutbox({
      runId,
      templateId,
      items: [item("draft", MARKDOWN_DOC), item("ideas", JSON_DOC, true)],
    });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(2);
    const draft = rows.find((r) => r.output_id.endsWith("draft"))!;
    const ideas = rows.find((r) => r.output_id.endsWith("ideas"))!;
    // markdown: the DECLARED KIND claims it.
    expect(draft.extension).toBe(BLOG_POST_EXT);
    expect(await objectTypeOf(draft.artifact_id!)).toBe(BLOG_POST);
    // json: the declared kind does not accept it, so the FORM'S BASE does — the
    // dependency wins per output, never as a switch over the whole agent.
    expect(ideas.extension).toBe(JSON_BASE_EXT);
    contextByTemplate.clear();
  });

  it("identical bytes in one run are ONE artifact with TWO ledger rows", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    await seedOutbox({
      runId,
      templateId,
      items: [item("copy", MARKDOWN_DOC), item("draft", MARKDOWN_DOC)],
    });

    const { outcome } = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(outcome).toBe("done");
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.phase === "finalized")).toBe(true);
    expect(new Set(rows.map((r) => r.artifact_id)).size).toBe(1);
  });

  it("is idempotent: a re-drive of a settled row writes nothing more", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    await seedOutbox({ runId, templateId, items: [item("draft", MARKDOWN_DOC)] });
    await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    const first = await ledgerRows(runId);
    const again = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(again.outcome).toBe("skipped");
    expect(await ledgerRows(runId)).toEqual(first);
  });

  // -------------------------------------------------------------------------
  // CONVERGENCE. Three defects the convergence round found, each proved
  // here on the same real store.
  // -------------------------------------------------------------------------

  it("CONVERGENCE — a re-drive whose ladder now resolves a DIFFERENT extension still leaves ONE artifact", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
    REQUIRED.add(TEXT_BASE_EXT);
    // The claim may already be seeded by an earlier case in this file — one
    // live dedicated claim per (scope, type) is the AC-1 constraint.
    await seedActiveClaim(BLOG_POST, BLOG_POST_EXT).catch(() => {});

    const { templateId, runId } = await seedTemplateAndRun();
    // Drive one: the agent declares blog-post, so the DECLARED KIND rung claims
    // the markdown output and the ledger key carries that extension.
    contextByTemplate.set(templateId, {
      producesRefs: [{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }],
      hasBindings: false,
    });
    await seedOutbox({ runId, templateId, items: [item("draft", MARKDOWN_DOC)] });
    await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    const first = await ledgerRows(runId);
    expect(first).toHaveLength(1);
    expect(first[0].extension).toBe(BLOG_POST_EXT);

    // The settle is LOST (a crash between the artifact write and the outbox
    // settle) and the world has moved on: the agent no longer declares
    // blog-post, so the ladder would now resolve the TEXT base — a different
    // ledger key, and, without the per-output guard, a SECOND artifact.
    contextByTemplate.set(templateId, { producesRefs: [], hasBindings: false });
    await client.query(
      `UPDATE "${S()}"."agent_run_output_derivations"
          SET status = 'pending', lease_token = NULL, lease_expires_at = NULL, attempts = 0
        WHERE run_id = $1`,
      [runId],
    );

    const again = await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(again.outcome).toBe("done");
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].extension).toBe(BLOG_POST_EXT);
    expect(rows[0].artifact_id).toBe(first[0].artifact_id);
    contextByTemplate.clear();
  });

  it("CONVERGENCE — an install-state write refusal is RETRYABLE, never a settled drop", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);
    // A GOVERNED but NOT-LIVE install row: the write-allowed gate denies. The
    // gate answers the same `false` when the canonical store cannot be read at
    // all, which is why settling on it would lose the output for good.
    // The row is created THE WAY THE PRODUCT CREATES ONE — the canonical
    // lifecycle primitive, installed live and then archived — so this suite
    // cannot drift from the one write road it is proving the pickup respects.
    const installId = `inst-${randomUUID()}`;
    const fixtureActor = { actor: { source: "dispatcher" as const, userId: "u-3029" } };
    await lifecycle.installExtensionManifest(
      {
        id: installId,
        packageName: TEXT_BASE_EXT,
        ownerLevel: "organization",
        ownerId: ORG,
        organizationId: ORG,
        kind: "artifact",
        source: {
          type: "verdaccio",
          registryUrl: "http://127.0.0.1:4873",
          packageName: TEXT_BASE_EXT,
          version: "1.0.0",
          integrity: "sha512-fixture-3029",
        },
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
        status: "active",
      } as never,
      { ...fixtureActor, reason: "cinatra#3029 fixture install" },
    );
    await lifecycle.transitionExtensionLifecycle(installId, "archive", {
      ...fixtureActor,
      reason: "cinatra#3029 fixture — governed, not live",
    });

    const { templateId, runId } = await seedTemplateAndRun();
    await seedOutbox({ runId, templateId, items: [item("draft", MARKDOWN_DOC)] });
    await expect(
      deriveMod.deriveUnboundRunOutput(
        { runId, orgId: ORG },
        { ask: neverAsk, modelRungEnabled: false, loadContext },
      ),
    ).rejects.toThrow(/not_write_allowed|retryable/i);
    // The row is STILL DRIVABLE: not settled, and its lease released.
    const row = await outboxRow(runId);
    expect(row?.status).toBe("pending");
    expect(await ledgerRows(runId)).toHaveLength(0);
    await lifecycle.transitionExtensionLifecycle(installId, "force_delete", {
      ...fixtureActor,
      reason: "cinatra#3029 fixture teardown",
    });
  });

  it("CONVERGENCE — the run page waits for the capture before it says a run made nothing", async () => {
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const records = await import("../run-artifact-records");
    const { templateId, runId } = await seedTemplateAndRun();
    // A run with NO capture row at all has nothing to wait for.
    expect(await records.isRunOutputCaptureSettled({ orgId: ORG, runId })).toBe(true);

    // Captured and not yet driven: the page must NOT read the empty list as
    // "this run made nothing".
    await seedOutbox({ runId, templateId, items: [item("draft", MARKDOWN_DOC)] });
    expect(await records.isRunOutputCaptureSettled({ orgId: ORG, runId })).toBe(false);

    await deriveMod.deriveUnboundRunOutput(
      { runId, orgId: ORG },
      { ask: neverAsk, modelRungEnabled: false, loadContext },
    );
    expect(await records.isRunOutputCaptureSettled({ orgId: ORG, runId })).toBe(true);
    expect(
      (await records.readRunArtifactRecords({ orgId: ORG, runId })).length,
    ).toBeGreaterThan(0);
  });
});
