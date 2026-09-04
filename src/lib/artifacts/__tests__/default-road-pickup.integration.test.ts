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
// The host's required-extension LOCK, as manifest data: which packages are
// required in prod, and AT WHICH PIN. The pin is what the produced event's
// `producing_extension_version` is contractually the value of (plan section
// 8.2), so this suite states one and asserts the road carries it — rather than
// asserting NULL and calling the missing datum a contract.
let REQUIRED_PIN = "^0.1.0";
vi.mock("@cinatra-ai/extensions/required-in-prod", () => ({
  isPackageRequiredInProd: (pkg: string) => REQUIRED.has(pkg),
  findRequiredInProdEntry: (pkg: string) =>
    REQUIRED.has(pkg) ? { packageName: pkg, versionRange: REQUIRED_PIN } : null,
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
    // ...and the host's pin for the base IS recorded, on the ledger's own
    // verdict, where "^0.1.0" is a truthful value.
    expect(draft.decided_verdict).toMatchObject({ producingExtensionPin: REQUIRED_PIN });
    expect(ideas.decided_verdict).toMatchObject({ producingExtensionPin: REQUIRED_PIN });

    // The produced event carries the producing extension — the base the ladder chose.
    const events = await producedEventsFor(runId);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect([TEXT_BASE_EXT, JSON_BASE_EXT]).toContain(e.producing_extension);
      // THE VERSION COLUMN TAKES A VERSION (convergence over leg 1). The lock
      // here pins a RANGE, and a range is not a version anybody installed —
      // the column's other writer puts a concrete `packageVersion` in it — so
      // the road leaves it null and records the range where a range belongs.
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

  it("CONVERGENCE — a ledger row held by ANOTHER road is never settled by this one", async () => {
    // THE DEFECT THIS CLOSES (convergence over forward + fix leg 1). The ledger
    // identity is (run, output, extension, content hash) — it EXCLUDES the path
    // (cinatra#1893 Q3) — so a claim this road gets back can be an unfinalized
    // row belonging to a DIFFERENT materialization path. The shared write core
    // refuses that case; the default road's three DIRECT claims did not, so a
    // refusal here would have settled another road's journal row with null refs
    // and a verdict that road never decided.
    //
    // A collision is a fact about the MOMENT, so the road throws: the lease is
    // released and the sweep re-drives — the same handling the write path gives
    // its own `path_collision`.
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const blob = item("blob", UNNAMEABLE);
    const foreignId = `mat-${randomUUID()}`;
    await client.query(
      `INSERT INTO "${S()}"."artifact_materializations"
         (id, org_id, run_id, output_id, node_id, path, extension, content_hash, phase)
       VALUES ($1, $2, $3, $4, NULL, 'end_node_binding', $5, $6, 'claimed')`,
      [
        foreignId,
        ORG,
        runId,
        blob.outputId,
        "form:application/octet-stream",
        blob.contentHash,
      ],
    );

    await expect(
      pickupMod.pickUpDefaultRoadItems(
        {
          runId,
          orgId: ORG,
          templateId,
          packageVersion: "1.2.3",
          createdBy: null,
          templateName: "Blog draft writer",
          items: [blob],
          producesRefs: [],
        },
        { ask: neverAsk, modelRungEnabled: false },
      ),
    ).rejects.toThrow(/end_node_binding/);

    // The foreign row is EXACTLY as it was: still claimed, still empty, still
    // carrying no decision this road made.
    const after = await ledgerRows(runId);
    expect(after).toHaveLength(1);
    expect(after[0].path).toBe("end_node_binding");
    expect(after[0].phase).toBe("claimed");
    expect(after[0].artifact_id).toBeNull();
    expect(after[0].decided_verdict).toBeNull();
  });

  it("ACCEPTANCE 4 — where NO base can house the form, the ledger row STILL exists and SAYS SO", async () => {
    // THE DEFECT THIS CLOSES (cinatra#3029, forward + fix leg 1). This case used
    // to assert ZERO ledger rows and call that correct: the road wrote nothing,
    // recorded nothing, and every later reader of the run saw an output that had
    // simply never existed. Item 0.17 asks for "one ledger row per item"; not
    // minting an artifact under a type nothing owns is the honest half, and this
    // is the other half — the DECISION is written down.
    //
    // MEASURED, on main, TODAY: `@cinatra-ai/binary-artifact` IS in the host's
    // required set (root package.json `cinatra.extensions`) and its type accepts
    // `application/octet-stream`, so the binary rung resolves in production and
    // the case above is the shipped behaviour. This case is the state that
    // remains genuinely reachable — a form no INSTALLED base accepts — and it is
    // constructed here by installing no base for it.
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
    // AND THE ROW EXISTS. Finalized — the road is done with this output, so a
    // re-drive must not re-run a ladder over it — with NULL artifact refs, which
    // is what "there is no artifact" looks like on this table, and a verdict that
    // states the form and why nothing could house it.
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("default_road");
    expect(rows[0].phase).toBe("finalized");
    expect(rows[0].artifact_id).toBeNull();
    expect(rows[0].representation_revision_id).toBeNull();
    expect(rows[0].decided_rung).toBe("binary_fallback");
    expect(rows[0].decided_verdict).toMatchObject({
      form: "application/octet-stream",
      refusalReason: "no_base_installed",
      refusalRung: "binary_base",
    });
    expect(notificationCalls).toHaveLength(0);

    // AND IT IS TERMINAL. A second drive reads the settled row and does not
    // re-detect, so the recorded decision is the run's answer for good.
    const again = await pickupMod.pickUpDefaultRoadItems(
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
    expect(again[0].status).toBe("no_target");
    expect(await ledgerRows(runId)).toHaveLength(1);
  });

  it("EVERY DETECTED FORM finishes with an artifact AND a ledger row — binary and unknown included", async () => {
    // The acceptance sentence of item 0.17 as ONE table: markdown (structural),
    // json (structural), ambiguous prose the model rung is switched off over
    // (plain), and undetectable bytes (the binary rung). With the bases the host
    // ships today installed, EVERY one of the four reaches an artifact of the
    // right base and carries a row — nothing is dropped, and no form is a
    // special case (cinatra#3029, forward + fix leg 1).
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(JSON_BASE, JSON_BASE_EXT, ["application/json"]);
    registerArtifactType(BINARY_BASE, BINARY_BASE_EXT, ["application/octet-stream"]);
    REQUIRED.add(TEXT_BASE_EXT);
    REQUIRED.add(JSON_BASE_EXT);
    REQUIRED.add(BINARY_BASE_EXT);
    await seedActiveClaim(BINARY_BASE, BINARY_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const PROSE = "An ordinary paragraph of prose. ".repeat(60);
    const outcomes = await pickupMod.pickUpDefaultRoadItems(
      {
        runId,
        orgId: ORG,
        templateId,
        packageVersion: "1.2.3",
        createdBy: null,
        templateName: "Blog draft writer",
        items: [
          item("draft", MARKDOWN_DOC),
          item("ideas", JSON_DOC, true),
          item("notes", PROSE),
          item("blob", UNNAMEABLE),
        ],
        producesRefs: [],
      },
      { ask: neverAsk, modelRungEnabled: false },
    );
    expect(outcomes).toHaveLength(4);
    // NOT ONE of them is a drop.
    expect(outcomes.map((o) => o.status)).not.toContain("no_target");
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.path).toBe("default_road");
      expect(row.phase).toBe("finalized");
      expect(row.artifact_id).not.toBeNull();
      expect(row.representation_revision_id).not.toBeNull();
      expect(row.decided_rung).not.toBeNull();
    }
    const byName = (n: string) => rows.find((r) => r.output_id.endsWith(n))!;
    expect(await objectTypeOf(byName("draft").artifact_id!)).toBe(TEXT_BASE);
    expect(await objectTypeOf(byName("ideas").artifact_id!)).toBe(JSON_BASE);
    expect(await objectTypeOf(byName("notes").artifact_id!)).toBe(TEXT_BASE);
    expect(await objectTypeOf(byName("blob").artifact_id!)).toBe(BINARY_BASE);
    expect(byName("blob").decided_rung).toBe("binary_fallback");
    // THE MODEL RUNG'S OWN VERDICT IS PERSISTED TOO — the switched-off answer is
    // a recorded fact about how the form was decided, not an absence.
    expect(byName("notes").decided_rung).toBe("model");
    expect(byName("notes").decided_verdict).toMatchObject({
      form: "text/plain",
      modelSkipped: "switched_off",
    });
  });

  it("the produced event carries the base's PINNED VERSION, not a null", async () => {
    // Plan section 8.2: "the produced event [...] gains the producing extension
    // AND ITS PINNED VERSION beside the run." The road wrote NULL there and
    // called it an honest absence; the version is not absent — every base the
    // ladder can choose is required-in-prod by construction, and the host's lock
    // states the pin it is held at (cinatra#3029, forward + fix leg 1).
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    await pickupMod.pickUpDefaultRoadItems(
      {
        runId,
        orgId: ORG,
        templateId,
        packageVersion: "1.2.3",
        createdBy: null,
        templateName: "Blog draft writer",
        items: [item("draft", MARKDOWN_DOC)],
        producesRefs: [],
      },
      { ask: neverAsk, modelRungEnabled: false },
    );
    const events = await producedEventsFor(runId);
    expect(events).toHaveLength(1);
    expect(events[0].producing_extension).toBe(TEXT_BASE_EXT);
    // A RANGE never enters the version column; the range is on the row.
    expect(events[0].producing_extension_version).toBeNull();
    const pinnedRows = await ledgerRows(runId);
    expect(pinnedRows[0].decided_verdict).toMatchObject({
      producingExtensionPin: REQUIRED_PIN,
    });
  });

  it("the produced event carries the base's version when the lock PINS ONE EXACTLY", async () => {
    // THE OTHER HALF of the same contract (convergence over leg 1). Where the
    // host's lock names a concrete version, that version IS the producing
    // version and it belongs in the column — the same value shape the column's
    // other writer (`extension-artifact-reads`) puts there.
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);
    const previousPin = REQUIRED_PIN;
    REQUIRED_PIN = "0.1.7";
    try {
      const { templateId, runId } = await seedTemplateAndRun();
      await pickupMod.pickUpDefaultRoadItems(
        {
          runId,
          orgId: ORG,
          templateId,
          packageVersion: "1.2.3",
          createdBy: null,
          templateName: "Blog draft writer",
          items: [item("draft", MARKDOWN_DOC)],
          producesRefs: [],
        },
        { ask: neverAsk, modelRungEnabled: false },
      );
      const events = await producedEventsFor(runId);
      expect(events).toHaveLength(1);
      expect(events[0].producing_extension_version).toBe("0.1.7");
      const rows = await ledgerRows(runId);
      expect(rows[0].decided_verdict).toMatchObject({ producingExtensionPin: "0.1.7" });
    } finally {
      REQUIRED_PIN = previousPin;
    }
  });

  it("CONVERGENCE — two drivers racing on ONE output leave ONE artifact, whatever extension each resolves", async () => {
    // THE DEFECT THIS CLOSES. The guard was a NON-LOCKING preflight read: both
    // drivers read no finalized row, then typed, then claimed. The four-part
    // unique key includes the EXTENSION, which on this road is DERIVED — so two
    // drivers that resolve different extensions claim different keys and each
    // writes its own artifact for one output. The sequential re-drive case below
    // cannot expose it: it only ever has one driver in flight.
    //
    // THE RACE IS MADE DETERMINISTIC, not left to the scheduler. Both drivers
    // are launched in one tick over bytes the structural probes leave ambiguous,
    // so both reach the MODEL rung — and the model is injected, so this suite
    // decides how long each driver spends inside its own detection. The slow
    // driver is therefore GUARANTEED to still be typing while the fast one
    // claims and writes, which is precisely the window the old preflight left
    // open. Under the lock the window does not exist: the second driver waits at
    // the door and, on entering, finds the settled row.
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    registerArtifactType(BLOG_POST, BLOG_POST_EXT, ["text/markdown"]);
    REQUIRED.add(TEXT_BASE_EXT);
    await seedActiveClaim(BLOG_POST, BLOG_POST_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    const AMBIGUOUS = "An ordinary paragraph of prose with nothing structural. ".repeat(40);
    const answerAfter = (ms: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { answer: "text/markdown", confidence: 0.99 };
    };
    const drive = (
      producesRefs: Array<{ extension: string; objectTypeId?: string }>,
      askDelayMs: number,
    ) =>
      pickupMod.pickUpDefaultRoadItems(
        {
          runId,
          orgId: ORG,
          templateId,
          packageVersion: "1.2.3",
          createdBy: null,
          templateName: "Blog draft writer",
          items: [item("draft", AMBIGUOUS)],
          producesRefs,
        },
        { ask: answerAfter(askDelayMs), modelRungEnabled: true },
      );
    // The SLOW driver resolves the form's base; the FAST one, launched in the
    // same tick, resolves the declared kind — a different extension for the same
    // bytes of the same output of the same run.
    const [slow, fast] = await Promise.all([
      drive([], 400),
      drive([{ extension: BLOG_POST_EXT, objectTypeId: BLOG_POST }], 0),
    ]);
    // ONE artifact. Both drivers report the SAME refs — the loser of the race
    // read the winner's settled row rather than writing a second artifact.
    const artifacts = new Set(
      [...slow, ...fast]
        .map((o) => o.artifactId)
        .filter((v): v is string => typeof v === "string"),
    );
    expect(artifacts.size).toBe(1);
    const rows = (await ledgerRows(runId)).filter((r) => r.artifact_id !== null);
    expect(new Set(rows.map((r) => r.artifact_id)).size).toBe(1);
    // And exactly one of the two extensions won — never both.
    expect(new Set(rows.map((r) => r.extension)).size).toBe(1);
  });

  it("CONVERGENCE — identical bytes under DIFFERENT names keep their own form on their own row", async () => {
    // THE DEFECT THIS CLOSES. Same-byte reuse was keyed on the content hash and
    // the target EXTENSION only — and one base extension can own several forms.
    // Two items of identical ambiguous bytes named `draft.md` and `rows.csv`
    // take different name-rung verdicts, resolve to the same multi-MIME base,
    // and the second row then recorded "csv" while pointing at the first item's
    // MARKDOWN representation: a verdict attached to an artifact of another form.
    objectTypeRegistry._clearForTests();
    REQUIRED.clear();
    registerArtifactType(TEXT_BASE, TEXT_BASE_EXT, ["text/plain", "text/markdown", "text/csv"]);
    REQUIRED.add(TEXT_BASE_EXT);

    const { templateId, runId } = await seedTemplateAndRun();
    // Bytes the structural probes leave ambiguous, so the NAME rung decides —
    // and the two names decide differently over the very same bytes.
    const AMBIGUOUS = "An ordinary paragraph of prose with nothing structural. ".repeat(40);
    const outcomes = await pickupMod.pickUpDefaultRoadItems(
      {
        runId,
        orgId: ORG,
        templateId,
        packageVersion: "1.2.3",
        createdBy: null,
        templateName: "Blog draft writer",
        items: [item("draft.md", AMBIGUOUS), item("rows.csv", AMBIGUOUS)],
        producesRefs: [],
      },
      { ask: neverAsk, modelRungEnabled: false },
    );
    expect(outcomes).toHaveLength(2);
    const md = outcomes.find((o) => o.outputName === "draft.md")!;
    const csvItem = outcomes.find((o) => o.outputName === "rows.csv")!;
    // ONE VERDICT over one set of bytes. Section 3 makes identical bytes ONE
    // artifact, and one artifact has one representation and therefore one form —
    // so the name rung may not give the second item a form the shared artifact
    // does not have. Before this leg it did: `rows.csv` recorded a csv verdict
    // over the markdown representation `draft.md` had already written.
    expect(md.verdict.form).toBe(csvItem.verdict.form);
    // TWO ledger rows, and each row's recorded form matches the artifact it
    // points at — never one form's verdict over another form's representation.
    const rows = await ledgerRows(runId);
    expect(rows).toHaveLength(2);
    // ONE artifact, asserted rather than implied (convergence over leg 1): the
    // comment above says "one artifact" and now the rows say it too.
    expect(new Set(rows.map((r) => r.artifact_id)).size).toBe(1);
    expect(md.artifactId).toBe(csvItem.artifactId);
    for (const row of rows) {
      expect(row.artifact_id).not.toBeNull();
      const mime = await client.query(
        `SELECT r.mime FROM "${S()}"."representation" rep
           JOIN "${S()}"."resource" r ON r.id = rep.resource_id
          WHERE rep.id = $1`,
        [row.representation_revision_id],
      );
      expect(String(mime.rows[0]?.mime)).toBe(
        String((row.decided_verdict as { form?: string } | null)?.form),
      );
    }
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

  // -------------------------------------------------------------------------
  // THE RUN-MADE LIST'S OWN DATABASE READ (cinatra#3029, forward + fix leg 1).
  //
  // The rendered panel and the pure list model were both well covered; the READ
  // behind them was barely exercised at all, and it carried a real defect --
  // deduplication by artifact id alone, which silently deleted the "Used" fact
  // whenever a run wrote a NEW REVISION of something it had also read.
  //
  // The ratified drawing, section I.2: "Every row carries the artifact's title,
  // the type that owns it, THE REVISION THE RUN FILED OR READ, and the control
  // that opens it on its own page ... a reader needs to see what the run started
  // from as well as what it produced."
  // -------------------------------------------------------------------------
  describe("the run-made list's database read", () => {
    let recordsMod: typeof import("../run-artifact-records");

    /** A minimal artifact object + one representation revision of it. */
    async function seedArtifact(input: {
      artifactId: string;
      revisionId: string;
      typeId: string;
      title: string;
      mime: string;
    }) {
      await client.query(
        `INSERT INTO "${S()}"."objects" (id, org_id, type, data)
         VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT (id) DO NOTHING`,
        [input.artifactId, ORG, input.typeId, JSON.stringify({ title: input.title })],
      );
      await seedRevision(input.artifactId, input.revisionId, input.mime);
    }

    let nextRevision = 1;
    /** One immutable representation revision of an artifact, and the resource
     *  its bytes live in — the two rows the list's read joins through. */
    async function seedRevision(artifactId: string, revisionId: string, mime: string) {
      const resourceId = `res-${randomUUID()}`;
      await client.query(
        `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime)
         VALUES ($1, $2, 'blob', $3, $4)`,
        [resourceId, ORG, `sub-${resourceId}`, mime],
      );
      await client.query(
        `INSERT INTO "${S()}"."representation"
           (id, org_id, artifact_id, resource_id, revision, form)
         VALUES ($1, $2, $3, $4, $5, 'file')`,
        [revisionId, ORG, artifactId, resourceId, nextRevision++],
      );
    }

    async function seedWrote(runId: string, artifactId: string, revisionId: string, ext: string) {
      await client.query(
        `INSERT INTO "${S()}"."artifact_materializations"
           (id, org_id, run_id, output_id, node_id, path, extension, content_hash,
            artifact_id, representation_revision_id, phase)
         VALUES ($1, $2, $3, $4, NULL, 'default_road', $5, $6, $7, $8, 'finalized')`,
        [
          `mat-${randomUUID()}`,
          ORG,
          runId,
          `cinatra:run-output:${randomUUID()}`,
          ext,
          sha(`${artifactId}${revisionId}`),
          artifactId,
          revisionId,
        ],
      );
    }

    async function seedUsed(runId: string, artifactId: string, revisionId: string) {
      await client.query(
        `INSERT INTO "${S()}"."run_context_selections"
           (id, org_id, parent_run_id, parent_package_name, slot_id, artifact_id,
            representation_revision_id, semantic_assertion_id, extension,
            source_scope, selected_by, selection_mode)
         VALUES ($1, $2, $3, '@test/pkg', 'slot', $4, $5, 'assert', '@test/ext',
                 'organization', 'agent', 'interactive')`,
        [`sel-${randomUUID()}`, ORG, runId, artifactId, revisionId],
      );
    }

    beforeAll(async () => {
      recordsMod = await import("../run-artifact-records");
    });

    it("an artifact the run READ and then WROTE A NEW REVISION OF keeps BOTH facts", async () => {
      // THE DEFECT THIS CLOSES. The read suppressed every `used` row sharing an
      // artifact id with a `wrote` row -- so a run that read revision A of an
      // idea and filed revision B of it showed only B, and the reader was never
      // told what the run started from.
      const { runId } = await seedTemplateAndRun();
      const artifactId = `obj-${randomUUID()}`;
      const revA = `rev-${randomUUID()}`;
      const revB = `rev-${randomUUID()}`;
      await seedArtifact({
        artifactId,
        revisionId: revA,
        typeId: "@cinatra-ai/blog:idea",
        title: "The idea",
        mime: "text/markdown",
      });
      // The SECOND revision of the SAME artifact — what the run filed.
      await seedRevision(artifactId, revB, "text/markdown");
      await seedUsed(runId, artifactId, revA);
      await seedWrote(runId, artifactId, revB, TEXT_BASE_EXT);

      const records = await recordsMod.readRunArtifactRecords({ orgId: ORG, runId });
      expect(records).toHaveLength(2);
      const wrote = records.find((r) => r.role === "wrote")!;
      const used = records.find((r) => r.role === "used")!;
      expect(wrote.representationRevisionId).toBe(revB);
      expect(used.representationRevisionId).toBe(revA);
      expect(used.annotation).toBe("read by this run");
    });

    it("the SAME revision read and written is ONE row, listed as written", async () => {
      const { runId } = await seedTemplateAndRun();
      const artifactId = `obj-${randomUUID()}`;
      const rev = `rev-${randomUUID()}`;
      await seedArtifact({
        artifactId,
        revisionId: rev,
        typeId: "@cinatra-ai/blog:post",
        title: "The post",
        mime: "text/markdown",
      });
      await seedUsed(runId, artifactId, rev);
      await seedWrote(runId, artifactId, rev, TEXT_BASE_EXT);

      const records = await recordsMod.readRunArtifactRecords({ orgId: ORG, runId });
      expect(records).toHaveLength(1);
      expect(records[0].role).toBe("wrote");
    });

    it("lists everything the run wrote and everything it used, written first", async () => {
      const { runId } = await seedTemplateAndRun();
      const w1 = `obj-${randomUUID()}`;
      const w2 = `obj-${randomUUID()}`;
      const u1 = `obj-${randomUUID()}`;
      const rw1 = `rev-${randomUUID()}`;
      const rw2 = `rev-${randomUUID()}`;
      const ru1 = `rev-${randomUUID()}`;
      await seedArtifact({ artifactId: w1, revisionId: rw1, typeId: "@cinatra-ai/blog:post", title: "Post", mime: "text/markdown" });
      await seedArtifact({ artifactId: w2, revisionId: rw2, typeId: "@cinatra-ai/blog:image", title: "Image", mime: "image/png" });
      await seedArtifact({ artifactId: u1, revisionId: ru1, typeId: "@cinatra-ai/blog:idea", title: "Idea", mime: "text/markdown" });
      await seedWrote(runId, w1, rw1, TEXT_BASE_EXT);
      await seedWrote(runId, w2, rw2, TEXT_BASE_EXT);
      await seedUsed(runId, u1, ru1);

      const records = await recordsMod.readRunArtifactRecords({ orgId: ORG, runId });
      expect(records).toHaveLength(3);
      // The written rows lead, the used rows trail — the order the drawing puts
      // them in ("one row per artifact the run wrote, and ... that artifact too,
      // marked used").
      expect(records.map((r) => r.role)).toEqual(["wrote", "wrote", "used"]);
      expect(records.map((r) => r.title)).toContain("Idea");
      expect(records.find((r) => r.artifactId === w2)!.mime).toBe("image/png");
    });

    it("a run that wrote nothing and used nothing reads as the EMPTY ANSWER, never a failure", async () => {
      const { runId } = await seedTemplateAndRun();
      const records = await recordsMod.readRunArtifactRecords({ orgId: ORG, runId });
      expect(records).toEqual([]);
    });

    it("a READ FAILURE throws rather than answering the empty list", async () => {
      // The screen turns a thrown read into the UNKNOWN reading (pinned in
      // packages/agents/src/__tests__/run-artifact-list.test.ts). That is only
      // sound because this read FAILS LOUDLY instead of swallowing the error and
      // returning `[]` itself: an empty array from this function is an ANSWER
      // about the run, and nothing else may produce one.
      await client.query(`ALTER TABLE "${S()}"."objects" RENAME TO objects_hidden_3029`);
      try {
        await expect(
          recordsMod.readRunArtifactRecords({ orgId: ORG, runId: "run-any" }),
        ).rejects.toThrow();
      } finally {
        await client.query(`ALTER TABLE "${S()}"."objects_hidden_3029" RENAME TO objects`);
      }
      // And once the store is readable again the same call answers normally.
      await expect(
        recordsMod.readRunArtifactRecords({ orgId: ORG, runId: "run-any" }),
      ).resolves.toEqual([]);
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
