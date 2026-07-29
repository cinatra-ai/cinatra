/**
 * cinatra#1893 (epic #1883 slice A5) — the unbound-output derivation OUTBOX
 * CAPTURE transaction. REAL-store proof (no boundary stub at the capture seam):
 * the terminal status CAS + final-output snapshot + the
 * `agent_run_output_derivations` INSERT commit as ONE atomic unit inside
 * `transitionRunStatus`' `derivationOutbox` branch.
 *
 * Proves, against real DDL + constraints (fresh schema per file from the
 * CANONICAL `buildCreateStoreSchemaQueries` bootstrap — the migration-0071 twin):
 *   1. a WayFlow terminal-success transition (running→completed) carrying a
 *      derivationOutbox captures EXACTLY ONE `pending` outbox row atomically with
 *      the status flip + stepResults snapshot (content / content_hash / org /
 *      template / created_by all persisted);
 *   2. capture is IDEMPOTENT under a stop/retry re-drive — a second legal terminal
 *      edge for the same run (ON CONFLICT (run_id) DO NOTHING) never doubles nor
 *      overwrites the row (AC1: materialized exactly once under retries/stop races);
 *   3. a LOST terminal CAS (stale `from`) throws stale_from_status and writes
 *      NEITHER a status change NOR an outbox row — all-or-nothing (the losing
 *      driver captures nothing, so the winner's capture is unique);
 *   4. `derivationOutbox` is rejected for a non-`completed` target (the branch
 *      guard never absorbs a dispatch/HITL edge);
 *   5. the historical two-write path (no derivationOutbox) writes no outbox row —
 *      unchanged behavior for every other caller.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
 *     pnpm --filter @cinatra-ai/agents test unbound-output-outbox
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_unbound_outbox_1893";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-1893-outbox";

let store: typeof import("../store");
let dbMod: typeof import("../db");
let client: Client;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// cinatra#1939 wave 2: transitionRunStatus now runs under guardOrgMutation and
// REQUIRES a host-minted authority. A member-shaped authority for this fixture
// org grounds the guarded terminal writes; the local wrapper threads it so every
// call site below stays a 4-arg call. NOTE (integration-harness): the guard also
// reads the org's lifecycle from `public."organization"` — this DB-gated suite
// must have an ACTIVE org row for ORG for the guarded writes to pass at runtime.
const AUTH = { orgId: ORG, can: () => true };
const transitionRunStatus = (
  runId: string,
  from: import("../store").AgentRunStatus,
  to: import("../store").AgentRunStatus,
  meta?: Parameters<typeof store.transitionRunStatus>[3],
) => store.transitionRunStatus(runId, from, to, meta, AUTH);

/** Seed a template + a run FORCED to `running` (the legal terminal-success
 *  `from`), returning the run id. Uses the real store writers, then a direct
 *  status flip (the queued→running dispatch path is not under test here). */
async function seedRunningRun(input?: {
  packageVersion?: string;
  runBy?: string;
}): Promise<{ runId: string; templateId: string }> {
  const templateId = `tmpl-${randomUUID()}`;
  await store.createAgentTemplate({
    id: templateId,
    name: `outbox-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: `@test/${templateId}`,
    orgId: ORG,
  });
  const runId = `run-${randomUUID()}`;
  await store.createAgentRun({
    id: runId,
    templateId,
    inputParams: {},
    orgId: ORG,
    runBy: input?.runBy,
    packageVersion: input?.packageVersion,
  }, AUTH);
  await client.query(
    `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'running' WHERE id = $1`,
    [runId],
  );
  return { runId, templateId };
}

async function readOutbox(runId: string) {
  const res = await client.query(
    `SELECT run_id, org_id, template_id, package_version, created_by, content,
            content_is_json, content_hash, status, attempts
       FROM "${q(TEST_SCHEMA)}"."agent_run_output_derivations" WHERE run_id = $1`,
    [runId],
  );
  return res.rows as Array<Record<string, unknown>>;
}

async function readRunStatus(runId: string): Promise<string | null> {
  const res = await client.query(
    `SELECT status FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
    [runId],
  );
  return (res.rows[0]?.status as string | undefined) ?? null;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // pgSchema() reads SUPABASE_SCHEMA at module-load; set it BEFORE the first
  // dynamic import of ../store / ../schema / ../db.
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S"
    )
      continue;
    // Skip the GLOBAL public."user" slug trigger (not schema-local): two
    // bootstrapping integration tests racing under file-parallelism collide on it.
    // This suite never touches public."user".
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Cross-schema FKs to public."user"/"organization" (Better Auth) are not
      // provisioned in this app-schema-only fixture — tolerate their absence
      // ("does not exist"); also tolerate GLOBAL public objects (e.g. the
      // user_slug_move_trg trigger on public."user") a sibling integration test
      // already created in this DB ("already exists").
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  store = await import("../store");
  dbMod = await import("../db");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  // The guard reads the org's lifecycle from public."organization" (see the
  // AUTH comment above) — seed the ACTIVE row this suite's guarded writes need.
  await client.query(
    `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
    [ORG, ORG, ORG],
  );
}, 90_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.query(`DELETE FROM public."organization" WHERE id = $1`, [ORG]).catch(() => {});
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)(
  "cinatra#1893 — unbound-output outbox capture (real store, one transaction)",
  () => {
    it("captures exactly one pending outbox row ATOMICALLY with the terminal CAS + snapshot", async () => {
      const { runId, templateId } = await seedRunningRun({
        packageVersion: "1.2.3",
        runBy: "user-owner",
      });
      const content = JSON.stringify({ headline: "captured", n: 7 });
      await transitionRunStatus(runId, "running", "completed", {
        completedAt: new Date(),
        stepResults: [{ kind: "wayflow_response", output: content }],
        derivationOutbox: {
          orgId: ORG,
          templateId,
          packageVersion: "1.2.3",
          createdBy: "user-owner",
          content,
          contentIsJson: true,
          contentHash: sha(content),
        },
      });

      expect(await readRunStatus(runId)).toBe("completed");
      const rows = await readOutbox(runId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.status).toBe("pending");
      expect(row.org_id).toBe(ORG);
      expect(row.template_id).toBe(templateId);
      expect(row.package_version).toBe("1.2.3");
      expect(row.created_by).toBe("user-owner");
      expect(row.content).toBe(content);
      expect(row.content_is_json).toBe(true);
      expect(row.content_hash).toBe(sha(content));
      expect(row.attempts).toBe(0);
    });

    it("is idempotent under a stop/retry re-drive — ON CONFLICT (run_id) DO NOTHING keeps the FIRST capture", async () => {
      const { runId, templateId } = await seedRunningRun();
      const first = "first output";
      await transitionRunStatus(runId, "running", "completed", {
        completedAt: new Date(),
        derivationOutbox: {
          orgId: ORG,
          templateId,
          packageVersion: null,
          createdBy: null,
          content: first,
          contentIsJson: false,
          contentHash: sha(first),
        },
      });
      // Simulate a stop/retry re-drive that also wins a (fresh) legal terminal
      // edge for the SAME run: reset to running, transition again with DIFFERENT
      // content. The outbox INSERT must be a no-op (PK run_id already present).
      await client.query(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'running' WHERE id = $1`,
        [runId],
      );
      const second = "second output — must NOT overwrite the capture";
      await transitionRunStatus(runId, "running", "completed", {
        completedAt: new Date(),
        derivationOutbox: {
          orgId: ORG,
          templateId,
          packageVersion: null,
          createdBy: null,
          content: second,
          contentIsJson: false,
          contentHash: sha(second),
        },
      });

      const rows = await readOutbox(runId);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe(first); // the FIRST capture is preserved
      expect(rows[0].content_hash).toBe(sha(first));
    });

    it("a LOST terminal CAS (stale from) writes NEITHER the status flip NOR an outbox row", async () => {
      const { runId, templateId } = await seedRunningRun();
      // Move the run out from under the drive: it is already completed.
      await client.query(
        `UPDATE "${q(TEST_SCHEMA)}"."agent_runs" SET status = 'completed' WHERE id = $1`,
        [runId],
      );
      let threw: unknown = null;
      try {
        await transitionRunStatus(runId, "running", "completed", {
          completedAt: new Date(),
          derivationOutbox: {
            orgId: ORG,
            templateId,
            packageVersion: null,
            createdBy: null,
            content: "lost race",
            contentIsJson: false,
            contentHash: sha("lost race"),
          },
        });
      } catch (err) {
        threw = err;
      }
      expect(threw).not.toBeNull();
      expect((threw as { code?: string }).code ?? String(threw)).toMatch(
        /stale_from_status/,
      );
      // The whole transaction rolled back: no outbox row was inserted.
      expect(await readOutbox(runId)).toHaveLength(0);
    });

    it("rejects derivationOutbox for a non-completed target (branch guard)", async () => {
      const { runId, templateId } = await seedRunningRun();
      let threw: unknown = null;
      try {
        await transitionRunStatus(runId, "running", "failed", {
          error: "boom",
          derivationOutbox: {
            orgId: ORG,
            templateId,
            packageVersion: null,
            createdBy: null,
            content: "x",
            contentIsJson: false,
            contentHash: sha("x"),
          },
        });
      } catch (err) {
        threw = err;
      }
      expect(threw).not.toBeNull();
      expect(String((threw as Error).message)).toMatch(/only legal for to==="completed"/);
      // Guard rejected before any write: run still running, no outbox row.
      expect(await readRunStatus(runId)).toBe("running");
      expect(await readOutbox(runId)).toHaveLength(0);
    });

    it("the historical two-write path (no derivationOutbox) writes no outbox row", async () => {
      const { runId } = await seedRunningRun();
      await transitionRunStatus(runId, "running", "completed", {
        completedAt: new Date(),
      });
      expect(await readRunStatus(runId)).toBe("completed");
      expect(await readOutbox(runId)).toHaveLength(0);
    });
  },
);
