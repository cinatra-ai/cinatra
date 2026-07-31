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
 *
 * EXTENDED again for cinatra#1943 tier A6, now that #1942 V5 (the real
 * archiveOrganization/unarchiveOrganization transaction, including its
 * owner-ruled lock_timeout + bounded-retry wrapper) has landed on main: a
 * third describe block below drives that REAL product entry point under
 * contention, closing manifest row 14's e2e subproof (Decision 1's
 * AND-of-subproofs rule — the kernel subproof in the first block below is
 * not, by itself, enough once the criterion is live/product-level).
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
import {
  ensureAuthFloorArchiveGuardTriggers,
  ensureSessionActivationGuardTrigger,
} from "../../../../scripts/better-auth-migrate.mts";
import {
  archiveOrganization,
  isArchiveActivationEnabled,
  ORG_ARCHIVE_ACTIVATION_CONFIG_KEY,
} from "@/lib/organization-archive";
import { betterAuthPool } from "@/lib/better-auth-db";
// ---------------------------------------------------------------------------
// `@/lib/database` seam for the A6 block (the LAST describe block below).
//
// The root vitest config ALIASES `@/lib/database` to
// tests/__stubs__/database.ts (see vitest.config.ts's alias table), so the
// real connector-config store is structurally unreachable from any root
// vitest run — including this CI job. `archiveOrganization`'s own
// activation-gate read (`isArchiveActivationEnabled` →
// `await import("@/lib/database")`) resolves through that same alias, so the
// STUB is where the gate must be seedable ON. The stub carries a seedable
// in-memory connector-config pair for exactly this purpose (see its own
// comment) — this import resolves to it via the alias, and the A6 beforeAll
// seeds `{enabled:true}` through it.
//
// Deliberately NOT a vi.mock: rounds 1-3 of PR #2280 proved a vi.mock seam
// is not concurrency-safe under OVERLAPPING dynamic imports of the mocked
// id — in CI, a 5-way concurrent burst of gate reads saw the mock on
// exactly ONE caller and fell through to the (then-functionless) alias stub
// on the other four, whose TypeError was swallowed by the gate read's
// fail-closed try/catch into `activation-gate-off`; serial reads (the
// beforeAll verify, the two later tests) always worked. With the seam in
// the alias target itself there is no mocker in the loop: the module cache
// guarantees ONE namespace for every importer, static or dynamic,
// overlapping or not. (The PRODUCTION path is immune to the analogous race:
// the real readConnectorConfigFromDatabase is fully synchronous — TTL cache
// + sync worker-thread bridge, no async in-flight window — and concurrent
// import() of an evaluated module is deduped by the ES module map.)
//
// Honest scope of what gets faked: the GATE READ — a config-row lookup whose
// on/off/error semantics are already exhaustively pinned elsewhere
// (organization-archive-gate.test.ts's six-cell matrix, the staging flip
// script's own tests). Everything the A6 block actually proves — the real
// transaction, the kernel's advisory-lock fence, the lock_timeout +
// bounded-retry wrapper, real concurrent Postgres connections — runs REAL.
// The two earlier describe blocks never read connector config, so the
// seeded key is invisible to them.
// ---------------------------------------------------------------------------
import { writeConnectorConfigToDatabase as writeConnectorConfigSeam } from "@/lib/database";

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

  // -------------------------------------------------------------------------
  // cinatra#1942 V5 — the REAL archive transaction's DB-layer semantics,
  // proven on live Postgres UNDER THE ARMED GUARDS (the #1937 session
  // activation guard + the Stage E auth-floor triggers). The statements
  // exercised here are the EXACT shapes `archiveOrganization` /
  // `unarchiveOrganization` issue in-fence (their wire order is pinned
  // statement-by-statement in src/lib/__tests__/organization-archive-tx.test.ts;
  // the full app writer itself is unit-tier-driven there because it binds the
  // app auth stack, per the guarded-delete precedent).
  // -------------------------------------------------------------------------

  it("V5 session deactivation: clearing activeOrganizationId AND activeTeamId to NULL is PERMITTED under the armed guards even while the org is archived — and re-pointing back is BLOCKED (the Decision 2a contract pin)", async () => {
    // Arm BOTH DB floors (idempotent CREATE OR REPLACE): the #1937 session
    // activation guard and the Stage E member/invitation floor.
    await ensureSessionActivationGuardTrigger(pool);
    await ensureAuthFloorArchiveGuardTriggers(pool);
    const teamId = `team_${randomUUID().slice(0, 8)}`;
    // team_slug_format (pre-existing CHECK on public.team) disallows the
    // underscore in an id-shaped string — plant a distinct, hyphenated slug
    // rather than reusing teamId.
    const teamSlug = `archive-team-${randomUUID().slice(0, 8)}`;
    const s1 = `sess_${randomUUID().slice(0, 8)}`;
    const s2 = `sess_${randomUUID().slice(0, 8)}`;
    try {
      // The sessions below FK-reference this user (session_userId_fkey) —
      // same create-a-prerequisite-user convention as the BA-DML-vs-archive
      // describe block further down this file.
      await root.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)`,
        ["user_v5", "V5 Archive Test User", "user_v5@example.test"],
      );
      await root.query(
        `INSERT INTO public."team" (id, name, "organizationId", "createdAt", slug)
         VALUES ($1, 'Archive Team', $2, now(), $3)`,
        [teamId, orgId, teamSlug],
      );
      // Planted while the org is ACTIVE — the guard resolves and allows.
      await root.query(
        `INSERT INTO public."session" (id, "expiresAt", token, "updatedAt", "userId", "activeOrganizationId")
         VALUES ($1, now() + interval '1 hour', $1, now(), 'user_v5', $2)`,
        [s1, orgId],
      );
      await root.query(
        `INSERT INTO public."session" (id, "expiresAt", token, "updatedAt", "userId", "activeTeamId")
         VALUES ($1, now() + interval '1 hour', $1, now(), 'user_v5', $2)`,
        [s2, teamId],
      );

      await simulateArchiveTransition(db, { schema, orgId, to: "archived" });

      // The archive tx's two session clears (verbatim shapes) — the guard
      // trigger only fires on NON-NULL values, so the NULL-clearing cleanup
      // class passes even though the org is already archived at this point
      // (exactly the in-tx ordering: archivedAt is set BEFORE the clears).
      await root.query(
        `UPDATE public."session" SET "activeOrganizationId" = NULL
         WHERE "activeOrganizationId" = $1`,
        [orgId],
      );
      await root.query(
        `UPDATE public."session" SET "activeTeamId" = NULL
         WHERE "activeTeamId" IN (SELECT id FROM public."team" WHERE "organizationId" = $1)`,
        [orgId],
      );
      const cleared = await root.query(
        `SELECT id FROM public."session"
         WHERE "activeOrganizationId" = $1
            OR "activeTeamId" IN (SELECT id FROM public."team" WHERE "organizationId" = $1)`,
        [orgId],
      );
      expect((cleared as { rows: unknown[] }).rows).toHaveLength(0);

      // Positive control: the SAME guard now BLOCKS any re-point at the
      // archived org — directly, or via one of its teams.
      await expect(
        root.query(
          `UPDATE public."session" SET "activeOrganizationId" = $2 WHERE id = $1`,
          [s1, orgId],
        ),
      ).rejects.toThrow(/organization-archived/);
      await expect(
        root.query(
          `UPDATE public."session" SET "activeTeamId" = $2 WHERE id = $1`,
          [s2, teamId],
        ),
      ).rejects.toThrow(/team-organization-archived/);
    } finally {
      await root.query(`DELETE FROM public."session" WHERE id IN ($1, $2)`, [s1, s2]);
      await root.query(`DELETE FROM public."team" WHERE id = $1`, [teamId]);
      await root.query(`DELETE FROM public."user" WHERE id = $1`, ["user_v5"]);
      await dropOrg();
    }
  });

  it("V5 total freeze + epoch-keyed leases: a LIVE run gets a lease at the NEW epoch, a PARKED run gets none and stays byte-untouched; unarchive invalidates the superseded epoch (Decision 11 default (A) + Decision 2b)", async () => {
    const liveRun = `run_live_${randomUUID().slice(0, 8)}`;
    const parkedRun = `run_parked_${randomUUID().slice(0, 8)}`;
    const attemptId = `att_${randomUUID().slice(0, 8)}`;
    try {
      // A LIVE attempt (running, current attempt id, unexpired deadline) and
      // a PARKED pre-dispatch run (queued, no attempt id — the kernel
      // live-attempt predicate rejects it).
      await root.query(
        `INSERT INTO "${schema}"."agent_runs"
           (id, template_id, status, input_params, org_id, execution_attempt_id, execution_deadline_at)
         VALUES ($1, 'tpl_v5', 'running', '{}', $2, $3, now() + interval '1 hour')`,
        [liveRun, orgId, attemptId],
      );
      await root.query(
        `INSERT INTO "${schema}"."agent_runs"
           (id, template_id, status, input_params, org_id)
         VALUES ($1, 'tpl_v5', 'queued', '{}', $2)`,
        [parkedRun, orgId],
      );

      const { archiveEpoch } = await simulateArchiveTransition(db, {
        schema,
        orgId,
        to: "archived",
      });
      expect(archiveEpoch).toBe(1);

      const leases = await root.query(
        `SELECT run_id, archive_epoch FROM "${schema}"."org_archive_lease" WHERE org_id = $1`,
        [orgId],
      );
      const leaseRows = (leases as { rows: { run_id: string; archive_epoch: number }[] }).rows;
      expect(leaseRows).toHaveLength(1);
      expect(leaseRows[0].run_id).toBe(liveRun);
      expect(Number(leaseRows[0].archive_epoch)).toBe(1);

      // TOTAL FREEZE (owner-ruled total freeze): the parked run was not stopped,
      // settled, or otherwise touched by the transition.
      const parked = await root.query(
        `SELECT status, execution_attempt_id FROM "${schema}"."agent_runs" WHERE id = $1`,
        [parkedRun],
      );
      const parkedRow = (parked as { rows: { status: string; execution_attempt_id: string | null }[] }).rows[0];
      expect(parkedRow.status).toBe("queued");
      expect(parkedRow.execution_attempt_id).toBeNull();

      // Unarchive (epoch 1 → 2): every lease of the superseded epoch dies.
      const unarchived = await simulateArchiveTransition(db, { schema, orgId, to: "active" });
      expect(unarchived.archiveEpoch).toBe(2);
      const after = await root.query(
        `SELECT run_id FROM "${schema}"."org_archive_lease" WHERE org_id = $1`,
        [orgId],
      );
      expect((after as { rows: unknown[] }).rows).toHaveLength(0);
    } finally {
      await root.query(`DELETE FROM "${schema}"."agent_runs" WHERE id IN ($1, $2)`, [
        liveRun,
        parkedRun,
      ]);
      await dropOrg();
    }
  });
});

// =============================================================================
// cinatra#1943 A4 — manifest row 12: "Direct BA-DML-vs-archive, both lock
// interleavings". Extends this file in place (this file's own established
// convention — see its header) rather than forking a parallel file: DESIGN.md
// Decision 4's sketch named a new file, but `.github/workflows/build-image.yml`'s
// `extension-lifecycle-db-tests` job invokes THIS file via an explicit
// per-file step (not a glob) — a new file would need its own CI-wiring step,
// which is a `.github/workflows/**` edit and therefore its OWN
// always-human-gated PR (Decision 6), never bundled into a content PR.
// Extending the already-wired file avoids that coupling and keeps this row's
// proof genuinely CI-verified the moment it merges, no follow-up PR required.
//
// #1939 wave 3 Stage E (scripts/better-auth-migrate.mts,
// `ensureAuthFloorArchiveGuardTriggers`) added two DATABASE-LEVEL triggers —
// `cinatra_member_archive_guard` on public.member, `cinatra_invitation_
// archive_guard` on public.invitation — as the floor underneath BOTH the
// org-write kernel (the describe block above) and the app-layer Better-Auth
// dispatch policy (organization-dispatch-policy.ts): a write that reaches
// these tables by ANY path — including one that bypasses both of those
// layers entirely (a script, a future direct-SQL caller, a library upgrade) —
// still cannot grow access into an archived organization. Stage E's own test
// (src/lib/__tests__/better-auth-migrate-auth-floor-guard.test.ts) pins the
// SQL's shape against a SCRIPTED FAKE pg pool — it never proves the trigger
// actually fires and blocks against REAL, CONCURRENT Postgres connections.
// That is what this section proves, against the real trigger, provisioned
// for real via `ensureAuthFloorArchiveGuardTriggers` (idempotent OR-REPLACE —
// safe to call again even if a prior job step already ran it).
//
// "Both lock interleavings" (the literal issue-body / manifest wording) means
// the two orderings a direct writer and a concurrent archive transition can
// race in, at the level of REAL POSTGRES ROW LOCKS (not the kernel's advisory
// locks above, which this trigger has no relationship to):
//   - the direct write's guard-triggered `FOR SHARE OF o NOWAIT` read wins the
//     org row first (still active) and holds it open in an uncommitted
//     transaction; the archive's plain UPDATE of `archivedAt` needs a
//     conflicting row lock and genuinely BLOCKS (no NOWAIT on that side)
//     until the write commits — the write lands, archive commits after;
//   - the archive's UPDATE wins the row lock first (open, uncommitted); the
//     direct write's `FOR SHARE ... NOWAIT` immediately fails with Postgres
//     55P03 (lock_not_available) the instant it tries to acquire a
//     conflicting lock — the write never lands, regardless of whether the
//     archive has committed yet.
// A sequential (non-concurrent) baseline for both guarded tables is proven
// first — the trivial ordering where the org is already fully archived
// before the direct write is attempted.
// =============================================================================

describe.skipIf(!enabled)(
  "BA-DML-vs-archive race — the auth-floor triggers on live Postgres (cinatra#1943 A4, manifest row 12)",
  () => {
    let root: Client;
    let pool: Pool;
    let orgId: string;
    let userId: string;
    let userId2: string;

    beforeAll(async () => {
      root = new Client({ connectionString: dbUrl });
      await root.connect();
      // Idempotent (IF NOT EXISTS / guarded DO blocks) — safe even if the
      // describe block above already applied it in this same run.
      await root.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));
      pool = new Pool({ connectionString: dbUrl });
      // Provisions BOTH triggers for real (member + invitation) — idempotent
      // OR-REPLACE, so calling it here is safe regardless of whether some
      // other step in this CI job already ran it.
      const result = await ensureAuthFloorArchiveGuardTriggers(pool);
      if (result.skipped) {
        throw new Error(
          `ensureAuthFloorArchiveGuardTriggers skipped (${result.skipped}) — the public schema fixture must provision member/invitation/organization before this suite runs`,
        );
      }
    });

    afterAll(async () => {
      await pool?.end();
      await root?.end();
    });

    beforeEach(async () => {
      orgId = `org_badml_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      userId = `user_badml_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      userId2 = `user_badml2_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await root.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
        [orgId, "BA-DML Race", orgId],
      );
      await root.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)`,
        [userId, "BA-DML Test User", `${userId}@example.test`],
      );
      await root.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)`,
        [userId2, "BA-DML Test User 2", `${userId2}@example.test`],
      );
    });

    async function dropFixtures(): Promise<void> {
      // ON DELETE CASCADE on member/invitation's organizationId+userId/
      // inviterId FKs removes any rows this suite planted for this org/user.
      await root.query(`DELETE FROM public."organization" WHERE id = $1`, [orgId]);
      await root.query(`DELETE FROM public."user" WHERE id = $1`, [userId]);
      await root.query(`DELETE FROM public."user" WHERE id = $1`, [userId2]);
    }

    async function archiveNow(): Promise<void> {
      await root.query(
        `UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1`,
        [orgId],
      );
    }

    // -------------------------------------------------------------------
    // Sequential baseline (no concurrency): the org is fully archived
    // BEFORE the direct write is attempted — the trivial ordering.
    // -------------------------------------------------------------------

    it("member: a direct INSERT succeeds while active; once archived, BOTH a fresh INSERT and a role-elevation UPDATE on the existing row are refused (organization-archived)", async () => {
      try {
        const memberId = `member_${randomUUID().slice(0, 8)}`;
        await root.query(
          `INSERT INTO public."member" (id, "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())`,
          [memberId, orgId, userId, "member"],
        );

        await archiveNow();

        await expect(
          root.query(`UPDATE public."member" SET "role" = 'admin' WHERE id = $1`, [memberId]),
        ).rejects.toThrow(/cinatra-member-archive-guard: organization-archived/);

        const secondMemberId = `member_${randomUUID().slice(0, 8)}`;
        await expect(
          root.query(
            `INSERT INTO public."member" (id, "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())`,
            [secondMemberId, orgId, userId2, "member"],
          ),
        ).rejects.toThrow(/cinatra-member-archive-guard: organization-archived/);
      } finally {
        await dropFixtures();
      }
    });

    it("invitation: accepting a pending invitation is refused once archived, but rejecting/canceling it (the narrow cleanup capability) still succeeds", async () => {
      try {
        const invitationId = `invite_${randomUUID().slice(0, 8)}`;
        await root.query(
          `INSERT INTO public."invitation" (id, "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId")
             VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 hour', now(), $5)`,
          [invitationId, orgId, "invitee@example.test", "member", userId],
        );

        await archiveNow();

        await expect(
          root.query(`UPDATE public."invitation" SET "status" = 'accepted' WHERE id = $1`, [invitationId]),
        ).rejects.toThrow(/cinatra-invitation-archive-guard: organization-archived/);

        const secondInvitationId = `invite_${randomUUID().slice(0, 8)}`;
        await expect(
          root.query(
            `INSERT INTO public."invitation" (id, "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId")
               VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 hour', now(), $5)`,
            [secondInvitationId, orgId, "second-invitee@example.test", "member", userId],
          ),
        ).rejects.toThrow(/cinatra-invitation-archive-guard: organization-archived/);

        // Narrow cleanup capability (Stage E's own design note, live-proven
        // here): declining a pending invite into an archived org is never
        // blocked — the guard only ever refuses a write that GROWS access.
        await expect(
          root.query(`UPDATE public."invitation" SET "status" = 'rejected' WHERE id = $1`, [invitationId]),
        ).resolves.toBeTruthy();
      } finally {
        await dropFixtures();
      }
    });

    // -------------------------------------------------------------------
    // Both lock interleavings — real, concurrent Postgres connections, no
    // timing sleeps driving correctness (bounded confirmation via a race
    // against a deadline, the same convention the describe block above
    // uses for its own two-connection races).
    // -------------------------------------------------------------------

    it("interleaving 1 — a queued member INSERT holds the org row's FOR SHARE lock first (org still active): the archive UPDATE genuinely BLOCKS behind it, and only lands after the insert commits", async () => {
      const dmlConn = new Client({ connectionString: dbUrl });
      const archiverConn = new Client({ connectionString: dbUrl });
      await dmlConn.connect();
      await archiverConn.connect();
      const memberId = `member_${randomUUID().slice(0, 8)}`;
      try {
        await dmlConn.query("BEGIN");
        // Org is still active — the trigger's FOR SHARE OF o NOWAIT read
        // succeeds and the row lock is HELD (uncommitted) for the rest of
        // this test's setup.
        await dmlConn.query(
          `INSERT INTO public."member" (id, "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())`,
          [memberId, orgId, userId, "member"],
        );

        let archiveSettled = false;
        const archivePromise = archiverConn
          .query(
            `UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1`,
            [orgId],
          )
          .then((r) => {
            archiveSettled = true;
            return r;
          });

        const raced = await Promise.race([
          archivePromise.then(() => "archive-settled" as const, () => "archive-settled" as const),
          new Promise<"archive-blocked">((r) => setTimeout(() => r("archive-blocked"), 300)),
        ]);
        expect(raced).toBe("archive-blocked");
        expect(archiveSettled).toBe(false);

        // Release the FOR SHARE hold — the archive's UPDATE can now acquire
        // its row lock and complete.
        await dmlConn.query("COMMIT");
        await archivePromise;
        expect(archiveSettled).toBe(true);

        // The queued write landed (it started while active); the org is now
        // archived — both true, no torn state.
        const memberCheck = await root.query(`SELECT 1 FROM public."member" WHERE id = $1`, [memberId]);
        expect(memberCheck.rowCount).toBe(1);
        const orgCheck = await root.query<{ archivedAt: Date | null }>(
          `SELECT "archivedAt" FROM public."organization" WHERE id = $1`,
          [orgId],
        );
        expect(orgCheck.rows[0]?.archivedAt).not.toBeNull();
      } finally {
        await dmlConn.end();
        await archiverConn.end();
        await dropFixtures();
      }
    });

    it("interleaving 2 — an in-flight (uncommitted) archive UPDATE holds the org row lock first: a concurrent member INSERT's FOR SHARE...NOWAIT fails IMMEDIATELY (55P03), never landing a row into what becomes an archived org", async () => {
      const archiverConn = new Client({ connectionString: dbUrl });
      const writerConn = new Client({ connectionString: dbUrl });
      await archiverConn.connect();
      await writerConn.connect();
      const memberId = `member_${randomUUID().slice(0, 8)}`;
      try {
        await archiverConn.query("BEGIN");
        // The archive's row lock is now held, uncommitted.
        await archiverConn.query(
          `UPDATE public."organization" SET "archivedAt" = now(), "archiveEpoch" = COALESCE("archiveEpoch", 0) + 1 WHERE id = $1`,
          [orgId],
        );

        let caught: unknown;
        try {
          await writerConn.query(
            `INSERT INTO public."member" (id, "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())`,
            [memberId, orgId, userId, "member"],
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        // 55P03 = lock_not_available — the trigger's OWN FOR SHARE ... NOWAIT
        // read never even reaches its archived-state check; it fails on lock
        // acquisition alone, a DISTINCT failure mode from the custom
        // "organization-archived" RAISE EXCEPTION the sequential baseline
        // above asserts (that one requires the archive to have COMMITTED
        // first; this one fires while it is still in flight).
        expect((caught as { code?: string }).code).toBe("55P03");

        await archiverConn.query("COMMIT");

        const memberCheck = await root.query(`SELECT 1 FROM public."member" WHERE id = $1`, [memberId]);
        expect(memberCheck.rowCount).toBe(0);
        const orgCheck = await root.query<{ archivedAt: Date | null }>(
          `SELECT "archivedAt" FROM public."organization" WHERE id = $1`,
          [orgId],
        );
        expect(orgCheck.rows[0]?.archivedAt).not.toBeNull();
      } finally {
        await archiverConn.end();
        await writerConn.end();
        await dropFixtures();
      }
    });
  },
);

// =============================================================================
// cinatra#1943 A6 — manifest row 14 (BOUNDED, deterministic
// eventual-successful-archive under contention), the E2E SUBPROOF. The
// kernel-level subproof (the first describe block in this file) already
// proves the bounded-deadline ACQUISITION PATTERN against
// `guardOrgLifecycleMutation` directly. This block proves the SAME criterion
// against the REAL PRODUCT ENTRY POINT — src/lib/organization-archive.ts's
// `archiveOrganization` — including its owner-ruled explicit `lock_timeout`
// + bounded-retry-with-backoff wrapper (Decision 8's revised recommendation,
// landed with #1942 V5). Per Decision 1's AND-of-subproofs rule this is the
// piece that flips manifest row 14 from red to green: a kernel stand-in
// passing is not enough once the issue's own language implies
// live/product-level behavior.
//
// Deliberately does NOT re-prove the retry wrapper's internal MECHANICS
// (exact attempt counts against injected 55P03s) — that is already pinned
// against a fake db in src/lib/__tests__/organization-archive-tx.test.ts.
// This suite proves the OUTCOME against REAL, CONCURRENT Postgres: bounded
// wall-clock behavior under genuine contention, a typed non-hanging failure
// when contention outlasts the retry budget, and — the criterion's other
// half — that the SAME org archives successfully the moment contention
// clears.
//
// Own describe block (own root/pool/beforeAll/afterAll/beforeEach), same
// shape as the "BA-DML-vs-archive" block above, rather than reusing the
// first block's isolated `schema`: this suite needs `process.env.
// SUPABASE_SCHEMA` pointed at its OWN isolated schema (which carries the
// org_archive_lease table the archive tx's in-fence lease snapshot writes
// into) — `archiveOrganization`'s schema resolution (`appSchema()`) re-reads
// the env var on every call, so setting it in this block's `beforeAll` and
// restoring it in `afterAll` keeps the other blocks unaffected. The
// activation gate is seeded ON via the alias-stub seam (see the seam comment
// at the top of this file for why the root vitest alias makes that the only
// honest — and the only concurrency-safe — option here).
// =============================================================================

describe.skipIf(!enabled)(
  "archiveOrganization under real contention — the e2e subproof for the bounded-contention criterion (cinatra#1943 A6, manifest row 14)",
  () => {
    let root: Client;
    let pool: Pool;
    let db: OrgWriteDb<OrgWriteTx>;
    let schema: string;
    let orgId: string;
    let ownerId: string;
    let previousSupabaseSchema: string | undefined;

    beforeAll(async () => {
      root = new Client({ connectionString: dbUrl });
      await root.connect();
      await root.query(readFileSync(PUBLIC_SCHEMA_SQL, "utf8"));
      schema = `cinatra_test_a6_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
      await root.query(`CREATE SCHEMA "${schema}"`);
      await applyStoreDdl(root, schema);
      pool = new Pool({ connectionString: dbUrl });
      db = drizzle(pool) as unknown as OrgWriteDb<OrgWriteTx>;

      previousSupabaseSchema = process.env.SUPABASE_SCHEMA;
      process.env.SUPABASE_SCHEMA = schema;

      // Flip the activation gate ON through the alias-stub seam's write —
      // see the seam comment at the top of the file: the root vitest alias
      // makes the real connector-config store structurally unreachable here,
      // for this test AND for `archiveOrganization`'s own gate read, so both
      // sides share the ONE stub module (no vi.mock in the loop — the
      // concurrency lesson of rounds 1-3). NEVER the production closeout
      // path; the real write path's own semantics are pinned by the staging
      // flip script's tests.
      writeConnectorConfigSeam(ORG_ARCHIVE_ACTIVATION_CONFIG_KEY, { enabled: true });
      // Sanity: read the gate back through the EXACT production path
      // archiveOrganization consults first (which also pre-warms its dynamic
      // import once, before any concurrent test body) — a broken seam fails
      // the whole block LOUDLY here, instead of surfacing as a confusing
      // per-call `activation-gate-off` refusal inside a contention test.
      expect(await isArchiveActivationEnabled()).toBe(true);
    });

    afterAll(async () => {
      // Guarded restore: assigning `undefined` to a process.env key stores
      // the literal STRING "undefined" (Node coerces), and appSchema()
      // re-reads the var per call — a later suite in this worker would then
      // resolve a bogus "undefined" schema. When the var was unset before
      // this suite, DELETE it instead of assigning.
      if (previousSupabaseSchema === undefined) {
        delete process.env.SUPABASE_SCHEMA;
      } else {
        process.env.SUPABASE_SCHEMA = previousSupabaseSchema;
      }
      // Seed the gate back OFF (the stub's map has no clear surface — an
      // explicit OFF write is equivalent hygiene for anything after us).
      writeConnectorConfigSeam(ORG_ARCHIVE_ACTIVATION_CONFIG_KEY, { enabled: false });
      // Release the REAL Better-Auth pool the production action queried
      // (same teardown as dashboard-actor-team-roles.integration.test.ts,
      // the existing root-vitest precedent for driving the real
      // betterAuthDb) so the worker exits cleanly.
      try {
        await betterAuthPool.end();
      } catch {
        /* pool may never have been created */
      }
      await pool?.end();
      if (root) {
        await root.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await root.end();
      }
    });

    beforeEach(async () => {
      orgId = `org_a6_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      ownerId = `user_a6_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await root.query(
        `INSERT INTO public."organization" (id, name, slug, "createdAt") VALUES ($1, $2, $3, now())`,
        [orgId, "A6 Contention", orgId],
      );
      await root.query(
        `INSERT INTO public."user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, false)`,
        [ownerId, "A6 Owner", `${ownerId}@example.test`],
      );
      await root.query(
        `INSERT INTO public."member" (id, "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, 'owner', now())`,
        [`member_${ownerId}`, orgId, ownerId],
      );
    });

    async function dropFixtures(): Promise<void> {
      await root.query(`DELETE FROM public."organization" WHERE id = $1`, [orgId]);
      await root.query(`DELETE FROM public."user" WHERE id = $1`, [ownerId]);
    }

    async function readOrgState(): Promise<{ archivedAt: Date | null; archiveEpoch: number }> {
      const res = await root.query<{ archivedAt: Date | null; archiveEpoch: number | string }>(
        `SELECT "archivedAt", COALESCE("archiveEpoch", 0) AS "archiveEpoch" FROM public."organization" WHERE id = $1`,
        [orgId],
      );
      const row = res.rows[0];
      return { archivedAt: row?.archivedAt ?? null, archiveEpoch: Number(row?.archiveEpoch ?? 0) };
    }

    it("concurrent archive attempts on a fresh org: exactly one call lands the real transition, every other call is an idempotent no-op, and the epoch bumps exactly once", async () => {
      try {
        const CONCURRENT_CALLERS = 5;
        const results = await Promise.all(
          Array.from({ length: CONCURRENT_CALLERS }, () => archiveOrganization(orgId, ownerId)),
        );

        // The expected contract, re-derived from the REAL implementation
        // end-to-end (not assumed): the kernel's capability table rules
        // org.lifecycle "allow" in BOTH lifecycle states
        // (ORG_WRITE_CAPABILITY_TABLE in packages/org-write-kernel/src/
        // capabilities.ts), and guardOrgLifecycleMutation adds no other
        // state-dependent pre-check — so every fence LOSER proceeds to the
        // FOR UPDATE pin, sees archivedAt already set, throws the internal
        // idempotency marker, and maps to {ok:true, idempotent:true}
        // (organization-archive.ts's mapTransitionError). Exactly one
        // caller — whichever wins the advisory fence — takes the real
        // transition. No call may refuse.
        //
        // SELF-EVIDENCING assertions (this suite cannot run outside CI, so
        // the vitest diff is the only diagnostic instrument): project every
        // result to its full outcome shape and assert on the projections —
        // a refusal appears in the diff WITH its reason and error string,
        // and a wrong winner/loser split prints the complete multiset,
        // never a bare "expected false to be true".
        const outcomes = results.map((r) =>
          r.ok
            ? { ok: true as const, idempotent: r.idempotent === true }
            : { ok: false as const, reason: r.reason, error: r.error ?? null },
        );
        const refusals = outcomes.filter((o) => !o.ok);
        const winners = outcomes.filter((o) => o.ok && o.idempotent === false);
        const idempotentNoOps = outcomes.filter((o) => o.ok && o.idempotent === true);
        expect(refusals).toEqual([]);
        expect(winners).toHaveLength(1);
        expect(idempotentNoOps).toHaveLength(CONCURRENT_CALLERS - 1);

        const state = await readOrgState();
        expect(state.archivedAt).not.toBeNull();
        expect(state.archiveEpoch).toBe(1);
      } finally {
        await dropFixtures();
      }
    });

    it("bounded contention against the REAL archiveOrganization action: a fixed, finite set of concurrent guarded writers never blocks it past a generous deadline, and it succeeds once they drain (Decision 8's two-phase criterion, e2e half)", async () => {
      try {
        const WRITER_COUNT = 4;
        const ITERATIONS_PER_WRITER = 3;
        const DEADLINE_MS = 10_000;

        // Resolves the first time ANY writer is actually inside its guarded
        // critical section — the fence request below is deliberately not
        // issued until this resolves, so real contention against the REAL
        // archiveOrganization action is guaranteed, not merely likely (same
        // discipline as the kernel-level subproof above).
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
                await new Promise((r) => setTimeout(r, 15));
              },
            );
          }
        }

        const writers = Array.from({ length: WRITER_COUNT }, () => writerCycle());
        await firstWriterEntered;

        // The REAL production entry point, default retry options (the
        // owner-ruled default: lock_timeout + bounded retry with backoff).
        // UNLIKE the kernel-level subproof above (whose fence callback flips
        // nothing), this REALLY ARCHIVES the org mid-window — so any writer
        // iteration landing AFTER the archive commits is REFUSED
        // capability-denied. That refusal is the program's own invariant
        // (the two-connection race above pins it), so the writer set is
        // gathered with allSettled and capability-denied is asserted below
        // as the ONLY tolerated writer failure — anything else (or an
        // unsettled promise past the deadline) still fails this test.
        const fencePromise = archiveOrganization(orgId, ownerId);
        const contentionSettled = Promise.allSettled([fencePromise, ...writers]);

        // Phase 1 (bounded): no ordering/fairness claim (PostgreSQL
        // documents no waiter-FIFO guarantee for advisory locks) — only
        // that the whole contention window resolves, one way or another,
        // inside a generous deadline.
        const raced = await Promise.race([
          contentionSettled.then(() => "settled" as const),
          new Promise<"deadline-exceeded">((resolve) =>
            setTimeout(() => resolve("deadline-exceeded"), DEADLINE_MS),
          ),
        ]);
        expect(raced).toBe("settled");

        // Phase 2 (eventual success): the REAL action actually SUCCEEDS once
        // the fixed, finite writer set drains — "bounded" alone would pass
        // even if the fence never got in. (`archiveOrganization` returns
        // result objects, never throws — a rejected fence outcome would be
        // a bug in its own right.)
        const [fenceOutcome, ...writerOutcomes] = await contentionSettled;
        expect(fenceOutcome.status).toBe("fulfilled");
        if (fenceOutcome.status === "fulfilled") {
          expect(fenceOutcome.value).toEqual({ ok: true });
        }
        for (const outcome of writerOutcomes) {
          if (outcome.status === "rejected") {
            expect(outcome.reason).toBeInstanceOf(OrgWriteRefusedError);
            expect((outcome.reason as OrgWriteRefusedError).reason).toBe("capability-denied");
          }
        }

        const state = await readOrgState();
        expect(state.archivedAt).not.toBeNull();
        expect(state.archiveEpoch).toBe(1);
      } finally {
        await dropFixtures();
      }
    });

    it("forced lock-exhaustion: every bounded attempt hits 55P03 under a continuously held fence → a typed busy error, never a hang and never a silent {ok:true} — then the SAME org archives successfully the instant contention clears (eventual success, the criterion's other half)", async () => {
      const holder = new Client({ connectionString: dbUrl });
      await holder.connect();
      try {
        // A second connection holds BOTH lifecycle locks continuously — a
        // sustained contender, forced deterministically (not a timing
        // guess) via the same harness the kernel-level races use.
        const hold = await holdOrgLocks(holder, { orgId, epoch: true });

        // Tight, test-only retry options — organization-archive.ts's own
        // public ArchiveLockRetryOptions knob (never a private constant),
        // the SAME shape V5's lock_timeout + bounded-retry-with-backoff
        // design exposes to a caller. This proves the OUTCOME (bounded and
        // typed) under a real, sustained lock hold; the exact DEFAULT
        // ceiling's attempt-by-attempt mechanics are already pinned against
        // a fake db in organization-archive-tx.test.ts.
        const started = Date.now();
        const result = await archiveOrganization(orgId, ownerId, {
          lockTimeoutMs: 200,
          maxAttempts: 3,
          backoffBaseMs: 20,
        });
        const elapsedMs = Date.now() - started;

        // toMatchObject (not a bare ok-boolean check) so a mismatch prints
        // the FULL received result — reason and error string included — in
        // the vitest diff (the same self-evidencing discipline as the
        // concurrent-attempts test above; CI is this suite's only
        // diagnostic instrument).
        expect(result).toMatchObject({ ok: false, reason: "error" });
        if (!result.ok) {
          expect(result.error).toMatch(/bounded attempts/);
        }
        // Bounded: the whole exhausted attempt sequence finishes well inside
        // one generous deadline — never an unbounded stall. (~3 * 200ms
        // lock_timeout + backoff in the worst case; budgeted generously so
        // this never flakes on a loaded CI runner.)
        expect(elapsedMs).toBeLessThan(5_000);

        // Never a silent success: the org is still genuinely active while
        // the holder keeps the fence.
        const duringHold = await readOrgState();
        expect(duringHold.archivedAt).toBeNull();
        expect(duringHold.archiveEpoch).toBe(0);

        // Contention clears.
        await hold.release();

        // Eventual success (Decision 8's Phase 2): the SAME org, the SAME
        // caller, now archives cleanly with the production default retry
        // options — proves the bounded failure above was genuinely about
        // contention, not a permanently broken path.
        const recovered = await archiveOrganization(orgId, ownerId);
        expect(recovered).toEqual({ ok: true });
        const after = await readOrgState();
        expect(after.archivedAt).not.toBeNull();
        expect(after.archiveEpoch).toBe(1);
      } finally {
        await holder.end();
        await dropFixtures();
      }
    });
  },
);
