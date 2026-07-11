/**
 * Live-Postgres integration tests for the dynamic-dispatch primitive storage
 * (cinatra#1032 deliverable 2): the project lease's atomic acquire /
 * steal-after-expiry / heartbeat-fencing semantics and the LEASE-FENCED
 * write-ahead dispatch-attempt ledger claim + optimistic-CAS settle.
 *
 * These are the load-bearing single-statement atomics the pure unit tests
 * cannot prove: the conditional-upsert acquire (no read-modify-write window),
 * the INSERT…SELECT lease fence (a stale holder's claim NEVER lands), and the
 * CAS settle read-back (identical settle accepted, different settle refused).
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches
 * agent-run-idempotency.integration.test.ts).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

beforeAll(async () => {
  if (!hasDb) return;
  // Defensive: ensure the two tables exist (mirrors the projectDispatchSchemaQueries
  // bootstrap leaf in src/lib/extension-grant-schema.ts; idempotent — safe on
  // an already-migrated schema).
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`CREATE TABLE IF NOT EXISTS "${q(SCHEMA)}"."project_dispatch_attempts" (
    id text PRIMARY KEY,
    org_id text NOT NULL,
    project_ref text NOT NULL,
    item_natural_key text NOT NULL,
    action_version integer NOT NULL,
    worker_role text NOT NULL,
    worker_package text NOT NULL,
    worker_version_constraint text NOT NULL,
    idempotency_key text NOT NULL,
    run_id text,
    status text NOT NULL DEFAULT 'pending',
    error text,
    version integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_dispatch_attempts_status_check
      CHECK (status IN ('pending', 'dispatched', 'failed')),
    CONSTRAINT project_dispatch_attempts_action_version_check
      CHECK (action_version >= 0)
  )`);
  await c.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS project_dispatch_attempts_item_action_uniq ON "${q(SCHEMA)}"."project_dispatch_attempts" (org_id, item_natural_key, action_version)`,
  );
  await c.query(`CREATE TABLE IF NOT EXISTS "${q(SCHEMA)}"."project_leases" (
    org_id text NOT NULL,
    project_ref text NOT NULL,
    holder_id text NOT NULL,
    acquired_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    version integer NOT NULL DEFAULT 1,
    PRIMARY KEY (org_id, project_ref)
  )`);
  await c.end();
}, 30_000);

const ORG = "org-int-1032";
const freshRef = () => `proj-${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.runIf(hasDb)("project lease (live DB)", () => {
  it("acquires fresh at version 1 and denies a live second holder", async () => {
    const { acquireProjectLease } = await import("../project-lease-store");
    const projectRef = freshRef();
    const a = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", ttlMs: 60_000 });
    expect(a).toMatchObject({ holderId: "tick-A", version: 1 });
    const b = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-B", ttlMs: 60_000 });
    expect(b).toBeNull();
  });

  it("refreshes for the SAME holder (version bumps — a new fencing token)", async () => {
    const { acquireProjectLease } = await import("../project-lease-store");
    const projectRef = freshRef();
    const a = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", ttlMs: 60_000 });
    const again = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", ttlMs: 60_000 });
    expect(again?.version).toBe((a?.version ?? 0) + 1);
  });

  it("recovers a stale lease: a crashed holder's expired lease is stolen with a bumped fencing version", async () => {
    const { acquireProjectLease } = await import("../project-lease-store");
    const projectRef = freshRef();
    const a = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-crashed", ttlMs: 50 });
    expect(a?.version).toBe(1);
    await sleep(120); // let it expire (no heartbeat — the "crash")
    const thief = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-next", ttlMs: 60_000 });
    expect(thief).toMatchObject({ holderId: "tick-next", version: 2 });
  });

  it("heartbeat extends only for the live holder at the SAME fencing version", async () => {
    const { acquireProjectLease, heartbeatProjectLease } = await import("../project-lease-store");
    const projectRef = freshRef();
    const a = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", ttlMs: 60_000 });
    expect(
      await heartbeatProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", version: a!.version, ttlMs: 60_000 }),
    ).toBe(true);
    // Stale fencing version (a prior incarnation) is refused.
    expect(
      await heartbeatProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", version: a!.version - 1, ttlMs: 60_000 }),
    ).toBe(false);
    // A non-holder is refused.
    expect(
      await heartbeatProjectLease({ orgId: ORG, projectRef, holderId: "tick-B", version: a!.version, ttlMs: 60_000 }),
    ).toBe(false);
  });

  it("release expires the lease in place; the next acquire recovers it", async () => {
    const { acquireProjectLease, releaseProjectLease } = await import("../project-lease-store");
    const projectRef = freshRef();
    const a = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", ttlMs: 60_000 });
    expect(
      await releaseProjectLease({ orgId: ORG, projectRef, holderId: "tick-A", version: a!.version }),
    ).toBe(true);
    const b = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-B", ttlMs: 60_000 });
    expect(b).toMatchObject({ holderId: "tick-B", version: 2 });
  });
});

describe.runIf(hasDb)("dispatch-attempt ledger (live DB)", () => {
  async function held(projectRef: string, holderId = "tick-A") {
    const { acquireProjectLease } = await import("../project-lease-store");
    const lease = await acquireProjectLease({ orgId: ORG, projectRef, holderId, ttlMs: 60_000 });
    expect(lease).not.toBeNull();
    return { holderId, version: lease!.version };
  }

  it("lease-fenced claim: inserts under a live lease; a NON-holder's claim never lands", async () => {
    const { beginDispatchAttempt, deriveDispatchIdempotencyKey } = await import(
      "../project-dispatch-ledger-store"
    );
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const lease = await held(projectRef);

    const stale = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0",
      lease: { holderId: "tick-imposter", version: lease.version },
    });
    expect(stale).toEqual({ kind: "lease_not_held" });

    const wrongVersion = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0",
      lease: { holderId: lease.holderId, version: lease.version + 7 },
    });
    expect(wrongVersion).toEqual({ kind: "lease_not_held" });

    const ok = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0", lease,
    });
    expect(ok.kind).toBe("inserted");
    if (ok.kind === "inserted") {
      expect(ok.attempt.idempotencyKey).toBe(deriveDispatchIdempotencyKey(ORG, itemKey, 0));
      expect(ok.attempt.status).toBe("pending");
    }
  });

  it("re-begin converges on the EXISTING row (same idempotency key — the crash-recovery path)", async () => {
    const { beginDispatchAttempt } = await import("../project-dispatch-ledger-store");
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const lease = await held(projectRef);
    const args = {
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0", lease,
    };
    const first = await beginDispatchAttempt(args);
    const second = await beginDispatchAttempt(args);
    expect(first.kind).toBe("inserted");
    expect(second.kind).toBe("existing");
    if (first.kind === "inserted" && second.kind === "existing") {
      expect(second.attempt.id).toBe(first.attempt.id);
      expect(second.attempt.idempotencyKey).toBe(first.attempt.idempotencyKey);
    }
  });

  it("a stale holder cannot claim EVEN AFTER its lease was stolen (the TOCTOU fence)", async () => {
    const { acquireProjectLease } = await import("../project-lease-store");
    const { beginDispatchAttempt } = await import("../project-dispatch-ledger-store");
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const staleLease = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-old", ttlMs: 50 });
    await sleep(120);
    const newLease = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-new", ttlMs: 60_000 });
    expect(newLease?.version).toBe(2);
    // The crashed/stale holder wakes up and tries to claim with its old token.
    const claim = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0",
      lease: { holderId: "tick-old", version: staleLease!.version },
    });
    expect(claim).toEqual({ kind: "lease_not_held" });
  });

  it("serializes the claim against a CONCURRENT in-flight steal (FOR UPDATE lock-recheck, two transactions)", async () => {
    // The hard interleaving: the stale holder's claim starts while a steal
    // transaction holds the lease row lock but has NOT committed. Without the
    // claim's FOR UPDATE, the claim's MVCC snapshot would still see the stale
    // holder's version and the claim would land fenced against an
    // already-stolen lease. With FOR UPDATE the claim BLOCKS on the row lock,
    // re-evaluates the predicate against the post-steal row on commit, and
    // must come back lease_not_held.
    const { acquireProjectLease } = await import("../project-lease-store");
    const { beginDispatchAttempt, readDispatchAttempt } = await import(
      "../project-dispatch-ledger-store"
    );
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const stale = await acquireProjectLease({ orgId: ORG, projectRef, holderId: "tick-old", ttlMs: 60_000 });
    expect(stale?.version).toBe(1);

    // Open the steal in a SEPARATE, uncommitted transaction (row lock held).
    const stealer = new Client({ connectionString: dbUrl });
    await stealer.connect();
    await stealer.query("BEGIN");
    await stealer.query(
      `UPDATE "${q(SCHEMA)}"."project_leases"
          SET holder_id = 'tick-new', acquired_at = now(), heartbeat_at = now(),
              expires_at = now() + interval '60 seconds', version = version + 1
        WHERE org_id = $1 AND project_ref = $2`,
      [ORG, projectRef],
    );

    // Fire the stale holder's claim WHILE the steal is uncommitted; it must
    // block on the lease row lock rather than read the stale version.
    const claimPromise = beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0",
      lease: { holderId: "tick-old", version: stale!.version },
    });
    await sleep(150); // give the claim time to reach the lock wait
    await stealer.query("COMMIT");
    await stealer.end();

    const claim = await claimPromise;
    expect(claim).toEqual({ kind: "lease_not_held" });
    // And the ledger row must NOT exist — the stale claim never landed.
    expect(await readDispatchAttempt(ORG, itemKey, 0)).toBeNull();
  });

  it("CAS settle: settles once, accepts an IDENTICAL re-settle, refuses a different one", async () => {
    const { beginDispatchAttempt, settleDispatchAttempt } = await import(
      "../project-dispatch-ledger-store"
    );
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const lease = await held(projectRef);
    const begin = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0", lease,
    });
    expect(begin.kind).toBe("inserted");
    const attempt = (begin as { kind: "inserted"; attempt: { id: string; version: number } }).attempt;

    const settled = await settleDispatchAttempt({
      id: attempt.id, expectedVersion: attempt.version, status: "dispatched", runId: "run_X",
    });
    expect(settled.kind).toBe("settled");

    // An at-least-once recovery tick settling the SAME outcome is accepted…
    const identical = await settleDispatchAttempt({
      id: attempt.id, expectedVersion: attempt.version, status: "dispatched", runId: "run_X",
    });
    expect(identical.kind).toBe("settled");

    // …but a DIFFERENT outcome under a stale CAS version is a conflict.
    const different = await settleDispatchAttempt({
      id: attempt.id, expectedVersion: attempt.version, status: "failed", error: "boom",
    });
    expect(different.kind).toBe("conflict");
    if (different.kind === "conflict") {
      expect(different.attempt).toMatchObject({ status: "dispatched", runId: "run_X" });
    }

    // An ERROR-ONLY mismatch (same status + runId) is also a conflict — the
    // read-back compares the full normalized outcome, not just status/run.
    const errorOnly = await settleDispatchAttempt({
      id: attempt.id, expectedVersion: attempt.version, status: "dispatched", runId: "run_X",
      error: "late divergent error",
    });
    expect(errorOnly.kind).toBe("conflict");
  });

  it("distinct action versions are DISTINCT deliberate attempts (separate rows, separate keys)", async () => {
    const { beginDispatchAttempt } = await import("../project-dispatch-ledger-store");
    const projectRef = freshRef();
    const itemKey = `${projectRef}/draft`;
    const lease = await held(projectRef);
    const v0 = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 0,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0", lease,
    });
    const v1 = await beginDispatchAttempt({
      orgId: ORG, projectRef, itemNaturalKey: itemKey, actionVersion: 1,
      workerRole: "draft-writer", workerPackage: "@x/w", workerVersionConstraint: "exact:1.0.0", lease,
    });
    expect(v0.kind).toBe("inserted");
    expect(v1.kind).toBe("inserted");
    if (v0.kind === "inserted" && v1.kind === "inserted") {
      expect(v1.attempt.id).not.toBe(v0.attempt.id);
      expect(v1.attempt.idempotencyKey).not.toBe(v0.attempt.idempotencyKey);
    }
  });
});
