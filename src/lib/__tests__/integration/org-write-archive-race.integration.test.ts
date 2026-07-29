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
 *
 * EXTENDED for cinatra#1943 (adversarial acceptance suite, tier A0) —
 * extending this file in place rather than forking a parallel one, per this
 * program's convention (w3-1939 Decision 9, r-1940 Decision 8, v-1942
 * Decision 5's test plan all extend this same file). New tests below cover:
 * multi-cycle ticket replay across an unarchive/re-archive cycle; the
 * delete-vs-completion race; platform-admin denial; lease-gated refusal of
 * ambient/forged/cross-run authorities (defense-in-depth alongside
 * src/lib/org-write/__tests__/authority-1938.test.ts's mint-layer proof and
 * packages/agents/src/__tests__/run-authority-adversarial.test.ts's fake-db
 * unit proof — this file is the REAL-DB layer, proving the kernel's actual
 * SQL re-derives the lease decision rather than trusting a caller's claim);
 * and the kernel half of the bounded-contention / eventual-successful-archive
 * criterion (Decision 8 — the end-to-end half lands with #1942 V5, tier A6).
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

  // -------------------------------------------------------------------------
  // cinatra#1943 A0 — coverage-completeness manifest row 3: multi-cycle
  // ticket replay + unarchive/re-archive epoch invalidation.
  // -------------------------------------------------------------------------

  it("ticket replay across an unarchive/re-archive cycle: a stale ticket never un-refuses, and a fresh ticket at the new epoch redeems (positive control)", async () => {
    try {
      const runId = `run_${randomUUID().slice(0, 8)}`;
      const attemptId = `att_${randomUUID().slice(0, 8)}`;
      const staleKey = `idem_stale_${randomUUID().slice(0, 8)}`;
      // A ticket minted at epoch 0 (the org's initial epoch, before any
      // archive/unarchive transition has run).
      await root.query(
        `INSERT INTO "${schema}"."org_write_completion_ticket"
           (org_id, archive_epoch, run_id, execution_attempt_id, output_ref, idempotency_key, expires_at, consumed_at)
         VALUES ($1, 0, $2, $3, $4, $5, now() + interval '1 hour', NULL)`,
        [orgId, runId, attemptId, "out:v1", staleKey],
      );
      const runAuthority: OrgWriteAuthority = {
        orgId,
        runId,
        executionAttemptId: attemptId,
        can: (c) => c === "run.complete",
      };
      const attemptRedeem = () =>
        redeemCompletionTicket(
          db,
          { schema, orgId, authority: runAuthority, idempotencyKey: staleKey, outputRef: "out:v1" },
          async () => "landed",
        );

      // Archive -> epoch 1. The epoch-0 ticket is now stale.
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });
      await expect(attemptRedeem()).rejects.toMatchObject({ reason: "ticket-invalid" });

      // Unarchive -> epoch 2. Epoch strictly increases (never wraps); the
      // SAME stale ticket must NOT un-refuse just because the org is active
      // again.
      await simulateArchiveTransition(db, { schema, orgId, to: "active" });
      await expect(attemptRedeem()).rejects.toMatchObject({ reason: "ticket-invalid" });

      // Archive again -> epoch 3. Still refused — the ticket was never
      // valid at any epoch after its own (0).
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });
      await expect(attemptRedeem()).rejects.toMatchObject({ reason: "ticket-invalid" });

      // Positive control: a FRESH ticket minted AT the current epoch (3)
      // DOES redeem — proves the gate isn't just permanently closed by a bug.
      const freshKey = `idem_fresh_${randomUUID().slice(0, 8)}`;
      await root.query(
        `INSERT INTO "${schema}"."org_write_completion_ticket"
           (org_id, archive_epoch, run_id, execution_attempt_id, output_ref, idempotency_key, expires_at, consumed_at)
         VALUES ($1, 3, $2, $3, $4, $5, now() + interval '1 hour', NULL)`,
        [orgId, runId, attemptId, "out:v2", freshKey],
      );
      const outcome = await redeemCompletionTicket(
        db,
        { schema, orgId, authority: runAuthority, idempotencyKey: freshKey, outputRef: "out:v2" },
        async () => "landed-fresh",
      );
      expect(outcome).toEqual({ alreadyApplied: false, result: "landed-fresh" });
    } finally {
      await dropOrg();
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#1943 A0 — manifest row 4: delete-vs-completion race.
  // -------------------------------------------------------------------------

  it("delete-vs-completion race: a run.complete write queued behind a guarded delete's exclusive fence sees the committed delete, never landing into a deleted org", async () => {
    const blocker = new Client({ connectionString: dbUrl });
    await blocker.connect();
    try {
      const runId = `run_${randomUUID().slice(0, 8)}`;
      const attemptId = `att_${randomUUID().slice(0, 8)}`;
      // Archive the org and mint a valid, unexpired lease directly (same
      // direct-insert convention as the ticket tests above) so the
      // completion write's OWN lease check would otherwise succeed absent
      // the race — isolating the assertion to the race itself, not the
      // lease mechanism.
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });
      await root.query(
        `INSERT INTO "${schema}"."org_archive_lease"
           (org_id, archive_epoch, run_id, execution_attempt_id, acquired_at, expires_at)
         VALUES ($1, 1, $2, $3, now(), now() + interval '1 hour')`,
        [orgId, runId, attemptId],
      );
      const runAuthority: OrgWriteAuthority = {
        orgId,
        runId,
        executionAttemptId: attemptId,
        can: (c) => c === "run.complete",
      };

      // B holds BOTH lifecycle locks — simulating a guarded delete in
      // flight (guardOrgLifecycleMutation's own epoch->write acquisition).
      const hold = await holdOrgLocks(blocker, { orgId, epoch: true });

      // A: a run.complete completion write on the archived org. It BLOCKS on
      // the write lock B holds (guardOrgMutation is write-only) and cannot
      // even reach its own locked state read.
      let aRan = false;
      const aPromise = guardOrgMutation(
        db,
        { orgId, capability: "run.complete", authority: runAuthority, schema },
        async () => {
          aRan = true;
          return "A-completed";
        },
      );
      const raced = await Promise.race([
        aPromise.then(() => "A-settled", () => "A-settled"),
        new Promise<string>((r) => setTimeout(() => r("A-blocked"), 300)),
      ]);
      expect(raced).toBe("A-blocked");

      // B completes the delete WITHIN its held transaction — the org row
      // itself is gone — and commits.
      await blocker.query(`DELETE FROM public."organization" WHERE id = $1`, [orgId]);
      await hold.release();

      // A now acquires the lock; its locked state re-read finds NO
      // organization — refused fail-closed, never landing a completion
      // write for an org that no longer exists (no torn write; whichever
      // side arrives second sees the other's committed state).
      await expect(aPromise).rejects.toMatchObject({ reason: "organization-not-found" });
      expect(aRan).toBe(false);
    } finally {
      await blocker.end();
      // The org row is already gone (B deleted it); dropOrg() is then a
      // harmless no-op DELETE.
      await dropOrg();
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#1943 A0 — manifest row 5: platform-admin denial.
  // -------------------------------------------------------------------------

  it("platform-admin denial: an unconditionally-permissive authority is still refused for a mismatched org (org-scope beats any elevated capability bit)", async () => {
    try {
      // An authority whose can() grants EVERYTHING (simulating an elevated
      // platform-wide permission bit) but minted for a DIFFERENT org. The
      // wave-2 "cross-org run management refuses fail-closed" ruling pinned
      // adversarially: org-scope is checked independently of, and before,
      // any capability grant — an elevated `can()` can never stand in for
      // the right org.
      const platformAdminForOtherOrg: OrgWriteAuthority = {
        orgId: "org-platform-admin-different-org",
        can: () => true,
      };
      let ran = false;
      await expect(
        guardOrgMutation(
          db,
          { orgId, capability: "content.write", authority: platformAdminForOtherOrg },
          async () => {
            ran = true;
          },
        ),
      ).rejects.toMatchObject({ reason: "authority-org-mismatch" });
      expect(ran).toBe(false);
    } finally {
      await dropOrg();
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#1943 A0 — bonus defense-in-depth for manifest rows 1 & 2 (the
  // MANIFEST's canonical proofs for these rows are
  // src/lib/org-write/__tests__/authority-1938.test.ts and
  // packages/agents/src/__tests__/run-authority-adversarial.test.ts, both
  // already CI-wired without a DB dependency; this test adds the REAL-SQL
  // layer those two do not cover — the kernel's OWN lease-gated re-check
  // against a real org_archive_lease row, independent of whatever the
  // caller's authority object merely CLAIMS).
  // -------------------------------------------------------------------------

  it("lease-gated run.complete refuses an ambient (unbound), a forged (wrong attempt id), and a cross-run authority — only the exact leased run/attempt redeems", async () => {
    try {
      const runId = `run_${randomUUID().slice(0, 8)}`;
      const attemptId = `att_${randomUUID().slice(0, 8)}`;
      const otherRunId = `run_${randomUUID().slice(0, 8)}`;
      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });
      await root.query(
        `INSERT INTO "${schema}"."org_archive_lease"
           (org_id, archive_epoch, run_id, execution_attempt_id, acquired_at, expires_at)
         VALUES ($1, 1, $2, $3, now(), now() + interval '1 hour')`,
        [orgId, runId, attemptId],
      );

      // Ambient: no run binding at all — refused before any lease query.
      const ambient: OrgWriteAuthority = { orgId, can: (c) => c === "run.complete" };
      await expect(
        guardOrgMutation(db, { orgId, capability: "run.complete", authority: ambient, schema }, async () => "unreached"),
      ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });

      // Forged: a well-formed but WRONG execution-attempt id for this run.
      const forged: OrgWriteAuthority = {
        orgId,
        runId,
        executionAttemptId: "att_forged_not_leased",
        can: (c) => c === "run.complete",
      };
      await expect(
        guardOrgMutation(db, { orgId, capability: "run.complete", authority: forged, schema }, async () => "unreached"),
      ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });

      // Cross-run: a DIFFERENT run in the same org, even reusing the real
      // attempt id string, cannot ride this run's lease.
      const crossRun: OrgWriteAuthority = {
        orgId,
        runId: otherRunId,
        executionAttemptId: attemptId,
        can: (c) => c === "run.complete",
      };
      await expect(
        guardOrgMutation(db, { orgId, capability: "run.complete", authority: crossRun, schema }, async () => "unreached"),
      ).rejects.toMatchObject({ reason: "lease-required-but-not-held" });

      // Positive control: the EXACT leased run/attempt DOES redeem the
      // lease-gated ruling — proves the gate isn't just permanently closed.
      let ran = false;
      const exact: OrgWriteAuthority = { orgId, runId, executionAttemptId: attemptId, can: (c) => c === "run.complete" };
      const out = await guardOrgMutation(db, { orgId, capability: "run.complete", authority: exact, schema }, async () => {
        ran = true;
        return "landed";
      });
      expect(out).toBe("landed");
      expect(ran).toBe(true);
    } finally {
      await dropOrg();
    }
  });

  // -------------------------------------------------------------------------
  // cinatra#1943 A0 — manifest row 14, KERNEL subproof only (Decision 8: a
  // bounded WALL-CLOCK deadline under a fixed, finite writer count — never
  // an ordering/fairness claim, since Postgres
  // documents no waiter-FIFO guarantee for advisory locks. The row itself
  // stays red until the e2e subproof lands with #1942 V5, tier A6 — Decision
  // 1's AND-of-subproofs rule.). This is the one test in the file that is
  // INHERENTLY wall-clock-shaped, unlike the deterministic lock-order races
  // above (which never rely on a timing sleep for correctness) — the
  // generous absolute deadline below is the honest form of that claim.
  // -------------------------------------------------------------------------

  it("bounded contention: a fixed, finite set of concurrent guarded writers never blocks the exclusive fence past a generous deadline, and the fence succeeds once the writers drain", async () => {
    try {
      const WRITER_COUNT = 4;
      const ITERATIONS_PER_WRITER = 3;
      const DEADLINE_MS = 10_000;

      // Resolves the first time ANY writer is actually inside its guarded
      // critical section (holding the exclusive write lock) — the fence
      // request below is deliberately not issued until this resolves, so
      // real contention is GUARANTEED to exist when the fence attempts to
      // acquire, rather than merely likely (a fence issued before any
      // writer has entered its critical section would prove nothing about
      // contention).
      let signalWriterEntered: () => void;
      const firstWriterEntered = new Promise<void>((resolve) => {
        signalWriterEntered = resolve;
      });

      async function writerCycle(): Promise<void> {
        for (let i = 0; i < ITERATIONS_PER_WRITER; i++) {
          await guardOrgMutation(
            db,
            { orgId, capability: "content.write", authority: anyAuthority(orgId) },
            async () => {
              signalWriterEntered();
              // A short, deliberate in-transaction hold so the writers
              // create REAL sustained contention against the fence request
              // below (a fixed, finite loop — not an infinite hammer, which
              // would make "bounded" meaningless even with fairness).
              await new Promise((r) => setTimeout(r, 15));
            },
          );
        }
      }

      const writers = Array.from({ length: WRITER_COUNT }, () => writerCycle());
      await firstWriterEntered;

      let fenceRan = false;
      const fencePromise = guardOrgLifecycleMutation(
        db,
        { orgId, capability: "org.lifecycle", authority: anyAuthority(orgId) },
        async () => {
          fenceRan = true;
          return "fenced";
        },
      );

      const contentionSettled = Promise.all([fencePromise, ...writers]);

      // Phase 1 (bounded): race the WHOLE contention window against an
      // explicit harness-level deadline, so a genuine hang produces THIS
      // test's own informative "deadline-exceeded" failure rather than
      // silently relying on vitest's own (much longer) test timeout to
      // eventually time out with a generic message. No ordering/fairness
      // claim (Decision 8's revised finding: PostgreSQL documents no
      // waiter-FIFO guarantee for advisory locks) — only that it resolves,
      // one way or another, inside the deadline.
      const raced = await Promise.race([
        contentionSettled.then(() => "settled" as const),
        new Promise<"deadline-exceeded">((resolve) =>
          setTimeout(() => resolve("deadline-exceeded"), DEADLINE_MS),
        ),
      ]);
      expect(raced).toBe("settled");

      // Phase 2 (eventual success): `contentionSettled` is already resolved
      // at this point (Phase 1 just proved it settled within budget) — the
      // fence request actually SUCCEEDS once the fixed, finite writer set
      // drains. "Bounded" alone would pass even if the fence never got in;
      // this is the other half of "eventual-successful-archive".
      const [fenceResult] = await contentionSettled;
      expect(fenceResult).toBe("fenced");
      expect(fenceRan).toBe(true);
    } finally {
      await dropOrg();
    }
  });
});
