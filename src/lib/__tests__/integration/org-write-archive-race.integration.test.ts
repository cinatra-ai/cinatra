/**
 * cinatra#1939 wave 3 (R-acc) — the two-connection post-check archive race
 * loses DETERMINISTICALLY, proven with the kernel-level archive-transition
 * harness (`simulateArchiveTransition` / `holdOrgLocks`) against real Postgres.
 * No timing sleeps drive correctness — the advisory locks force the ordering.
 *
 * The harness is the kernel-truthful oracle for the invariant the race asserts
 * ("the epoch bumped and the state flipped under BOTH org locks") — NOT the S6
 * archive transaction's business logic (session deactivation etc. is S6's and
 * untested here). When S6 lands the real archive transaction, these races
 * re-point at it with the SAME assertions.
 *
 * Runs only under CINATRA_DB_INTEGRATION_TESTS=1 with a real SUPABASE_DB_URL
 * (the extension-lifecycle-db-tests CI job); self-skips otherwise. NOT run on
 * the operator box (no DB / dev-server there) — CI is the authority.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client, Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  guardOrgMutation,
  guardOrgLifecycleMutation,
  redeemCompletionTicket,
  OrgWriteRefusedError,
  type OrgWriteAuthority,
  type OrgWriteDb,
  type OrgWriteTx,
} from "@cinatra-ai/org-write-kernel";
import {
  simulateArchiveTransition,
  holdOrgLocks,
} from "@cinatra-ai/org-write-kernel/testing";

const dbUrl = process.env.SUPABASE_DB_URL ?? "";
const enabled =
  process.env.CINATRA_DB_INTEGRATION_TESTS === "1" &&
  dbUrl !== "" &&
  !dbUrl.includes("unused:unused");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const PUBLIC_SCHEMA_SQL = path.join(REPO_ROOT, "tests/e2e/rbac/fixtures/public-schema.sql");

const anyAuthority = (orgId: string): OrgWriteAuthority => ({
  orgId,
  can: () => true,
});

async function applyStoreDdl(client: Client, schema: string): Promise<void> {
  for (const q of buildCreateStoreSchemaQueries(schema)) {
    const head = q.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
      continue;
    }
    try {
      await client.query(q.text, q.values ?? []);
    } catch (err) {
      if (!(err instanceof Error) || !err.message.includes("does not exist")) throw err;
    }
  }
}

describe.skipIf(!enabled)("org-write archive race — kernel harness on live Postgres (#1939)", () => {
  let root: Client;
  let pool: Pool;
  let db: OrgWriteDb<OrgWriteTx>;
  let schema: string;
  let orgId: string;

  beforeAll(async () => {
    root = new Client({ connectionString: dbUrl });
    await root.connect();
    // The committed Better-Auth public schema (organization + archivedAt/
    // archiveEpoch columns) — idempotent (CREATE/ALTER … IF NOT EXISTS).
    await root.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));
    schema = `cinatra_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await root.query(`CREATE SCHEMA "${schema}"`);
    await applyStoreDdl(root, schema);
    pool = new Pool({ connectionString: dbUrl });
    db = drizzle(pool) as unknown as OrgWriteDb<OrgWriteTx>;
  });

  afterAll(async () => {
    await pool?.end();
    if (root) {
      await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await root.end();
    }
  });

  beforeEach(async () => {
    // A fresh ACTIVE org per test (public.organization is shared; unique id).
    orgId = `org_race_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await root.query(
      `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
      [orgId, "Archive Race", orgId],
    );
  });

  async function dropOrg(): Promise<void> {
    await root.query(`DELETE FROM public."organization" WHERE id = $1`, [orgId]);
  }

  it("a guarded content.write refuses AFTER the org archives (post-check, capability-denied)", async () => {
    try {
      const { archiveEpoch } = await simulateArchiveTransition(db, {
        schema,
        orgId,
        to: "archived",
      });
      expect(archiveEpoch).toBe(1);
      let ran = false;
      await expect(
        guardOrgMutation(
          db,
          { orgId, capability: "content.write", authority: anyAuthority(orgId) },
          async () => {
            ran = true;
          },
        ),
      ).rejects.toMatchObject({ reason: "capability-denied" });
      expect(ran).toBe(false);
    } finally {
      await dropOrg();
    }
  });

  it("a completion ticket minted at epoch N refuses after the harness bumps to N+1 (epoch staleness)", async () => {
    try {
      const runId = `run_${randomUUID().slice(0, 8)}`;
      const attemptId = `att_${randomUUID().slice(0, 8)}`;
      const idempotencyKey = `idem_${randomUUID().slice(0, 8)}`;
      // Ticket minted at the CURRENT epoch (0), valid + unconsumed.
      await root.query(
        `INSERT INTO "${schema}"."org_write_completion_ticket"
           (org_id, archive_epoch, run_id, execution_attempt_id, output_ref, idempotency_key, expires_at, consumed_at)
         VALUES ($1, 0, $2, $3, $4, $5, now() + interval '1 hour', NULL)`,
        [orgId, runId, attemptId, "out:v1", idempotencyKey],
      );
      // Archive → epoch bumps to 1, invalidating every outstanding ticket.
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });

      const runAuthority: OrgWriteAuthority = {
        orgId,
        runId,
        executionAttemptId: attemptId,
        can: (c) => c === "run.complete",
      };
      await expect(
        redeemCompletionTicket(
          db,
          { schema, orgId, authority: runAuthority, idempotencyKey, outputRef: "out:v1" },
          async () => "landed",
        ),
      ).rejects.toBeInstanceOf(OrgWriteRefusedError);
    } finally {
      await dropOrg();
    }
  });

  it("two-connection post-check race: a guarded write blocks behind the lifecycle locks, then LOSES to the committed archive (capability-denied)", async () => {
    // The full composed choreography (holdOrgLocks + archive-under-the-locks +
    // blocked writer), forced entirely by the advisory locks — no timing sleeps
    // drive correctness.
    const blocker = new Client({ connectionString: dbUrl });
    await blocker.connect();
    try {
      // B holds BOTH lifecycle locks (an in-progress archive) via the harness.
      const hold = await holdOrgLocks(blocker, { orgId, epoch: true });
      // A issues a guarded content.write on the still-active org → it BLOCKS on
      // the write lock B holds and cannot even reach its locked state read.
      let aRan = false;
      const aPromise = guardOrgMutation(
        db,
        { orgId, capability: "content.write", authority: anyAuthority(orgId) },
        async () => {
          aRan = true;
          return "A-wrote";
        },
      );
      // Bounded confirmation A is genuinely blocked (not merely slow).
      const raced = await Promise.race([
        aPromise.then(() => "A-settled", () => "A-settled"),
        new Promise<string>((r) => setTimeout(() => r("A-blocked"), 300)),
      ]);
      expect(raced).toBe("A-blocked");
      // B completes the archive WITHIN its held transaction and commits — the
      // epoch bumped and the state flipped under BOTH locks, then released.
      await blocker.query(
        `UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1`,
        [orgId],
      );
      await hold.release();
      // A now acquires the lock; its locked state re-read sees ARCHIVED (read
      // committed) → content.write is denied. Deterministic loss; no row landed.
      await expect(aPromise).rejects.toMatchObject({ reason: "capability-denied" });
      expect(aRan).toBe(false);
    } finally {
      await blocker.end();
      await dropOrg();
    }
  });

  it("an ARCHIVED org admits the exclusive-fence delete capability (org.delete allow; happy path)", async () => {
    try {
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });
      let ran = false;
      const out = await guardOrgLifecycleMutation(
        db,
        { orgId, capability: "org.delete", authority: { orgId, can: (c) => c === "org.delete" } },
        async () => {
          ran = true;
          return "deleted";
        },
      );
      expect(out).toBe("deleted");
      expect(ran).toBe(true);
    } finally {
      await dropOrg();
    }
  });
});
