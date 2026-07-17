/**
 * cinatra#1450 — durable publication-operation ledger, REAL-DB integration proof
 * (no mocks on the DB path). Guarded by `describe.skipIf(!HAS_REAL_DB)` like the
 * sibling artifact integration suites: CI without a reachable Postgres emits
 * zero failures and zero noise.
 *
 * ISOLATION (the #1430 object-content-snapshot suite's pattern): the schema is
 * provisioned FRESH per test file from the CANONICAL `buildCreateStoreSchemaQueries`
 * DDL — never the worktree's shared schema, never hand-rolled drift-prone DDL —
 * so the ledger's CAS/idempotency runs against the exact production constraints
 * (partial-unique idempotency index, state/attempt/generation CHECKs). Because
 * `postgresSchema` is a module-load const, every app module is dynamically
 * imported in `beforeAll` AFTER the env is set.
 *
 * Exercises the issue's acceptance criteria end-to-end against real DDL:
 *   - schedule pins a captured revision + locks; "publish now" is immediately due;
 *   - the representation-existence gate (cannot pin a revision that does not exist);
 *   - schedule→cancel→edit race — a stale-generation claim cannot publish;
 *   - idempotent retry / no double-publish — re-claim/re-succeed refused, the
 *     partial-unique index refuses a duplicate live/succeeded intent;
 *   - publish-failure leaves the operation `failed` with NO unlock (artifact stays
 *     locked); retry + reconcile re-arm within the attempt cap.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub lacking the named
// exports representation-store imports; provide the connection/schema primitives
// the ledger graph touches (the #1430 suite's pattern). Lazy factory: runs on
// first dynamic import inside beforeAll — after the env is set.
vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const TEST_SCHEMA = "cinatra_test_pub_ledger_1450";
const ORG = "org-pub-1450";
const DEST = { connector: "@cinatra-ai/linkedin-connector", account: "acct-1", ref: null };

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let ledger: typeof import("@/lib/artifacts/publication-ledger");
let portMod: typeof import("@/lib/artifacts/publication-status-port");
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;

const S = () => TEST_SCHEMA;
function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Seed a real representation revision (the pin target) so schedule's
 * existence gate passes. Append-only trigger permits INSERT. */
function seedRepresentation(artifactId: string): string {
  const revId = nextId("rep-rev");
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1, $2, $3, $4, 1, 'file')`,
    [revId, ORG, artifactId, nextId("res")],
  );
  return revId;
}

function freshArtifact() {
  const artifactId = nextId("art");
  const revisionId = seedRepresentation(artifactId);
  return { artifactId, revisionId, objectTypeId: "@cinatra-ai/linkedin:post-draft" };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  ledger = await import("@/lib/artifacts/publication-ledger");
  portMod = await import("@/lib/artifacts/publication-status-port");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("publication-operation ledger (real DB + constraints)", () => {
  it("schedule 'publish now' pins the revision, is immediately due, and locks the artifact", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const port = new portMod.RecordingPublicationStatusPort();
    const { operation, deduplicated } = await ledger.schedulePublication(
      { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST },
      port,
    );
    expect(deduplicated).toBe(false);
    expect(operation.state).toBe("pending");
    expect(operation.attempt).toBe(0);
    expect(operation.cancellationGeneration).toBe(0);
    expect(operation.pinnedRepresentationRevisionId).toBe(revisionId);
    expect(operation.idempotencyKey).toMatch(/^pubop_/);
    // Immediately due.
    expect(new Date(operation.dueAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // Trusted command: the artifact was locked exactly once.
    expect(port.effects()).toEqual(["lock"]);
  });

  it("refuses to pin a representation revision that does not exist", async () => {
    const artifactId = nextId("art-missing");
    await expect(
      ledger.schedulePublication({
        orgId: ORG,
        artifactId,
        objectTypeId: "@cinatra-ai/linkedin:post-draft",
        pinnedRepresentationRevisionId: "rep-rev-does-not-exist",
        destination: DEST,
      }),
    ).rejects.toThrow(/representation capture must exist/);
  });

  it("refuses to pin a revision belonging to a different artifact", async () => {
    const a = freshArtifact();
    const b = freshArtifact();
    await expect(
      ledger.schedulePublication({
        orgId: ORG,
        artifactId: b.artifactId,
        objectTypeId: b.objectTypeId,
        pinnedRepresentationRevisionId: a.revisionId, // belongs to a, not b
        destination: DEST,
      }),
    ).rejects.toThrow(/belongs to artifact/);
  });

  it("deduplicates a duplicate schedule of the same intent (no second lock)", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const base = { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST };
    const first = await ledger.schedulePublication(base);
    const port = new portMod.RecordingPublicationStatusPort();
    const second = await ledger.schedulePublication(base, port);
    expect(second.deduplicated).toBe(true);
    expect(second.operation.id).toBe(first.operation.id);
    expect(port.effects()).toEqual([]); // no re-lock on a dedupe hit
  });

  it("claims a due op once; a running op cannot be re-claimed", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const { operation } = await ledger.schedulePublication({
      orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST,
    });
    const claimed = await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    expect(claimed?.state).toBe("running");
    expect(claimed?.attempt).toBe(1);
    expect(claimed?.startedAt).not.toBeNull();
    // Second claim finds it running, not pending → null.
    const again = await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    expect(again).toBeNull();
  });

  it("does not claim a not-yet-due op", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const future = new Date(Date.now() + 3_600_000);
    const { operation } = await ledger.schedulePublication({
      orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST, dueAt: future,
    });
    const claimed = await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    expect(claimed).toBeNull();
  });

  it("AC: schedule → cancel → edit — the stale delivery is fenced and cannot publish", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const port = new portMod.RecordingPublicationStatusPort();
    const { operation } = await ledger.schedulePublication(
      { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST },
      port,
    );
    // Unschedule before delivery: generation advances, the artifact unlocks.
    const cancelled = await ledger.cancelPublication({ orgId: ORG, operationId: operation.id }, port);
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.cancellationGeneration).toBe(1);
    expect(port.effects()).toEqual(["lock", "unlock"]);

    // A stale delivery job carrying (op, generation 0) can neither claim nor settle.
    expect(await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 })).toBeNull();
    expect(
      await ledger.settlePublicationSucceeded({
        orgId: ORG, operationId: operation.id, expectedGeneration: 0, receipt: { externalId: "should-not-happen" },
      }),
    ).toBeNull();
  });

  it("AC: idempotent success — no double-publish; the succeeded intent refuses a re-schedule", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const port = new portMod.RecordingPublicationStatusPort();
    const base = { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST };
    const { operation } = await ledger.schedulePublication(base, port);
    await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    const receipt = { externalId: "urn:li:post:123", url: "https://linkedin.com/p/123" };
    const ok = await ledger.settlePublicationSucceeded(
      { orgId: ORG, operationId: operation.id, expectedGeneration: 0, receipt }, port,
    );
    expect(ok?.state).toBe("succeeded");
    expect(ok?.receipt).toEqual(receipt);
    expect(port.effects()).toEqual(["lock", "publish"]);

    // A second success is refused (no double-publish).
    const twice = await ledger.settlePublicationSucceeded(
      { orgId: ORG, operationId: operation.id, expectedGeneration: 0, receipt }, port,
    );
    expect(twice).toBeNull();

    // Re-scheduling the identical succeeded intent is refused by the partial-unique backstop.
    const reschedule = await ledger.schedulePublication(base);
    expect(reschedule.deduplicated).toBe(true);
    expect(reschedule.operation.id).toBe(operation.id);
    expect(reschedule.operation.state).toBe("succeeded");
  });

  it("AC: publish-failure leaves the artifact LOCKED (op failed, no unlock); retry + cancel recover", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const port = new portMod.RecordingPublicationStatusPort();
    const { operation } = await ledger.schedulePublication(
      { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST }, port,
    );
    await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    const failed = await ledger.settlePublicationFailed({
      orgId: ORG, operationId: operation.id, expectedGeneration: 0, error: "connector 503",
    });
    expect(failed?.state).toBe("failed");
    expect(failed?.error).toBe("connector 503");
    // Crucially: NO unlock — the artifact stays locked with the operation failed.
    expect(port.effects()).toEqual(["lock"]);

    // Retry re-arms without changing the generation (same idempotency key).
    const retried = await ledger.retryFailedPublication({ orgId: ORG, operationId: operation.id });
    expect(retried?.state).toBe("pending");
    expect(retried?.cancellationGeneration).toBe(0);
    expect(retried?.idempotencyKey).toBe(operation.idempotencyKey);

    // Fail again, then abandon via cancel → unlock (recover for editing).
    await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    await ledger.settlePublicationFailed({ orgId: ORG, operationId: operation.id, expectedGeneration: 0, error: "again" });
    const abandoned = await ledger.cancelPublication({ orgId: ORG, operationId: operation.id }, port);
    expect(abandoned?.state).toBe("cancelled");
    expect(port.effects()).toEqual(["lock", "unlock"]);
  });

  it("re-schedules the same intent after a cancel (the slot is freed)", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const base = { orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST };
    const first = await ledger.schedulePublication(base);
    await ledger.cancelPublication({ orgId: ORG, operationId: first.operation.id });
    const second = await ledger.schedulePublication(base);
    expect(second.deduplicated).toBe(false);
    expect(second.operation.id).not.toBe(first.operation.id);
    expect(second.operation.state).toBe("pending");
  });

  it("reconcile re-arms a timed-out running op, and fails it once attempts are exhausted", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const { operation } = await ledger.schedulePublication({
      orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST,
    });
    await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    // lease 0 ⇒ every running op is stale; attempts remain (1 < 5) ⇒ re-armed.
    const r1 = await ledger.reconcileStalePublications({ leaseMs: 0, maxAttempts: 5, orgId: ORG });
    expect(r1.reArmed).toBeGreaterThanOrEqual(1);
    expect(ledger.getPublicationOperation(ORG, operation.id)?.state).toBe("pending");
    // Claim again (attempt → 2), then reconcile with maxAttempts 1 ⇒ exhausted ⇒ failed.
    await ledger.claimDueOperation({ orgId: ORG, operationId: operation.id, expectedGeneration: 0 });
    const r2 = await ledger.reconcileStalePublications({ leaseMs: 0, maxAttempts: 1, orgId: ORG });
    expect(r2.failed).toBeGreaterThanOrEqual(1);
    expect(ledger.getPublicationOperation(ORG, operation.id)?.state).toBe("failed");
  });

  it("lists due operations and an artifact's operations", async () => {
    const { artifactId, revisionId, objectTypeId } = freshArtifact();
    const { operation } = await ledger.schedulePublication({
      orgId: ORG, artifactId, objectTypeId, pinnedRepresentationRevisionId: revisionId, destination: DEST,
    });
    const due = ledger.listDuePublicationOperations({ orgId: ORG, limit: 500 });
    expect(due.some((o) => o.id === operation.id)).toBe(true);
    const forArtifact = ledger.listPublicationOperationsForArtifact(ORG, artifactId);
    expect(forArtifact.map((o) => o.id)).toContain(operation.id);
  });
});
