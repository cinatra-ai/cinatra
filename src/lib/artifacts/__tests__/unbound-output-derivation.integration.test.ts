/**
 * cinatra#1893 (epic #1883 slice A5) — the produces-scoped TYPING seam of the
 * unbound agent-output capture: `deriveUnboundRunOutput` /
 * `sweepPendingUnboundDerivations`, and the `derived_output` ledger DEDUPE key.
 * REAL-store proof (no boundary stub at the typing seam): the real materializer
 * (`writeClaimedArtifact` → `createSemanticArtifact` → the materialization
 * ledger), the real claim registry, real object registry, real disk.
 *
 * Proves, against real DDL + constraints (fresh schema per file from the
 * CANONICAL `buildCreateStoreSchemaQueries` bootstrap — the migration-0071 twin,
 * which carries the widened `artifact_materializations_path_check` admitting
 * `derived_output`):
 *   1. an agent with a declared produce and no binding gets its output
 *      MATERIALIZED EXACTLY ONCE, idempotent under a re-drive (AC1);
 *   2. the `derived_output` ledger DEDUPE key (run, output_id, extension,
 *      content_hash) collapses a repeat write to the same artifact
 *      (`deduped:true`), and the Q3 path-collision guard REFUSES to alias a
 *      finalized row of a different `path` (AC5 — the dedupe key);
 *   3. a no-produces run emits the advisory and PERSISTS NO artifact; the outbox
 *      row settles `no_produces` (AC2);
 *   4. the reconciliation sweep CONVERGES — a settled (`no_produces`/`no_match`)
 *      row is never re-selected; only `pending`/expired-`deriving` rows are
 *      drained (AC4).
 *
 * The ONLY controlled input is the run agent's declared `produces` (a registry
 * manifest read that is NOT the typing seam) via a per-template context map; the
 * advisory notification (a downstream side-channel) is spied. Everything the
 * seam owns — target resolution, MIME selection, the ledger claim/dedupe, the
 * artifact write — runs real.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided
 * (CINATRA_DB_INTEGRATION_TESTS=1). Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm exec vitest run --config vitest.config.ts \
 *       src/lib/artifacts/__tests__/unbound-output-derivation.integration.test.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

// The produces SOURCE (a registry manifest read) is controlled per-template so
// the seam sees a validated `produces` without a live registry. The typing seam
// itself — writeClaimedArtifact / resolveRunScopeOwnership — stays REAL
// (importActual). A template absent from the map ⇒ empty produces ⇒ no_produces.
const contextByTemplate = new Map<
  string,
  { producesRefs: Array<{ extension: string; objectTypeId?: string }>; hasBindings: boolean }
>();
vi.mock("../run-artifact-materializer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-artifact-materializer")>();
  return {
    ...actual,
    loadRunDerivationContext: vi.fn(
      async (input: { templateId: string; packageVersion: string | null }) =>
        contextByTemplate.get(input.templateId) ?? { producesRefs: [], hasBindings: false },
    ),
  };
});
// The heavy app-boot registrar must not clobber the types this suite registers
// directly (the #1868 pattern).
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The advisory notification is a downstream side-channel, not the typing seam —
// spy it to assert the advisory CONTRACT (recipient + kind + dedupeKey).
const createNotificationForRecipientMock = vi.fn(
  async (_recipient: Record<string, unknown>, _record: Record<string, unknown>) => {},
);
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: createNotificationForRecipientMock,
}));

const TEST_SCHEMA = "cinatra_test_unbound_derivation_1893";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-1893-deriv";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

let client: Client;
let deriveMod: typeof import("../unbound-output-derivation");
let materializerMod: typeof import("../run-artifact-materializer");

const S = () => q(TEST_SCHEMA);

async function seedTemplateAndRun(input: {
  packageName: string | null;
  templateName?: string;
}): Promise<{ templateId: string; runId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;
  // package_name is NOT NULL in the store schema. Its VALUE is irrelevant to the
  // derivation outcome here — the produces set is supplied through
  // `contextByTemplate` (a template absent from the map ⇒ empty produces ⇒
  // no_produces), mirroring what the real registry read would yield.
  await client.query(
    `INSERT INTO "${S()}"."agent_templates" (id, name, source_nl, compiled_plan, input_schema, approval_policy, org_id, package_name)
     VALUES ($1, $2, 'test', '[]', '{}', '{"steps":[]}', $3, $4)`,
    [templateId, input.templateName ?? "Test Agent", ORG, input.packageName ?? `@test/${templateId}`],
  );
  await client.query(
    `INSERT INTO "${S()}"."agent_runs" (id, template_id, input_params, status, org_id)
     VALUES ($1, $2, '{}', 'completed', $3)`,
    [runId, templateId, ORG],
  );
  return { templateId, runId };
}

/** Insert a pending outbox row directly (the capture seam is proven by the
 *  sibling agents test; here the row is the derivation INPUT). */
async function seedOutbox(input: {
  runId: string;
  templateId: string;
  content: string;
  contentIsJson: boolean;
  packageVersion?: string | null;
  createdBy?: string | null;
  status?: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO "${S()}"."agent_run_output_derivations"
       (run_id, org_id, template_id, package_version, created_by, content, content_is_json, content_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.runId,
      ORG,
      input.templateId,
      input.packageVersion ?? null,
      input.createdBy ?? null,
      input.content,
      input.contentIsJson,
      sha(input.content),
      input.status ?? "pending",
    ],
  );
}

async function outboxStatus(runId: string): Promise<string | null> {
  const r = await client.query(
    `SELECT status FROM "${S()}"."agent_run_output_derivations" WHERE run_id = $1`,
    [runId],
  );
  return (r.rows[0]?.status as string | undefined) ?? null;
}

/** Count of MATERIALIZED (finalized) derived_output artifacts for a run. Excludes
 *  a bare `claimed` ledger row (written by claimMaterialization BEFORE the write
 *  Tx and left behind when the fence aborts that Tx) — that carries no artifact. */
async function derivedLedgerCount(runId: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS n FROM "${S()}"."artifact_materializations"
       WHERE run_id = $1 AND path = 'derived_output' AND phase = 'finalized'`,
    [runId],
  );
  return Number(r.rows[0].n);
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

async function seedActiveClaim(input: { typeId: string; extension: string }) {
  await client.query(
    `INSERT INTO "${S()}"."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ($1, $2, $3, 'dedicated', $4, '1.0.0', 'active', 1, $5::jsonb)`,
    [
      `claim-${randomUUID()}`,
      `org:${ORG}`,
      input.typeId,
      input.extension,
      JSON.stringify({ projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" }),
    ],
  );
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA; // BEFORE any dynamic import that reads it
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-1893-"));

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    // Skip the GLOBAL public."user" slug trigger: it is not schema-local, so two
    // bootstrapping integration tests racing under vitest file-parallelism collide
    // on it ("already exists"). This suite never touches public."user".
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Tolerate cross-schema FKs to absent Better Auth tables ("does not exist")
      // and GLOBAL public objects (e.g. the user_slug_move_trg trigger on
      // public."user") a sibling integration test already created in this DB
      // ("already exists").
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  client = new Client({ connectionString: DB_URL });
  await client.connect();
  deriveMod = await import("../unbound-output-derivation");
  materializerMod = await import("../run-artifact-materializer");
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

describe.skipIf(!HAS_DB)(
  "cinatra#1893 — unbound-output derivation + derived_output dedupe (real store)",
  () => {
    it("no-produces run: emits the advisory, persists NO artifact, settles no_produces (AC2)", async () => {
      createNotificationForRecipientMock.mockClear();
      const { templateId, runId } = await seedTemplateAndRun({
        packageName: null,
        templateName: "No-Produces Agent",
      });
      // Template absent from contextByTemplate ⇒ the derivation sees an empty
      // `produces` set (what the real registry read yields for a no-produces
      // agent) ⇒ no_produces.
      await seedOutbox({ runId, templateId, content: "orphan output", contentIsJson: false, createdBy: "user-x" });

      const { outcome } = await deriveMod.deriveUnboundRunOutput({ runId, orgId: ORG });

      expect(outcome).toBe("no_produces");
      expect(await outboxStatus(runId)).toBe("no_produces");
      expect(await derivedLedgerCount(runId)).toBe(0); // nothing materialized
      // Advisory emitted: info, per-run dedupe key, to the run's user.
      expect(createNotificationForRecipientMock).toHaveBeenCalledTimes(1);
      const [recipient, record] = createNotificationForRecipientMock.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(recipient).toEqual({ kind: "user", userId: "user-x" });
      expect(record.kind).toBe("info");
      expect(record.dedupeKey).toBe(`unbound-output:${runId}`);
    });

    it("single declared produce, no binding: materializes EXACTLY ONCE, idempotent under re-drive (AC1)", async () => {
      const EXT = "@cinatra-ai/report-artifact";
      const TYPE = `${EXT}:document`;
      registerArtifactType(TYPE, EXT, ["application/json"]);
      await seedActiveClaim({ typeId: TYPE, extension: EXT });

      const { templateId, runId } = await seedTemplateAndRun({
        packageName: EXT,
        templateName: "Report Agent",
      });
      contextByTemplate.set(templateId, {
        producesRefs: [{ extension: EXT, objectTypeId: TYPE }],
        hasBindings: false,
      });
      const content = JSON.stringify({ report: "quarterly", value: 42 });
      await seedOutbox({ runId, templateId, content, contentIsJson: true, createdBy: null });

      const first = await deriveMod.deriveUnboundRunOutput({ runId, orgId: ORG });
      expect(first.outcome).toBe("done");
      expect(await outboxStatus(runId)).toBe("done");
      expect(await derivedLedgerCount(runId)).toBe(1);

      // Re-drive (a lost enqueue / crash restart): the settled row is not
      // re-derived — exactly one artifact remains (AC1 idempotency).
      const second = await deriveMod.deriveUnboundRunOutput({ runId, orgId: ORG });
      expect(second.outcome).toBe("skipped");
      expect(await derivedLedgerCount(runId)).toBe(1);
    });

    it("multi-produce: the classifier tiebreaks AMONG the declared produces and materializes the chosen one", async () => {
      const EXT_A = "@cinatra-ai/multi-a-artifact";
      const TYPE_A = `${EXT_A}:document`;
      const EXT_B = "@cinatra-ai/multi-b-artifact";
      const TYPE_B = `${EXT_B}:document`;
      registerArtifactType(TYPE_A, EXT_A, ["application/json"]);
      registerArtifactType(TYPE_B, EXT_B, ["application/json"]);
      await seedActiveClaim({ typeId: TYPE_A, extension: EXT_A });
      await seedActiveClaim({ typeId: TYPE_B, extension: EXT_B });

      const { templateId, runId } = await seedTemplateAndRun({ packageName: EXT_A });
      contextByTemplate.set(templateId, {
        producesRefs: [
          { extension: EXT_A, objectTypeId: TYPE_A },
          { extension: EXT_B, objectTypeId: TYPE_B },
        ],
        hasBindings: false,
      });
      const content = JSON.stringify({ pick: "A" });
      await seedOutbox({ runId, templateId, content, contentIsJson: true });

      // Inject the classifier tiebreak: pick TYPE_A at/above threshold. The
      // candidate set handed to it must be EXACTLY the two declared produces.
      let seenCandidates: readonly string[] = [];
      const { outcome } = await deriveMod.deriveUnboundRunOutput(
        { runId, orgId: ORG },
        {
          classify: async ({ candidateTypeIds }) => {
            seenCandidates = candidateTypeIds;
            return { objectTypeId: TYPE_A, confidence: 0.92 };
          },
        },
      );

      expect(outcome).toBe("done");
      expect([...seenCandidates].sort()).toEqual([TYPE_A, TYPE_B].sort());
      const ext = await client.query(
        `SELECT extension FROM "${S()}"."artifact_materializations" WHERE run_id = $1 AND path = 'derived_output'`,
        [runId],
      );
      expect(ext.rows).toHaveLength(1);
      expect(ext.rows[0].extension).toBe(EXT_A); // the classifier's pick, not B
    });

    it("multi-produce: a BELOW-THRESHOLD classifier decision settles no_match (fail-closed, never guesses)", async () => {
      const EXT_A = "@cinatra-ai/multi-thresh-a-artifact";
      const TYPE_A = `${EXT_A}:document`;
      const EXT_B = "@cinatra-ai/multi-thresh-b-artifact";
      const TYPE_B = `${EXT_B}:document`;
      registerArtifactType(TYPE_A, EXT_A, ["application/json"]);
      registerArtifactType(TYPE_B, EXT_B, ["application/json"]);
      await seedActiveClaim({ typeId: TYPE_A, extension: EXT_A });
      await seedActiveClaim({ typeId: TYPE_B, extension: EXT_B });

      const { templateId, runId } = await seedTemplateAndRun({ packageName: EXT_A });
      contextByTemplate.set(templateId, {
        producesRefs: [
          { extension: EXT_A, objectTypeId: TYPE_A },
          { extension: EXT_B, objectTypeId: TYPE_B },
        ],
        hasBindings: false,
      });
      await seedOutbox({ runId, templateId, content: JSON.stringify({ x: 1 }), contentIsJson: true });

      const { outcome } = await deriveMod.deriveUnboundRunOutput(
        { runId, orgId: ORG },
        { classify: async () => ({ objectTypeId: TYPE_A, confidence: 0.4 }) }, // < 0.8
      );
      expect(outcome).toBe("no_match");
      expect(await derivedLedgerCount(runId)).toBe(0); // never guesses a type
    });

    it("write fence: a lease RECLAIMED during derivation aborts the write — no stale artifact (residual A)", async () => {
      const EXT_A = "@cinatra-ai/fence-a-artifact";
      const TYPE_A = `${EXT_A}:document`;
      const EXT_B = "@cinatra-ai/fence-b-artifact";
      const TYPE_B = `${EXT_B}:document`;
      registerArtifactType(TYPE_A, EXT_A, ["application/json"]);
      registerArtifactType(TYPE_B, EXT_B, ["application/json"]);
      await seedActiveClaim({ typeId: TYPE_A, extension: EXT_A });
      await seedActiveClaim({ typeId: TYPE_B, extension: EXT_B });

      const { templateId, runId } = await seedTemplateAndRun({ packageName: EXT_A });
      contextByTemplate.set(templateId, {
        producesRefs: [
          { extension: EXT_A, objectTypeId: TYPE_A },
          { extension: EXT_B, objectTypeId: TYPE_B },
        ],
        hasBindings: false,
      });
      await seedOutbox({ runId, templateId, content: JSON.stringify({ fence: 1 }), contentIsJson: true });

      const { outcome } = await deriveMod.deriveUnboundRunOutput(
        { runId, orgId: ORG },
        {
          // Simulate an expiry-sweep reclaiming the row WHILE this driver's slow
          // classifier runs: steal the lease token. The write fence
          // (reacquireLeaseForWrite) must then abort before materializing.
          classify: async () => {
            await client.query(
              `UPDATE "${S()}"."agent_run_output_derivations" SET lease_token = 'stolen-by-sweep' WHERE run_id = $1`,
              [runId],
            );
            return { objectTypeId: TYPE_A, confidence: 0.95 };
          },
        },
      );

      expect(outcome).toBe("skipped"); // fenced — never materialized under a lost lease
      expect(await derivedLedgerCount(runId)).toBe(0); // NO stale artifact
      expect(await outboxStatus(runId)).toBe("deriving"); // left as the reclaimer holds it
    });

    it("derived_output ledger dedupe key + Q3 different-path alias guard (AC5)", async () => {
      const EXT = "@cinatra-ai/dedupe-artifact";
      const TYPE = `${EXT}:document`;
      registerArtifactType(TYPE, EXT, ["application/json"]);
      await seedActiveClaim({ typeId: TYPE, extension: EXT });

      const runId = `run-${randomUUID()}`;
      await client.query(
        `INSERT INTO "${S()}"."agent_runs" (id, template_id, input_params, status, org_id)
         VALUES ($1, 'tmpl-dedupe', '{}', 'completed', $2)`,
        [runId, ORG],
      );
      const content = JSON.stringify({ dedupe: true });
      const ownership = {
        ownerLevel: "organization" as const,
        ownerId: ORG,
        visibility: "organization" as const,
        projectId: null,
      };
      const writeArgs = {
        runId,
        orgId: ORG,
        createdBy: null,
        outputId: deriveMod.DERIVED_OUTPUT_LEDGER_OUTPUT_ID,
        nodeId: null,
        extension: EXT,
        title: "Derived output",
        mime: "application/json",
        content,
        ownership,
        resolvedTarget: { objectTypeId: TYPE, acceptedFileMimeTypes: ["application/json"] },
        mimeDescription: "the derived output MIME",
      };

      const w1 = await materializerMod.writeClaimedArtifact({ ...writeArgs, path: "derived_output" });
      expect(w1.ok).toBe(true);
      if (!w1.ok) throw new Error(w1.error);
      expect(w1.deduped).toBe(false);

      // Same 4-part identity (run, sentinel output_id, extension, content_hash) on
      // the SAME derived_output path ⇒ the ledger dedupe returns the SAME artifact.
      const w2 = await materializerMod.writeClaimedArtifact({ ...writeArgs, path: "derived_output" });
      expect(w2.ok).toBe(true);
      if (!w2.ok) throw new Error(w2.error);
      expect(w2.deduped).toBe(true);
      expect(w2.artifactId).toBe(w1.artifactId);
      expect(await derivedLedgerCount(runId)).toBe(1); // exactly one ledger row

      // Q3: the 4-part key excludes `path`. A finalized hit whose path DIFFERS
      // from this write's path is a foreign row — refuse to alias (fail closed).
      const w3 = await materializerMod.writeClaimedArtifact({ ...writeArgs, path: "end_node_binding" });
      expect(w3.ok).toBe(false);
      if (w3.ok) throw new Error("expected the path-collision guard to refuse");
      expect(w3.error).toMatch(/refusing to alias/);
    });

    it("reconciliation sweep CONVERGES: settled rows are never re-selected (AC4)", async () => {
      createNotificationForRecipientMock.mockClear();
      // A settled no_match row must be inert to the sweep.
      const settled = await seedTemplateAndRun({ packageName: null });
      await seedOutbox({
        runId: settled.runId,
        templateId: settled.templateId,
        content: "already settled",
        contentIsJson: false,
        status: "no_match",
      });
      // A fresh pending row the sweep SHOULD drain (no produces ⇒ no_produces).
      const pending = await seedTemplateAndRun({ packageName: null, templateName: "Pending Agent" });
      await seedOutbox({
        runId: pending.runId,
        templateId: pending.templateId,
        content: "pending output",
        contentIsJson: false,
        createdBy: "user-y",
      });

      const first = await deriveMod.sweepPendingUnboundDerivations();
      expect(first.attempted).toBe(1); // only the pending row — the settled one is not re-selected
      expect(first.no_produces).toBe(1);
      expect(await outboxStatus(pending.runId)).toBe("no_produces");
      expect(await outboxStatus(settled.runId)).toBe("no_match"); // unchanged

      // A second sweep now finds NOTHING outstanding — full convergence.
      const second = await deriveMod.sweepPendingUnboundDerivations();
      expect(second.attempted).toBe(0);
    });
  },
);
